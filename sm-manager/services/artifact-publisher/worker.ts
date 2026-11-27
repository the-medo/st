/** Public output only. The R2 bucket and editable sources remain private. */
type StoredObject = { body: ReadableStream; json<T>(): Promise<T> };
export interface Bucket {
  get(key: string): Promise<StoredObject | null>;
  put(key: string, value: string | Uint8Array): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}
export interface Env {
  ARTIFACTS: Bucket;
  PUBLISH_KEY: string;
}
type Output = { path: string; mime: string; sha256: string; size: number };
type Share = {
  artifact_id: string;
  revision: number;
  entrypoint: string;
  files: Output[];
};
const validToken = /^[A-Za-z0-9_-]{32}$/;
const validPath = (path: unknown): path is string =>
  typeof path === "string" &&
  path.length > 0 &&
  path.length <= 512 &&
  !/[\\?#%\x00-\x1f]/.test(path) &&
  path.split("/").every((p) => p !== "" && p !== "." && p !== "..");
const policy =
  "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
async function authorized(request: Request, secret: string): Promise<boolean> {
  if (!secret || secret.length < 32) return false;
  const given = request.headers.get("authorization") ?? "";
  const hash = (value: string) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const [a, b] = await Promise.all([hash(given), hash("Bearer " + secret)]);
  const bytes = new Uint8Array(a),
    other = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < bytes.length; i++) difference |= bytes[i]! ^ other[i]!;
  return difference === 0;
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const upload = /^\/admin\/objects\/([a-f0-9]{64})$/.exec(url.pathname);
  if (upload) {
    if (!(await authorized(request, env.PUBLISH_KEY)))
      return json({ error: "Unauthorized" }, 401);
    if (request.method !== "PUT")
      return json({ error: "Method not allowed" }, 405);
    if (Number(request.headers.get("content-length") ?? 0) > 32 * 1024 * 1024)
      return json({ error: "Upload too large" }, 413);
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.length > 32 * 1024 * 1024)
      return json({ error: "Upload too large" }, 413);
    const hash = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", body)),
    ]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (hash !== upload[1])
      return json({ error: "File checksum mismatch" }, 400);
    const previous = await env.ARTIFACTS.get(`objects/${hash}`);
    if (previous) {
      await previous.body.cancel();
      return json({ uploaded: true });
    }
    await env.ARTIFACTS.put(`objects/${hash}`, body);
    return json({ uploaded: true });
  }
  const admin = /^\/admin\/shares\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (admin) {
    if (!(await authorized(request, env.PUBLISH_KEY)))
      return json({ error: "Unauthorized" }, 401);
    const token = admin[1]!;
    if (!validToken.test(token)) return json({ error: "Invalid share" }, 400);
    if (request.method === "DELETE") {
      await env.ARTIFACTS.delete(`shares/${token}.json`);
      return json({ revoked: true });
    }
    if (request.method !== "PUT")
      return json({ error: "Method not allowed" }, 405);
    if (Number(request.headers.get("content-length") ?? 0) > 1024 * 1024)
      return json({ error: "Upload too large" }, 413);
    let input: Share & { files: (Output & { role?: string })[] };
    try {
      input = (await request.json()) as typeof input;
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    if (
      !input ||
      !/^[a-f0-9]{32}$/.test(input.artifact_id) ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 1 ||
      !validPath(input.entrypoint) ||
      !Array.isArray(input.files) ||
      input.files.length < 1 ||
      input.files.length > 256
    )
      return json({ error: "Invalid artifact" }, 400);
    const paths = new Set<string>();
    const files: Output[] = [];
    let size = 0;
    for (const file of input.files) {
      if (
        !file ||
        !validPath(file.path) ||
        paths.has(file.path) ||
        file.role === "source" ||
        !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(file.mime) ||
        !/^[a-f0-9]{64}$/.test(file.sha256) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0
      )
        return json({ error: "Invalid output file" }, 400);
      size += file.size;
      if (size > 32 * 1024 * 1024)
        return json({ error: "Upload too large" }, 413);
      const uploaded = await env.ARTIFACTS.get(`objects/${file.sha256}`);
      if (!uploaded)
        return json(
          { error: "Upload every output file before publishing" },
          400,
        );
      await uploaded.body.cancel();
      paths.add(file.path);
      // Immutable content is written before the share pointer changes. No partial
      // upload can replace the last published revision.
      files.push({
        path: file.path,
        mime: file.mime,
        sha256: file.sha256,
        size: file.size,
      });
    }
    if (!paths.has(input.entrypoint))
      return json({ error: "Missing entrypoint" }, 400);
    const share: Share = {
      artifact_id: input.artifact_id,
      revision: input.revision,
      entrypoint: input.entrypoint,
      files,
    };
    await env.ARTIFACTS.put(`shares/${token}.json`, JSON.stringify(share));
    return json({ published: true, revision: share.revision });
  }
  if (request.method !== "GET" && request.method !== "HEAD")
    return json({ error: "Method not allowed" }, 405);
  const match = /^\/a\/([A-Za-z0-9_-]+)(?:\/(.*))?$/.exec(url.pathname);
  if (!match || !validToken.test(match[1]!))
    return json({ error: "Not found" }, 404);
  const token = match[1]!;
  const stored = await env.ARTIFACTS.get(`shares/${token}.json`);
  if (!stored) return json({ error: "This share is unavailable." }, 404);
  const share = await stored.json<Share>();
  if (match[2] === undefined || match[2] === "") {
    return new Response(null, {
      status: 302,
      headers: {
        Location: `/a/${token}/${share.entrypoint.split("/").map(encodeURIComponent).join("/")}`,
        "Cache-Control": "no-store",
      },
    });
  }
  let path: string;
  try {
    path = decodeURIComponent(match[2]);
  } catch {
    return json({ error: "Not found" }, 404);
  }
  if (!validPath(path)) return json({ error: "Not found" }, 404);
  const file = share.files.find((file) => file.path === path);
  if (!file) return json({ error: "Not found" }, 404);
  const object = await env.ARTIFACTS.get(`objects/${file.sha256}`);
  if (!object) return json({ error: "Not found" }, 404);
  const headers: Record<string, string> = {
    "Content-Type": file.mime,
    "Access-Control-Allow-Origin": "*",
    "Content-Length": String(file.size),
    // Every request rechecks the share pointer, including assets. Revoking access
    // cannot be bypassed through an unauthenticated object URL or an edge cache.
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Content-Security-Policy":
      file.mime === "application/pdf" ? "frame-ancestors 'none'" : policy,
  };
  if (
    url.searchParams.get("download") === "1" ||
    !/^(text\/(html|css|javascript)|application\/(pdf|javascript)|image\/|font\/|audio\/|video\/)/.test(
      file.mime,
    )
  )
    headers["Content-Disposition"] = "attachment";
  return new Response(request.method === "HEAD" ? null : object.body, {
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env) {
    try {
      return await handle(request, env);
    } catch {
      return json(
        { error: "The artifact service is temporarily unavailable." },
        503,
      );
    }
  },
};

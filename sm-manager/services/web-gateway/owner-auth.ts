import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type OwnerAuthConfig = { origin: string; sessionSecret: string };
const SESSION = "__Host-st_owner",
  NONCE = "__Host-st_login";
const lifetime = 30 * 86400;
const cookie = (name: string, value: string, age: number) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
function cookies(request: Request) {
  return new Map(
    (request.headers.get("cookie") ?? "").split(";").map((part) => {
      const index = part.indexOf("=");
      return [part.slice(0, index).trim(), part.slice(index + 1)];
    }),
  );
}
function same(a: string, b: string) {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function response(
  status: number,
  body: string | null,
  headers: Record<string, string> = {},
) {
  return new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      ...headers,
    },
  });
}

/** A one-use, nonce-bound handoff from the existing Tailscale Serve identity to the vanity domain. */
export function ownerAuth(
  publicOrigin: string,
  owner: string,
  config: OwnerAuthConfig,
) {
  const site = new URL(publicOrigin),
    identity = new URL(config.origin);
  if (
    site.protocol !== "https:" ||
    identity.protocol !== "https:" ||
    site.origin === identity.origin ||
    config.sessionSecret.length < 32 ||
    !owner
  )
    throw new Error(
      "Owner sign-in requires distinct HTTPS origins, an owner and a private signing secret",
    );
  const pending = new Map<
    string,
    { until: number; path: string; code?: string }
  >();
  const sign = (value: string) =>
    createHmac("sha256", config.sessionSecret)
      .update(value)
      .digest("base64url");
  const session = () => {
    const value = `${Math.floor(Date.now() / 1000) + lifetime}.${randomBytes(24).toString("base64url")}`;
    return `${value}.${sign(value)}`;
  };
  const valid = (request: Request) => {
    const value = cookies(request).get(SESSION) ?? "";
    const parts = value.split(".");
    return (
      parts.length === 3 &&
      Number(parts[0]) > Date.now() / 1000 &&
      same(parts[2]!, sign(`${parts[0]}.${parts[1]}`))
    );
  };
  return {
    origin: identity,
    check(request: Request, local: boolean): Response | null {
      if (local) return null;
      const url = new URL(request.url),
        host = request.headers.get("host");
      const atIdentity = host === identity.host;
      for (const [key, entry] of pending)
        if (entry.until < Date.now()) pending.delete(key);
      if (url.pathname === "/_st/auth/login") {
        const state = url.searchParams.get("state") ?? "",
          entry = pending.get(state);
        if (
          request.method !== "GET" ||
          !atIdentity ||
          request.headers.get("tailscale-user-login")?.toLowerCase() !==
            owner.toLowerCase() ||
          !entry
        )
          return response(403, "ST owner sign-in required");
        const code = randomBytes(32).toString("base64url");
        entry.code = code;
        const callback = new URL("/_st/auth/callback", site);
        callback.searchParams.set("state", state);
        callback.searchParams.set("code", code);
        return response(302, null, { location: callback.href });
      }
      if (url.pathname === "/_st/auth/callback") {
        const state = url.searchParams.get("state") ?? "",
          entry = pending.get(state);
        const code = url.searchParams.get("code") ?? "";
        if (
          request.method !== "GET" ||
          host !== site.host ||
          !entry?.code ||
          !same(entry.code, code) ||
          cookies(request).get(NONCE) !== state
        )
          return response(403, "Sign-in expired or invalid. Open ST again.");
        pending.delete(state);
        const headers = new Headers({
          location: new URL(entry.path, site).href,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        });
        headers.append("set-cookie", cookie(SESSION, session(), lifetime));
        headers.append("set-cookie", cookie(NONCE, "", 0));
        return new Response(null, { status: 302, headers });
      }
      if (atIdentity)
        return request.headers.get("tailscale-user-login")?.toLowerCase() ===
          owner.toLowerCase()
          ? null
          : response(403, "ST owner access required");
      if (valid(request)) return null;
      // Only a top-level page navigation may begin a cross-origin login. Fetch/WS callers fail closed.
      if (
        request.method !== "GET" ||
        !request.headers.get("accept")?.includes("text/html") ||
        request.headers.get("upgrade")
      )
        return response(401, "Open ST to sign in.");
      if (pending.size >= 1024)
        return response(503, "Sign-in is busy. Please retry.");
      const path = url.pathname + url.search;
      if (new URL(path, site).origin !== site.origin)
        return response(400, "Invalid return path");
      const state = randomBytes(32).toString("base64url");
      pending.set(state, { until: Date.now() + 300000, path });
      const login = new URL("/_st/auth/login", identity);
      login.searchParams.set("state", state);
      return response(302, null, {
        location: login.href,
        "set-cookie": cookie(NONCE, state, 300),
      });
    },
  };
}

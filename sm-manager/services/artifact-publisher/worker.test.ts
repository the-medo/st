import { describe, expect, test } from "bun:test";
import { handle, type Bucket, type Env } from "./worker";

class MemoryBucket implements Bucket {
  data = new Map<string, string | Uint8Array>();
  async get(key: string) {
    const value = this.data.get(key);
    if (value === undefined) return null;
    const response = new Response(value);
    return {
      body: response.body!,
      json: <T>() => response.json() as Promise<T>,
    };
  }
  async put(key: string, data: string | Uint8Array) {
    this.data.set(key, data);
  }
  async delete(key: string) {
    this.data.delete(key);
  }
}
const token = "a".repeat(32);
const key = "secret-".repeat(8);
async function fixture() {
  const text = "<!doctype html><h1>Published</h1>";
  const hash = new Bun.CryptoHasher("sha256").update(text).digest("hex");
  return {
    artifact_id: "b".repeat(32),
    revision: 1,
    entrypoint: "index.html",
    files: [
      {
        path: "index.html",
        mime: "text/html",
        sha256: hash,
        size: text.length,
        role: "output",
        base64: btoa(text),
      },
    ],
  };
}
const request = (
  path: string,
  method = "GET",
  body?: unknown,
  authorized = true,
) =>
  new Request("https://artifacts.example.test" + path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: authorized
      ? { authorization: "Bearer " + key, "content-type": "application/json" }
      : {},
  });
async function upload(env: Env, data: Awaited<ReturnType<typeof fixture>>) {
  for (const file of data.files) {
    const response = await handle(
      new Request(
        `https://artifacts.example.test/admin/objects/${file.sha256}`,
        {
          method: "PUT",
          body: atob(file.base64),
          headers: { authorization: "Bearer " + key },
        },
      ),
      env,
    );
    expect(response.status).toBe(200);
  }
}

describe("published artifacts", () => {
  test("private bucket is exposed only through a valid share and revocation closes every file", async () => {
    const env: Env = { ARTIFACTS: new MemoryBucket(), PUBLISH_KEY: key };
    const data = await fixture();
    await upload(env, data);
    expect(
      (await handle(request(`/admin/shares/${token}`, "PUT", data, false), env))
        .status,
    ).toBe(401);
    expect(
      (await handle(request(`/admin/shares/${token}`, "PUT", data), env))
        .status,
    ).toBe(200);
    expect(
      (await handle(request(`/objects/${data.files[0]!.sha256}`), env)).status,
    ).toBe(404);
    expect(
      (await handle(request(`/a/${token}/`), env)).headers.get("location"),
    ).toBe(`/a/${token}/index.html`);
    const page = await handle(request(`/a/${token}/index.html`), env);
    expect(await page.text()).toContain("Published");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("content-security-policy")).not.toContain(
      "allow-same-origin",
    );
    expect(
      (await handle(request(`/a/${token}/source/notes.md`), env)).status,
    ).toBe(404);
    await handle(request(`/admin/shares/${token}`, "DELETE"), env);
    expect((await handle(request(`/a/${token}/index.html`), env)).status).toBe(
      404,
    );
  });
  test("failed publication preserves the previous complete revision", async () => {
    const env: Env = { ARTIFACTS: new MemoryBucket(), PUBLISH_KEY: key };
    const data = await fixture();
    await upload(env, data);
    await handle(request(`/admin/shares/${token}`, "PUT", data), env);
    data.revision = 2;
    data.files[0]!.sha256 = "0".repeat(64);
    expect(
      (await handle(request(`/admin/shares/${token}`, "PUT", data), env))
        .status,
    ).toBe(400);
    expect(
      await (await handle(request(`/a/${token}/index.html`), env)).text(),
    ).toContain("Published");
  });
  test("source files cannot be published", async () => {
    const env: Env = { ARTIFACTS: new MemoryBucket(), PUBLISH_KEY: key };
    const data = await fixture();
    data.files[0]!.role = "source";
    expect(
      (await handle(request(`/admin/shares/${token}`, "PUT", data), env))
        .status,
    ).toBe(400);
    expect((await handle(request(`/a/${token}/index.html`), env)).status).toBe(
      404,
    );
  });
});

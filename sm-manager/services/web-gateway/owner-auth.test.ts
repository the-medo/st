import { expect, test } from "bun:test";
import { createGateway } from "./gateway";

test("vanity domain requires a nonce-bound Tailscale owner handoff and keeps backend credentials private", async () => {
  const backend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      Response.json({
        authenticated:
          request.headers.get("authorization") === "Bearer backend-fixture",
        origin: request.headers.get("origin"),
      }),
  });
  const config = {
    port: 0,
    publicOrigin: "https://st.example.test",
    monitorOrigin: `http://127.0.0.1:${backend.port}`,
    ovisOrigin: `http://127.0.0.1:${backend.port}`,
    ownerLogin: "owner@example.test",
    ovisToken: "backend-fixture",
    ownerAuth: {
      origin: "https://node.example.ts.net:8790",
      sessionSecret: "test-secret-that-is-long-enough-for-a-signature",
    },
  };
  let gateway = createGateway(config);
  try {
    const request = (
      url: string,
      headers: Record<string, string> = {},
      method = "GET",
    ) => {
      const target = new URL(url);
      return fetch(
        `http://127.0.0.1:${gateway.port}${target.pathname}${target.search}`,
        {
          redirect: "manual",
          method,
          headers: { host: target.host, ...headers },
        },
      );
    };
    expect(
      (
        await request(config.publicOrigin + "/agents/api/health", {
          "tailscale-user-login": config.ownerLogin,
        })
      ).status,
    ).toBe(401);
    expect((await request(config.publicOrigin + "/api/recent-conversations")).status).toBe(401);
    expect((await request(config.publicOrigin + "/api/recent-conversations", {}, "POST")).status).toBe(401);
    const first = await request(config.publicOrigin + "/agents?view=chat", {
      accept: "text/html",
    });
    expect(first.status).toBe(302);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const nonce = first.headers.get("set-cookie")!.split(";")[0]!;
    const login = first.headers.get("location")!;
    expect(new URL(login).origin).toBe(config.ownerAuth.origin);
    expect(
      (await request(login, { "tailscale-user-login": "other@example.test" }))
        .status,
    ).toBe(403);
    const approval = await request(login, {
      "tailscale-user-login": config.ownerLogin,
      "sec-fetch-site": "cross-site",
    });
    expect(approval.status).toBe(302);
    const callback = approval.headers.get("location")!;
    expect((await request(callback)).status).toBe(403);
    expect((await request(callback, { cookie: nonce }, "POST")).status).toBe(
      403,
    );
    const complete = await request(callback, {
      cookie: nonce,
      "sec-fetch-site": "cross-site",
    });
    expect(complete.status).toBe(302);
    expect(complete.headers.get("location")).toBe(
      config.publicOrigin + "/agents?view=chat",
    );
    const session = complete.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-st_owner="))!;
    expect(session).toContain("Secure; HttpOnly; SameSite=Lax");
    expect(session).not.toContain(config.ovisToken);
    expect((await request(callback, { cookie: nonce })).status).toBe(403);
    const cookie = session.split(";")[0]!;
    expect((await request(config.publicOrigin + "/api/recent-conversations", { cookie })).status).toBe(200);
    const response = await request(config.publicOrigin + "/agents/api/health", {
      cookie,
      origin: config.publicOrigin,
    });
    expect(await response.json()).toMatchObject({
      authenticated: true,
      origin: config.publicOrigin,
    });
    expect(
      (
        await request(config.publicOrigin + "/agents/api/health", {
          cookie,
          origin: "https://evil.example",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(config.publicOrigin + "/agents/api/health", {
          cookie: cookie + "x",
        })
      ).status,
    ).toBe(401);
    gateway.stop(true);
    gateway = createGateway(config);
    expect(
      (await request(config.publicOrigin + "/agents/api/health", { cookie }))
        .status,
    ).toBe(200);
    expect(
      (
        await request(config.ownerAuth.origin + "/agents/api/health", {
          "tailscale-user-login": config.ownerLogin,
        })
      ).status,
    ).toBe(200);
    expect(
      (await request(config.ownerAuth.origin + "/agents/api/health")).status,
    ).toBe(403);
  } finally {
    gateway.stop(true);
    backend.stop(true);
  }
});

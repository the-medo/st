import { expect, test } from "bun:test";
import { createGateway } from "./gateway";
test("cross-site links open app pages without allowing cross-site APIs or embedded requests", async () => {
  const backend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("shell"),
  });
  const gateway = createGateway({
    port: 0,
    publicOrigin: "https://st.example.test",
    monitorOrigin: `http://127.0.0.1:${backend.port}`,
    ovisOrigin: `http://127.0.0.1:${backend.port}`,
  });
  const navigation = {
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
  };
  const request = (
    path: string,
    headers: Record<string, string> = {},
    method = "GET",
  ) =>
    fetch(`http://127.0.0.1:${gateway.port}${path}`, {
      method,
      headers: { ...navigation, ...headers },
    });
  try {
    for (const path of [
      "/",
      "/overview?workmode=1",
      "/projects",
      "/github",
      "/agents",
      "/agents/chat/example",
      "/agents/session/example",
      "/assistant",
      "/planner/tasks",
      "/planner/calendar",
    ])
      expect((await request(path)).status).toBe(200);
    for (const path of [
      "/api/snapshot",
      "/api/night-mode",
      "/agents/api/medo/catalog",
      "/agents/ws",
      "/planner/api/tasks",
      "/planner/calendar?st-embedded=1",
      "/assets/example.js",
    ])
      expect((await request(path)).status).toBe(403);
    const rejectedHeaders: Record<string, string>[] = [
      { "sec-fetch-mode": "cors" },
      { "sec-fetch-mode": "no-cors" },
      { "sec-fetch-dest": "iframe" },
      { "sec-fetch-dest": "empty" },
      { origin: "https://elsewhere.example" },
      { host: "elsewhere.example" },
    ];
    for (const headers of rejectedHeaders)
      expect((await request("/", headers)).status).toBe(403);
    expect((await request("/", {}, "POST")).status).toBe(403);
  } finally {
    gateway.stop(true);
    backend.stop(true);
  }
});
test("routes monitor and Ovis namespaces without dropping origin or authorization", async () => {
  const backend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (r) =>
      Response.json({
        path: new URL(r.url).pathname,
        origin: r.headers.get("origin"),
        cookie: r.headers.get("cookie"),
      }),
  });
  const g = createGateway({
    port: 0,
    publicOrigin: "https://st.example.test",
    monitorOrigin: `http://127.0.0.1:${backend.port}`,
    ovisOrigin: `http://127.0.0.1:${backend.port}`,
    ownerLogin: "owner@example.test",
  });
  try {
    const base = `http://127.0.0.1:${g.port}`;
    expect(await (await fetch(base + "/api/snapshot")).json()).toMatchObject({
      path: "/api/snapshot",
    });
    for (const path of [
      "/ovis",
      "/ovis?pane=fixture",
      "/ovis/chat/fixture",
      "/ovis/api/medo/catalog",
      "/ovis/ws",
      "/ovis/assets/fixture.js",
    ]) {
      const response = await fetch(base + path, { redirect: "manual" });
      expect(response.status).toBe(404);
      expect(response.headers.get("location")).toBe(null);
    }
    const r = await fetch(base + "/agents/api/medo/catalog", {
      headers: { Origin: base, Cookie: "st_v2_device=fixture" },
    });
    expect(await r.json()).toEqual({
      path: "/api/medo/catalog",
      origin: base,
      cookie: "st_v2_device=fixture",
    });
    expect(
      (await fetch(base + "/agents/api/updates/install", { method: "POST" }))
        .status,
    ).toBe(403);
    expect(
      (
        await fetch(base + "/api/snapshot", {
          headers: { Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(base + "/api/snapshot", {
          headers: { Host: "evil.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(base + "/agents/api/medo/catalog", {
          headers: {
            Host: "st.example.test",
            "tailscale-user-login": "different@example.test",
          },
        })
      ).status,
    ).toBe(403);
  } finally {
    g.stop(true);
    backend.stop(true);
  }
});
test("WebSocket waits for upstream authorization and carries text and binary without replay", async () => {
  const backend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(r, s) {
      if (r.headers.get("cookie") !== "fixture=authorized")
        return new Response("Denied", { status: 401 });
      if (s.upgrade(r)) return;
      return new Response("", { status: 400 });
    },
    websocket: {
      message(ws, m) {
        ws.send(m);
      },
    },
  });
  const g = createGateway({
    port: 0,
    publicOrigin: "https://st.example.test",
    monitorOrigin: `http://127.0.0.1:${backend.port}`,
    ovisOrigin: `http://127.0.0.1:${backend.port}`,
  });
  try {
    const denied = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${g.port}/agents/ws`);
      ws.onopen = () => {
        ws.close();
        resolve(false);
      };
      ws.onerror = () => resolve(true);
    });
    expect(denied).toBe(true);
    const received = await new Promise<(string | number[])[]>(
      (resolve, reject) => {
        const result: (string | number[])[] = [];
        const ws = new WebSocket(`ws://127.0.0.1:${g.port}/agents/ws`, {
          headers: { Cookie: "fixture=authorized" },
        });
        ws.binaryType = "arraybuffer";
        ws.onerror = () => reject(new Error("Socket failed"));
        ws.onopen = () => {
          ws.send("hello");
          ws.send(new Uint8Array([1, 2, 3]));
        };
        ws.onmessage = (e) => {
          result.push(
            typeof e.data === "string"
              ? e.data
              : Array.from(new Uint8Array(e.data)),
          );
          if (result.length === 2) {
            ws.close();
            resolve(result);
          }
        };
      },
    );
    expect(received).toEqual(["hello", [1, 2, 3]]);
  } finally {
    g.stop(true);
    backend.stop(true);
  }
});
test("compressed assets and streaming bodies survive forwarding", async () => {
  const encoded = Bun.gzipSync("console asset");
  const backend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(r) {
      return new URL(r.url).pathname === "/gzip"
        ? new Response(encoded, {
            headers: {
              "content-encoding": "gzip",
              "content-length": String(encoded.length),
              "content-type": "text/plain",
            },
          })
        : new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode("data: first\n\n"));
                c.enqueue(new TextEncoder().encode("data: last\n\n"));
                c.close();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
    },
  });
  const g = createGateway({
    port: 0,
    publicOrigin: "https://st.example.test",
    monitorOrigin: `http://127.0.0.1:${backend.port}`,
    ovisOrigin: `http://127.0.0.1:${backend.port}`,
  });
  try {
    expect(await (await fetch(`http://127.0.0.1:${g.port}/gzip`)).text()).toBe(
      "console asset",
    );
    expect(
      await (await fetch(`http://127.0.0.1:${g.port}/agents/api/events`)).text(),
    ).toBe("data: first\n\ndata: last\n\n");
  } finally {
    g.stop(true);
    backend.stop(true);
  }
});

test("local ingress drops proxy assertions while public ingress preserves Tailscale identity", async () => {
  const backend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (r) =>
      Response.json(
        Object.fromEntries(
          [
            "host",
            "origin",
            "x-forwarded-host",
            "x-forwarded-for",
            "tailscale-user-login",
          ].map((k) => [k, r.headers.get(k)]),
        ),
      ),
  });
  const gateway = createGateway({
    port: 0,
    publicOrigin: "https://st.example.test",
    monitorOrigin: `http://127.0.0.1:${backend.port}`,
    ovisOrigin: `http://127.0.0.1:${backend.port}`,
    ownerLogin: "owner@example.test",
  });
  try {
    const local = `http://127.0.0.1:${gateway.port}`;
    const response = await fetch(local + "/agents/api/health", {
      headers: {
        "x-forwarded-host": "forged.invalid",
        "x-forwarded-for": "100.64.0.1",
        "tailscale-user-login": "owner@example.test",
      },
    });
    expect(await response.json()).toMatchObject({
      host: `127.0.0.1:${gateway.port}`,
      "x-forwarded-host": null,
      "x-forwarded-for": null,
      "tailscale-user-login": null,
    });
    const remote = await fetch(local + "/agents/api/health", {
      headers: {
        host: "st.example.test",
        origin: "https://st.example.test",
        "x-forwarded-host": "forged.invalid",
        "x-forwarded-for": "100.64.0.1",
        "tailscale-user-login": "owner@example.test",
      },
    });
    expect(await remote.json()).toMatchObject({
      host: "st.example.test",
      origin: "https://st.example.test",
      "x-forwarded-host": "st.example.test",
      "x-forwarded-for": "100.64.0.1",
      "tailscale-user-login": "owner@example.test",
    });
    for (const path of ["/api/runtime", "/api/access/tailscale/serve"])
      expect(
        (await fetch(local + "/agents" + path, { method: "POST" })).status,
      ).toBe(403);
  } finally {
    gateway.stop(true);
    backend.stop(true);
  }
});

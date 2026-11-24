import type { ServerWebSocket } from "bun";
import { ownerAuth, type OwnerAuthConfig } from "./owner-auth";
export type GatewayConfig = {
  port: number;
  publicOrigin: string;
  monitorOrigin: string;
  ovisOrigin: string;
  ownerLogin?: string;
  ownerAuth?: OwnerAuthConfig;
  ovisToken?: string;
};
type Bridge = {
  upstream: WebSocket;
  client?: ServerWebSocket<Bridge>;
  pending: (string | Uint8Array)[];
  bytes: number;
  closed: boolean;
};
const MAX_QUEUE = 4 * 1024 * 1024;
const hop = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];
const blocked =
  /^\/api\/(?:updates\/(?:install|cancel|check)|herdr\/update|runtime\/move)(?:\/|$)/;
const closeCode = (code: number) =>
  code === 1000 || code === 1001 || (code >= 3000 && code <= 4999)
    ? code
    : 1011;
export function createGateway(config: GatewayConfig) {
  const publicUrl = new URL(config.publicOrigin),
    monitor = new URL(config.monitorOrigin),
    ovis = new URL(config.ovisOrigin);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(monitor.hostname) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(ovis.hostname)
  )
    throw new Error("Upstreams must use loopback");
  const auth = config.ownerAuth
    ? ownerAuth(config.publicOrigin, config.ownerLogin ?? "", config.ownerAuth)
    : null;
  const publicHosts = new Map(
    [publicUrl, ...(auth ? [auth.origin] : [])].map((url) => [url.host, url]),
  );
  const server = Bun.serve<Bridge>({
    hostname: "127.0.0.1",
    port: config.port,
    maxRequestBodySize: 64 * 1024 * 1024,
    idleTimeout: 60,
    async fetch(request, server) {
      const url = new URL(request.url),
        host = request.headers.get("host") ?? "";
      const localHosts = new Set([
        `127.0.0.1:${server.port}`,
        `localhost:${server.port}`,
      ]);
      const publicHost = publicHosts.get(host);
      if (!publicHost && !localHosts.has(host))
        return new Response("Host not allowed", { status: 403 });
      // These two GET endpoints use a one-use code plus the vanity-domain nonce cookie.
      // Cross-site navigation is necessary for the Tailscale identity handoff.
      if (
        auth &&
        ["/_st/auth/login", "/_st/auth/callback"].includes(url.pathname)
      )
        return (
          auth.check(request, false) ??
          new Response("Invalid sign-in request", { status: 400 })
        );
      const origin = request.headers.get("origin");
      if (
        request.headers.get("sec-fetch-site") === "cross-site" ||
        (origin && !new Set([publicHost?.origin, `http://${host}`]).has(origin))
      )
        return new Response("Origin not allowed", { status: 403 });
      const denial = auth?.check(request, localHosts.has(host));
      if (denial) return denial;
      if (url.pathname === "/api/gateway-health")
        return Response.json(
          { status: "ok" },
          { headers: { "cache-control": "no-store" } },
        );
      const ovisRoute =
        url.pathname === "/ovis/ws" ||
        url.pathname.startsWith("/ovis/api/") ||
        url.pathname.startsWith("/ovis/assets/") ||
        url.pathname.startsWith("/ovis/media/") ||
        url.pathname.startsWith("/ovis/page-media/");
      if (
        ovisRoute &&
        !auth &&
        host === publicUrl.host &&
        config.ownerLogin &&
        request.headers.get("tailscale-user-login")?.toLowerCase() !==
          config.ownerLogin.toLowerCase()
      )
        return new Response("Ovis owner access required", { status: 403 });
      const target = new URL(ovisRoute ? ovis : monitor);
      target.pathname = ovisRoute ? url.pathname.slice(5) : url.pathname;
      target.search = url.search;
      if (
        ovisRoute &&
        (blocked.test(target.pathname) ||
          (request.method !== "GET" &&
            /^\/api\/(?:access\/tailscale\/serve|runtime)(?:\/|$)/.test(
              target.pathname,
            )))
      )
        return Response.json(
          {
            error: {
              code: "managed_by_st",
              message: "This installation is updated by S.T.",
            },
          },
          { status: 403 },
        );
      const headers = new Headers(request.headers);
      hop.forEach((h) => headers.delete(h));
      // The gateway only listens on loopback. The public ingress is the owned Tailscale
      // Serve route, which supplies identity. Keep its identity and public Host intact:
      // treating the downstream peer as a fresh local owner would bypass Ovis policy.
      headers.set("host", host);
      headers.set("x-forwarded-host", host);
      headers.delete("forwarded");
      if (publicHost)
        headers.set("x-forwarded-proto", publicHost.protocol.slice(0, -1));
      else {
        headers.delete("tailscale-user-login");
        headers.delete("tailscale-user-name");
        headers.delete("tailscale-user-profile-pic");
        headers.delete("x-forwarded-for");
        headers.delete("x-forwarded-host");
        headers.delete("x-real-ip");
        headers.delete("via");
        headers.delete("x-forwarded-proto");
      }
      // The private backend credential is added only after ingress authorization; it never reaches a browser.
      if (ovisRoute && config.ovisToken)
        headers.set("authorization", `Bearer ${config.ovisToken}`);
      if (url.pathname === "/ovis/ws") {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
          return new Response("WebSocket upgrade required", { status: 426 });
        target.protocol = "ws:";
        headers.delete("sec-websocket-key");
        headers.delete("sec-websocket-version");
        headers.delete("sec-websocket-extensions");
        return await new Promise<Response | undefined>((resolve) => {
          const upstream = new WebSocket(target.href, {
            headers: Object.fromEntries(headers),
            perMessageDeflate: false,
          });
          upstream.binaryType = "arraybuffer";
          const bridge: Bridge = {
            upstream,
            pending: [],
            bytes: 0,
            closed: false,
          };
          let settled = false;
          const refuse = () => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve(
                new Response("Ovis connection unavailable or unauthorized", {
                  status: 502,
                }),
              );
            }
          };
          const timer = setTimeout(() => {
            refuse();
            upstream.close();
          }, 10000);
          request.signal.addEventListener(
            "abort",
            () => {
              if (!settled) {
                refuse();
                upstream.close();
              }
            },
            { once: true },
          );
          upstream.onopen = () => {
            clearTimeout(timer);
            if (settled || request.signal.aborted) {
              upstream.close();
              return;
            }
            settled = true;
            if (server.upgrade(request, { data: bridge })) {
              resolve(undefined);
            } else {
              upstream.close();
              resolve(new Response("Upgrade failed", { status: 400 }));
            }
          };
          upstream.onmessage = (event) => {
            const data =
              typeof event.data === "string"
                ? event.data
                : new Uint8Array(event.data as ArrayBuffer);
            if (bridge.closed) return;
            if (bridge.client) {
              if (bridge.client.getBufferedAmount() > MAX_QUEUE) {
                bridge.client.close(1013, "Slow connection");
                upstream.close();
                return;
              }
              bridge.client.send(data);
            } else {
              bridge.bytes +=
                typeof data === "string"
                  ? Buffer.byteLength(data)
                  : data.byteLength;
              if (bridge.bytes > MAX_QUEUE) {
                bridge.closed = true;
                upstream.close();
                return;
              }
              bridge.pending.push(data);
            }
          };
          upstream.onclose = (event) => {
            clearTimeout(timer);
            refuse();
            bridge.closed = true;
            bridge.client?.close(
              closeCode(event.code),
              "Upstream disconnected",
            );
          };
          upstream.onerror = () => {
            refuse();
            bridge.client?.close(1011, "Upstream unavailable");
          };
        });
      }
      try {
        const response = await fetch(target, {
          method: request.method,
          headers,
          body:
            request.method === "GET" || request.method === "HEAD"
              ? undefined
              : request.body,
          redirect: "manual",
          decompress: false,
          signal: request.signal,
        });
        const outgoing = new Headers(response.headers);
        hop.forEach((h) => outgoing.delete(h));
        if (response.status >= 300 && response.status < 400 && ovisRoute) {
          const next = outgoing.get("location");
          if (next) {
            const location = new URL(next, target);
            if (location.origin !== target.origin)
              return new Response("Unexpected upstream redirect", {
                status: 502,
              });
            outgoing.set(
              "location",
              "/ovis" + location.pathname + location.search + location.hash,
            );
          }
        }
        return new Response(response.body, {
          status: response.status,
          headers: outgoing,
        });
      } catch {
        return Response.json(
          {
            error: ovisRoute
              ? "Ovis temporarily unavailable"
              : "Monitor temporarily unavailable",
          },
          { status: 503, headers: { "cache-control": "no-store" } },
        );
      }
    },
    websocket: {
      open(client) {
        const bridge = client.data;
        bridge.client = client;
        if (bridge.closed) {
          client.close(1011, "Upstream closed");
          return;
        }
        for (const data of bridge.pending) client.send(data);
        bridge.pending = [];
        bridge.bytes = 0;
      },
      message(client, message) {
        const upstream = client.data.upstream;
        if (upstream.readyState !== WebSocket.OPEN) {
          client.close(1011, "Upstream disconnected");
          return;
        }
        if (upstream.bufferedAmount > MAX_QUEUE) {
          client.close(1013, "Slow connection");
          upstream.close();
          return;
        }
        upstream.send(message);
      },
      close(client) {
        client.data.closed = true;
        client.data.upstream.close(1000, "Viewer detached");
      },
      maxPayloadLength: MAX_QUEUE,
      backpressureLimit: MAX_QUEUE,
      closeOnBackpressureLimit: true,
      idleTimeout: 120,
      sendPings: true,
    },
  });
  return server;
}

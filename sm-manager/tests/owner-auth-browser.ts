import { chromium } from "playwright-core";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { createGateway } from "../services/web-gateway/gateway";

// Real HTTPS redirects and browser cookies, with a synthetic Tailscale identity ingress.
const temporary = mkdtempSync(join(tmpdir(), "st-owner-browser-"));
const key = join(temporary, "key.pem"),
  cert = join(temporary, "cert.pem");
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-subj",
    "/CN=st.example.test",
  ],
  { stdio: "ignore" },
);
const backend = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    if (new URL(request.url).pathname.startsWith("/api/"))
      return Response.json({
        authenticated:
          request.headers.get("authorization") === "Bearer fixture-secret",
      });
    return new Response("<!doctype html><h1>ST fixture</h1>", {
      headers: { "content-type": "text/html" },
    });
  },
});
let gateway: ReturnType<typeof createGateway>;
let owner = "owner@example.test";
let entrySite: string | null = null;
const ingress = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  tls: { key: Bun.file(key), cert: Bun.file(cert) },
  async fetch(request) {
    const url = new URL(request.url),
      headers = new Headers(request.headers);
    if (
      entrySite === null &&
      url.hostname === "st.example.test" &&
      url.pathname === "/ovis"
    )
      entrySite = headers.get("sec-fetch-site") ?? "missing";
    headers.delete("tailscale-user-login");
    if (url.hostname === "node.example.ts.net")
      headers.set("tailscale-user-login", owner);
    return fetch(
      `http://127.0.0.1:${gateway.port}${url.pathname}${url.search}`,
      {
        headers,
        redirect: "manual",
        method: request.method,
      },
    );
  },
});
const origin = `https://st.example.test:${ingress.port}`;
gateway = createGateway({
  port: 0,
  publicOrigin: origin,
  monitorOrigin: `http://127.0.0.1:${backend.port}`,
  ovisOrigin: `http://127.0.0.1:${backend.port}`,
  ownerLogin: owner,
  ovisToken: "fixture-secret",
  ownerAuth: {
    origin: `https://node.example.ts.net:${ingress.port}`,
    sessionSecret: "fixture-signing-secret-with-at-least-32-characters",
  },
});
const cache = join(homedir(), ".cache/ms-playwright");
const folder = existsSync(cache)
  ? readdirSync(cache)
      .filter((v) => v.startsWith("chromium-"))
      .sort()
      .at(-1)
  : undefined;
const executablePath =
  process.env.BROWSER_EXECUTABLE ??
  (folder
    ? [
        join(cache, folder, "chrome-linux64/chrome"),
        join(cache, folder, "chrome-linux/chrome"),
      ].find(existsSync)
    : undefined);
const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: [
    "--no-sandbox",
    "--no-proxy-server",
    "--host-resolver-rules=MAP st.example.test 127.0.0.1, MAP node.example.ts.net 127.0.0.1",
  ],
});
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  // Clicking from another site sends Fetch Metadata that page.goto does not.
  await page.route("https://outside.example/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<a href="${origin}/ovis?view=chat">Open ST</a>`,
    }),
  );
  await page.goto("https://outside.example/");
  await page.getByRole("link", { name: "Open ST" }).click();
  await page
    .getByRole("heading", { name: "ST fixture" })
    .waitFor({ timeout: 10000 });
  assert.equal(entrySite, "cross-site");
  assert.equal(page.url(), origin + "/ovis?view=chat");
  const cookies = await context.cookies();
  assert(
    cookies.some((c) => c.name === "__Host-st_owner" && c.secure && c.httpOnly),
  );
  assert(!cookies.some((c) => c.name === "__Host-st_login"));
  assert.equal(await page.evaluate(() => document.cookie), "");
  const api = await page.evaluate(async () =>
    (await fetch("/ovis/api/health")).json(),
  );
  assert.equal(api.authenticated, true);
  await page.reload();
  await page.getByRole("heading", { name: "ST fixture" }).waitFor();
  // A different tailnet member cannot acquire an owner session.
  owner = "someone-else@example.test";
  const denied = await browser.newPage({ ignoreHTTPSErrors: true });
  const response = await denied.goto(origin);
  assert.equal(response?.status(), 403);
  assert(
    !(await denied.context().cookies()).some(
      (c) => c.name === "__Host-st_owner",
    ),
  );
  console.log("Owner sign-in browser acceptance passed");
} finally {
  await browser.close();
  ingress.stop(true);
  gateway.stop(true);
  backend.stop(true);
  rmSync(temporary, { recursive: true, force: true });
}

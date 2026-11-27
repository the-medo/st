/** On-demand, offline rendering. No MCP server or persistent browser process. */
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../sm_manager/artifact_renderer",
);
const cache = join(homedir(), ".cache/ms-playwright");
const candidates = existsSync(cache)
  ? readdirSync(cache)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
  : [];
const executablePath =
  process.env.BROWSER_EXECUTABLE ||
  candidates
    .flatMap((name) => [
      join(cache, name, "chrome-linux64/chrome"),
      join(cache, name, "chrome-linux/chrome"),
    ])
    .find(existsSync);
if (!existsSync(join(root, "index.html")))
  throw new Error("Build the diagram renderer before using it: bun run build");
if (!executablePath)
  throw new Error(
    "Install Chromium with Playwright, or set BROWSER_EXECUTABLE to its executable path.",
  );
const input = await Bun.stdin.text();
if (Buffer.byteLength(input) > 32 * 1024 * 1024)
  throw new Error("Diagram JSON exceeds 32 MiB.");
const scene: unknown = JSON.parse(input);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (
      request.method !== "GET" ||
      request.headers.get("host") !== `127.0.0.1:${server.port}`
    )
      return new Response("Not found", { status: 404 });
    const path = resolve(
      root,
      "." +
        (url.pathname === "/"
          ? "/index.html"
          : decodeURIComponent(url.pathname)),
    );
    if (!path.startsWith(root + sep))
      return new Response("Not found", { status: 404 });
    const file = Bun.file(path);
    return (await file.exists())
      ? new Response(file, {
          headers: {
            "Cache-Control": "no-store",
            "Content-Security-Policy":
              "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; frame-src 'none'",
          },
        })
      : new Response("Not found", { status: 404 });
  },
});
const origin = `http://127.0.0.1:${server.port}`;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort(),
  );
  await page.goto(origin);
  await page.waitForFunction(() => "renderHerdrDiagram" in window, null, {
    timeout: 30000,
  });
  const result = await page.evaluate(async (data) => {
    const renderer = (
      window as unknown as {
        renderHerdrDiagram: (input: unknown) => Promise<unknown>;
      }
    ).renderHerdrDiagram;
    return renderer(data);
  }, scene);
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      error:
        error instanceof Error ? error.message : "Diagram rendering failed",
    }) + "\n",
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.stop(true);
}

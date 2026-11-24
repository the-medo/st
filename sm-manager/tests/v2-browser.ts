import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { fixtureApi } from "./v2-fixtures";
const root = resolve("sm_manager/web");
const planner = `<!doctype html><html><body><h1>Fixture planner</h1><input aria-label="Task title"><button id="home">ST home</button><script>document.querySelector('#home').onclick=()=>parent.postMessage({type:'st:home'},location.origin);parent.postMessage({type:'st:ready',path:'/planner/tasks'},location.origin);window.addEventListener('message',e=>{if(e.origin!==location.origin)return;if(e.data.type==='st:navigate')parent.postMessage({type:'st:navigated',path:e.data.path},location.origin);});</script></body></html>`;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/"))
      return Response.json(fixtureApi(url, req.method));
    if (url.searchParams.has("st-embedded"))
      return new Response(planner, {
        headers: { "content-type": "text/html" },
      });
    const path = resolve(root, "." + url.pathname);
    if (!path.startsWith(root + "/") && path !== root)
      return new Response("", { status: 404 });
    const file = Bun.file(path);
    return (await file.exists())
      ? new Response(file)
      : new Response(Bun.file(join(root, "index.html")));
  },
});
const cache = join(homedir(), ".cache/ms-playwright");
const folder = readdirSync(cache)
  .filter((v) => v.startsWith("chromium-"))
  .sort()
  .at(-1);
const executable =
  process.env.BROWSER_EXECUTABLE ??
  (folder
    ? [
        join(cache, folder, "chrome-linux64/chrome"),
        join(cache, folder, "chrome-linux/chrome"),
      ].find(existsSync)
    : undefined);
const browser = await chromium.launch({
  headless: true,
  executablePath: executable,
  args: ["--no-sandbox"],
});
const errors: string[] = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  const base = `http://127.0.0.1:${server.port}`;
  await page.goto(base);
  await page.getByRole("heading", { name: "Your services" }).waitFor();
  await page.getByRole("link", { name: /RAM/ }).waitFor();
  assert.match(await page.locator("body").innerText(), /8.0 GB/);
  for (const route of [
    "overview",
    "projects",
    "containers",
    "codex",
    "storage",
    "zed",
    "dbs",
    "air-quality",
    "faceplate",
  ]) {
    await page.goto(`${base}/${route}`);
    await page.locator(".st-topbar h1").waitFor();
    await page.waitForFunction(
      () =>
        !document
          .querySelector(".st-content")
          ?.textContent?.includes("Loading page…"),
    );
    assert(!(await page.getByText("Page not found.").count()), route);
  }
  await page.goto(`${base}/projects`);
  await page.getByRole("button", { name: "main [main]" }).click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("button", { name: "Generate cleanup brief" }).click();
  await page.getByText("Verify fresh ownership", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.goto(`${base}/#system`);
  await page.waitForURL("**/overview");
  await page.getByRole("link", { name: "Tasks", exact: true }).click();
  const frame = page.frameLocator('iframe[title="ST Planner"]');
  await frame.getByLabel("Task title").fill("Draft survives");
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.getByRole("link", { name: "Tasks", exact: true }).click();
  assert.equal(
    await frame.getByLabel("Task title").inputValue(),
    "Draft survives",
  );
  await page.goto(`${base}/faceplate`);
  await page.getByRole("switch", { name: /Night mode/ }).click();
  await page.waitForFunction(() =>
    document.body.textContent?.includes("Night mode off"),
  ); // authoritative status remains fixture-provided
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  await page.getByRole("button", { name: "Toggle S.T. navigation" }).click();
  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await page.getByPlaceholder("Project, branch, path…").waitFor();
  const evidence = process.env.ST_V2_EVIDENCE;
  if (evidence) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(base);
    await page.getByRole("heading", { name: "Your services" }).waitFor();
    await page.screenshot({ path: evidence, fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log(
    "Console browser acceptance passed: routes, history, worktree detail, planner draft, night mode and mobile navigation.",
  );
} finally {
  await browser.close();
  server.stop(true);
}

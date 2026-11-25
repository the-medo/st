import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { fixtureApi } from "./v2-fixtures";
import { verifyGitHub } from "./github-browser";
import { verifyCatalogs } from "./catalog-browser";
import { verifyAirQuality } from "./air-browser";
import { verifyOverviewCharts } from "./overview-browser";
const root = resolve("sm_manager/web");
const planner = `<!doctype html><html><head><link rel="stylesheet" href="/st-theme.css"><link rel="stylesheet" href="/st-planner.css"><script src="/st-planner.js"></script></head><body><h1>Fixture planner</h1><input aria-label="Task title"><button id="home">ST home</button><script>document.querySelector('#home').onclick=()=>parent.postMessage({type:'st:home'},location.origin);parent.postMessage({type:'st:ready',path:'/planner/tasks'},location.origin);window.addEventListener('message',e=>{if(e.origin!==location.origin)return;if(e.data.type==='st:navigate')parent.postMessage({type:'st:navigated',path:e.data.path},location.origin);});</script></body></html>`;
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
    if (
      ["/st-theme.css", "/st-planner.css", "/st-planner.js"].includes(
        url.pathname,
      )
    )
      return new Response(
        Bun.file(resolve("sm_manager/static", "." + url.pathname)),
      );
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
  assert.match(await page.locator("body").innerText(), /8.0\s*GB/);
  assert.equal(
    await page
      .locator(".st-app")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgb(13, 17, 23)",
  );
  assert.equal(
    await page
      .locator(".st-sidebar")
      .evaluate((el) => el.getBoundingClientRect().width),
    174,
  );
  await page.setViewportSize({ width: 900, height: 1000 });
  assert.equal(
    await page
      .locator(".st-sidebar")
      .evaluate((el) => el.getBoundingClientRect().width),
    54,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });

  for (const route of [
    "overview",
    "projects",
    "containers",
    "github",
    "storage",
    "zed",
    "dbs",
    "air-quality",
    "faceplate",
  ]) {
    await page.goto(`${base}/${route}`);
    await page.locator(".st-content").waitFor();
    await page.waitForFunction(
      () =>
        !document
          .querySelector(".st-content")
          ?.textContent?.includes("Loading page…"),
    );
    assert(!(await page.getByText("Page not found.").count()), route);
  }
  await verifyCatalogs(page, base);
  await verifyOverviewCharts(page, base);
  await page.goto(`${base}/overview`);
  await page
    .getByRole("group", { name: "History range", exact: true })
    .getByRole("button", { name: "15m", exact: true })
    .click();
  const overviewChart = page.locator(".st-chart").first();
  const overviewPlot = overviewChart.locator("svg");
  await overviewPlot.scrollIntoViewIfNeeded();
  const plotBox = (await overviewPlot.boundingBox())!;
  await overviewPlot.hover({ position: { x: plotBox.width - 12, y: 90 } });
  const overviewTip = overviewChart.getByRole("tooltip");
  await overviewTip.waitFor();
  assert.equal(await overviewTip.locator(".allocation-row").count(), 5);
  assert.equal(
    await overviewTip
      .locator(".allocation-label > span:last-child")
      .filter({ hasText: "—" })
      .count(),
    0,
    "Separately sampled series all have readings",
  );
  assert.match(await overviewTip.innerText(), /Whole machine[\s\S]*GiB/);
  const tipBox = (await overviewTip.boundingBox())!;
  assert(
    tipBox.x >= plotBox.x &&
      tipBox.x + tipBox.width <= plotBox.x + plotBox.width + 1,
    "Tooltip stays inside the plot at its right edge",
  );
  await overviewTip.hover();
  await overviewTip.waitFor(); // The panel remains readable when hovered.
  if (process.env.ST_V2_CHART_EVIDENCE)
    await page.screenshot({ path: process.env.ST_V2_CHART_EVIDENCE });
  await page.keyboard.press("Escape");
  await overviewTip.waitFor({ state: "hidden" });
  await overviewPlot.focus();
  await overviewPlot.press("Home");
  await overviewTip.waitFor();
  const firstTime = await overviewTip.locator("time").getAttribute("datetime");
  await overviewPlot.press("ArrowRight");
  assert.notEqual(
    await overviewTip.locator("time").getAttribute("datetime"),
    firstTime,
  );
  await overviewPlot.press("End");
  await overviewChart
    .getByRole("button", { name: "Whole machine", exact: true })
    .click();
  await overviewPlot.focus();
  await overviewTip.waitFor();
  assert.equal(await overviewTip.locator(".allocation-row").count(), 4);
  assert(!(await overviewTip.innerText()).includes("Whole machine"));
  await page
    .getByRole("group", { name: "History metric", exact: true })
    .getByRole("button", { name: "CPU", exact: true })
    .click();
  await overviewPlot.focus();
  await overviewTip.waitFor();
  assert.match(await overviewTip.innerText(), /%/);
  await page.keyboard.press("Escape");
  await overviewPlot.hover({ position: { x: 30, y: 80 } });
  await overviewTip.waitFor();
  await page.mouse.move(2, 2);
  await overviewTip.waitFor({ state: "hidden" });

  await page.goto(`${base}/projects`);
  await page.getByRole("button", { name: "main [main]" }).click();
  await page.getByRole("dialog").waitFor();
  const detailChart = page.getByRole("dialog").locator(".st-chart");
  await detailChart.locator("svg").focus();
  await detailChart.getByRole("tooltip").waitFor();
  assert.match(
    await detailChart.getByRole("tooltip").innerText(),
    /Garden \/ main/,
  );
  const dialogBox = (await page.getByRole("dialog").boundingBox())!;
  const detailTipBox = (await detailChart.getByRole("tooltip").boundingBox())!;
  assert(
    detailTipBox.y >= dialogBox.y &&
      detailTipBox.y + detailTipBox.height <=
        dialogBox.y + dialogBox.height + 1,
    "Worktree tooltip fits inside the scrolling dialog",
  );
  await page.keyboard.press("Escape");
  await detailChart.getByRole("tooltip").waitFor({ state: "hidden" });
  await page.getByRole("dialog").waitFor(); // Escape dismisses the tooltip first.
  await page.getByRole("button", { name: "Generate cleanup brief" }).click();
  await page.getByText("Verify fresh ownership", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.goto(`${base}/#system`);
  await page.waitForURL("**/overview");
  await page.getByRole("link", { name: "Tasks", exact: true }).click();
  const frame = page.frameLocator('iframe[title="ST Planner"]');
  await frame.getByLabel("Task title").fill("Draft survives");
  assert.equal(
    await frame
      .locator("body")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgb(13, 17, 23)",
  );
  await page.getByRole("switch", { name: "Workmode", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLIFrameElement>("iframe")?.contentDocument
        ?.documentElement.dataset.stTheme === "workmode",
  );
  assert.equal(
    await frame
      .locator("body")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgb(25, 18, 14)",
  );

  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.getByRole("link", { name: "Tasks", exact: true }).click();
  assert.equal(
    await frame.getByLabel("Task title").inputValue(),
    "Draft survives",
  );
  await frame.locator("body").evaluate((el) => {
    const row = document.createElement("section");
    row.innerHTML =
      '<div><span class="block font-medium">Theme</span><div><button>Light</button><button>System</button><button>Dark</button></div></div>';
    el.append(row);
  });
  await frame.getByText("Colors follow the S.T. console.").waitFor();
  assert.equal(
    await frame.getByRole("button", { name: "Light", exact: true }).count(),
    0,
    "Planner's standalone color control is hidden while hosted",
  );
  assert.match(page.url(), /workmode=1/);
  await page.getByRole("switch", { name: "Workmode", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLIFrameElement>("iframe")?.contentDocument
        ?.documentElement.dataset.stTheme === "console",
  );
  await frame.locator("html").evaluate((el) => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://untrusted.invalid",
        source: parent,
        data: { type: "st:theme", theme: "workmode" },
      }),
    );
    if (el.dataset.stTheme !== "console")
      throw new Error("Untrusted theme message was accepted");
  });
  await page.goto(`${base}/faceplate`);
  await page.getByRole("switch", { name: /Night mode/ }).click();
  await page.waitForFunction(() =>
    document.body.textContent?.includes("Night mode off"),
  ); // authoritative status remains fixture-provided
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await page.getByPlaceholder("Project, branch, path…").waitFor();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "Mobile projects fit the viewport",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await verifyAirQuality(page, base);
  await verifyGitHub(page, base);

  const touch = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  touch.on("pageerror", (error) => errors.push(error.message));
  await touch.goto(`${base}/overview`);
  await touch
    .getByRole("group", { name: "History range", exact: true })
    .getByRole("button", { name: "15m", exact: true })
    .click();
  const touchPlot = touch.locator(".st-chart svg").first();
  await touchPlot.scrollIntoViewIfNeeded();
  const touchBox = (await touchPlot.boundingBox())!;
  await touch.touchscreen.tap(
    touchBox.x + touchBox.width - 12,
    Math.max(touchBox.y, 0) + 80,
  );
  const touchTip = touch.getByRole("tooltip");
  await touchTip.waitFor();
  const touchTipBox = (await touchTip.boundingBox())!;
  assert(
    touchTipBox.x >= 0 &&
      touchTipBox.x + touchTipBox.width <= 390 &&
      touchTipBox.y >= 0 &&
      touchTipBox.y + touchTipBox.height <= 844,
    "Touch tooltip stays in the phone viewport",
  );
  await touch
    .getByRole("heading", { name: "Machine health", exact: true })
    .tap();
  await touchTip.waitFor({ state: "hidden" });
  await touch.goto(`${base}/air-quality`);
  const touchAir = touch.locator("#air-chart-air");
  await touchAir.locator("svg").waitFor();
  await touchAir.tap({ position: { x: 120, y: 100 } });
  await touch.locator("#air-reading-air .air-reading-time").waitFor();
  assert.match(
    await touch.locator("#air-reading-air").innerText(),
    /CO₂[\s\S]*ppm[\s\S]*peak 850/,
  );
  await touch.close();

  const evidence = process.env.ST_V2_EVIDENCE;
  if (evidence) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(base);
    await page.getByRole("heading", { name: "Your services" }).waitFor();
    await page.screenshot({ path: evidence, fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log(
    "Console browser acceptance passed: routes, GitHub sprint/backlog/PRs, Agents styling, history, worktree detail, planner draft, night mode, mobile navigation, aligned catalogs, restored Air Quality charts, and mouse/keyboard/touch tooltips.",
  );
} finally {
  await browser.close();
  server.stop(true);
}

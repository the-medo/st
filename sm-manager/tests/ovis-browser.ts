import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { fixtureApi, ui } from "./v2-fixtures";
import panes from "../integrations/ovis/app/site/demo/fixtures/panes.json";
ui.ovis = true;
const fixture = Bun.spawn(["python3", "tests/serve_v2_fixture.py"], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "inherit",
});
fixture.stdin.write(
  JSON.stringify(
    Object.fromEntries(
      ["ui-config", "snapshot", "history", "zed", "dbs"].map((name) => [
        `/api/${name}`,
        fixtureApi(new URL(`http://fixture/api/${name}`), "GET"),
      ]),
    ),
  ) + "\n",
);
fixture.stdin.end();
const reader = fixture.stdout.getReader();
const first = await reader.read();
const port = Number(new TextDecoder().decode(first.value).trim());
if (!port) throw new Error("Fixture server did not start");
const server = {
  port,
  stop(_force: boolean) {
    fixture.kill();
  },
};
const demo = await Bun.build({
  entrypoints: ["integrations/ovis/app/site/demo/transport.ts"],
  target: "browser",
  format: "iife",
  define: {
    __APP_VERSION__: JSON.stringify("0.5.9"),
    "import.meta.env": "{}",
    "import.meta.url": JSON.stringify("http://127.0.0.1/fixture.js"),
  },
});
if (!demo.success) throw new Error(demo.logs.map(String).join("\n"));
const setup = `const originalFetch=window.fetch;\n${await demo.outputs[0]!.text()}\nconst demoFetch=window.fetch,DemoSocket=window.WebSocket,DemoEvents=window.EventSource;
window.__stOvisRequests=[];
window.fetch=(input,init)=>{const u=new URL(input instanceof Request?input.url:input,location.href);if(!u.pathname.startsWith('/ovis/api/'))return originalFetch(input,init);window.__stOvisRequests.push(u.pathname);u.pathname=u.pathname.slice(5);if(u.pathname==='/api/medo/catalog')return Promise.resolve(Response.json({projects:[{id:'garden',name:'Garden',path:'/fixtures/garden',folders:[]}],chats:[{id:'00000000-0000-4000-8000-000000000001',title:'Fixture conversation',project:'garden',cwd:'/fixtures/garden',updated:1,archived:false,unavailable:null,folder:null,paneId:${JSON.stringify(panes.web)}}],organizationRevision:1}));if(u.pathname==='/api/medo/open')return Promise.resolve(Response.json({address:${JSON.stringify(panes.web)},reused:true}));return demoFetch(u.href,init);};
window.WebSocket=function(url,protocols){const u=new URL(url,location.href);if(u.pathname==='/ovis/ws')u.pathname='/ws';return new DemoSocket(u.href,protocols);};Object.setPrototypeOf(window.WebSocket,DemoSocket);
window.EventSource=function(url,options){const u=new URL(url,location.href);if(u.pathname.startsWith('/ovis/api/'))u.pathname=u.pathname.slice(5);return new DemoEvents(u.href,options);};Object.setPrototypeOf(window.EventSource,DemoEvents);
`;
const cache = join(homedir(), ".cache/ms-playwright");
const folder = readdirSync(cache)
  .filter((v) => v.startsWith("chromium-"))
  .sort()
  .at(-1);
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.BROWSER_EXECUTABLE ??
    (folder
      ? [
          join(cache, folder, "chrome-linux64/chrome"),
          join(cache, folder, "chrome-linux/chrome"),
        ].find(existsSync)
      : undefined),
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
  });
  page.setDefaultTimeout(15000);
  page.on("response", (r) => {
    if (r.status() >= 400) console.error("HTTP", r.status(), r.url());
  });
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") console.error(m.text());
  });
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.error(e.message);
  });
  await page.addInitScript({ content: setup });
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  );
  const base = `http://127.0.0.1:${server.port}`;
  await page.goto(base);
  await page.getByRole("heading", { name: "Your services" }).waitFor();
  await page.evaluate(() =>
    localStorage.setItem(
      "ovis:settings",
      JSON.stringify({
        theme: "light",
        lightTheme: "amber",
        darkTheme: "codex",
      }),
    ),
  );
  const before = await page.locator(".st-sidebar").evaluate((el) => ({
    bg: getComputedStyle(el).backgroundColor,
    width: el.getBoundingClientRect().width,
  }));
  await page.getByRole("link", { name: "Ovis", exact: true }).click();
  await page
    .getByRole("button", { name: "Fixture conversation", exact: true })
    .click();
  await page.locator(".composer-text:visible").waitFor();
  await page.locator('.st-ovis-root[style*="--bg: #0d1117;"]').waitFor();
  assert.equal(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("ovis:settings")!).theme,
    ),
    "light",
    "Host theme preserves the standalone preference",
  );

  await page
    .locator(".composer-text:visible")
    .fill("Draft stays here until I send it.");
  assert.equal(
    await page.locator("iframe").count(),
    0,
    "Ovis shares the React tree",
  );
  assert.deepEqual(
    await page.locator(".st-sidebar").evaluate((el) => ({
      bg: getComputedStyle(el).backgroundColor,
      width: el.getBoundingClientRect().width,
    })),
    before,
    "Ovis does not restyle ST",
  );
  await page.getByRole("button", { name: "Customize Garden" }).click();
  await page.locator(".st-ovis-root .medo-overlay").waitFor();
  await page.keyboard.press("Escape");
  await page.locator(".medo-overlay").waitFor({ state: "hidden" });
  await page.getByRole("switch", { name: "Workmode", exact: true }).click();
  await page.locator('.st-ovis-root[style*="--bg: #19120e;"]').waitFor();
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.getByRole("heading", { name: "Your services" }).waitFor();
  await page.keyboard.press("Control+k");
  assert.equal(await page.locator(".st-ovis-section:visible").count(), 0);
  await page.getByRole("link", { name: "Ovis", exact: true }).click();
  assert.equal(
    await page.locator(".composer-text:visible").inputValue(),
    "Draft stays here until I send it.",
  );
  assert.match(page.url(), /workmode=1/);
  await page.getByRole("switch", { name: "Workmode", exact: true }).click();
  await page.locator('.st-ovis-root[style*="--bg: #0d1117;"]').waitFor();
  await page.locator(".composer-text:visible").fill("");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".settings-dialog:visible").waitFor();
  await page.locator('[data-settings-page="appearance"]:visible').click();
  await page
    .getByText("S.T. console theme · Colors follow the S.T. sidebar.")
    .waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.locator(".xterm:visible").waitFor();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.locator(".composer-text:visible").waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.getByRole("heading", { name: "Your services" }).waitFor();
  await page.getByRole("link", { name: "Ovis", exact: true }).click();
  await page.locator(".composer-text:visible").waitFor();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Mobile viewport does not overflow",
  );
  assert(
    await page
      .locator(".st-ovis-section")
      .evaluate((el) => el.getBoundingClientRect().bottom <= innerHeight + 1),
    "Ovis fits below the restored mobile navigation",
  );
  const evidence = process.env.ST_V2_EVIDENCE;
  if (evidence)
    await page.screenshot({
      path: evidence.replace(/\.png$/, "-mobile.png"),
      fullPage: true,
    });
  await page.setViewportSize({ width: 1600, height: 1000 });
  if (evidence) await page.screenshot({ path: evidence, fullPage: true });
  assert(
    (
      await page.evaluate(
        () => Reflect.get(window, "__stOvisRequests") as string[],
      )
    ).some((p) => p === "/ovis/api/medo/catalog"),
  );
  assert.deepEqual(errors, []);
  console.log(
    "Native Ovis browser acceptance passed: dual sidebar, chat, scoped modal/styles, draft retention and hidden shortcuts.",
  );
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0];
  if (page) {
    console.error((await page.locator("body").innerText()).slice(-6000));
    await page.screenshot({
      path: join(homedir(), ".cache/st-v2-ovis-failed.png"),
    });
  }
  throw error;
} finally {
  await browser.close();
  server.stop(true);
}

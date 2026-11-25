import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { fixtureApi, ui } from "./v2-fixtures";
import { verifyAgentsShortcuts } from "./agents-shortcuts-browser";
import { armShortcuts } from "./shortcuts-browser";
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
window.__stOvisRequests=[];window.__stMedoState={title:localStorage.getItem('fixture:chat-name')||'Fixture conversation',status:'idle',updated:1,appearance:{sectionColor:'#142a2a',borderColor:'#3b6c60'}};
window.__stCreatedProjects=[];
const shortcutProjects=Array.from({length:10},(_,i)=>({id:i===0?'garden':'project-'+i,name:i===0?'Garden':i===1?'Orchard':'Project '+(i+1),path:'/fixtures/project-'+i,folders:i===0?[{id:'folder',name:'More conversations'}]:[]}));
const fixturePanes=${JSON.stringify(Object.values(panes))};
const shortcutChats=shortcutProjects.flatMap((project,p)=>Array.from({length:p===0?11:3},(_,i)=>({id:p===0&&i===0?'00000000-0000-4000-8000-000000000001':'chat-'+p+'-'+i,title:p===0&&i===0?'Fixture conversation':'Conversation '+(p+1)+'.'+(i+1),project:project.id,cwd:project.path,updated:100-i,archived:false,unavailable:null,folder:p===0&&i>=5?'folder':null,paneId:p===0&&i===0?${JSON.stringify(panes.web)}:fixturePanes[(p+i)%fixturePanes.length]})));
window.fetch=(input,init)=>{const u=new URL(input instanceof Request?input.url:input,location.href);if(!u.pathname.startsWith('/ovis/api/'))return originalFetch(input,init);window.__stOvisRequests.push(u.pathname);u.pathname=u.pathname.slice(5);if(u.pathname==='/api/medo/catalog')return Promise.resolve(Response.json(window.__stExpandedShortcutsFixture?{projects:shortcutProjects,chats:shortcutChats,organizationRevision:1}:{projects:[{id:'garden',name:'Garden',path:'/fixtures/garden',folders:[],appearance:window.__stMedoState.appearance}],chats:[{id:'00000000-0000-4000-8000-000000000001',title:window.__stMedoState.title,project:'garden',cwd:'/fixtures/garden',updated:window.__stMedoState.updated,status:window.__stMedoState.status,archived:false,unavailable:null,folder:null,paneId:${JSON.stringify(panes.web)}}],organizationRevision:1}));if(u.pathname==='/api/medo/rename'){if(window.__stMedoState.renameFail)return Promise.resolve(Response.json({error:{message:'Fixture rename unavailable'}},{status:400}));const title=JSON.parse(init.body).name.trim();window.__stMedoState.title=title;localStorage.setItem('fixture:chat-name',title);return Promise.resolve(Response.json({ok:true,title}));}if(u.pathname==='/api/medo/style'){window.__stMedoState.appearance=JSON.parse(init.body).style;return Promise.resolve(Response.json({ok:true}));}if(u.pathname==='/api/medo/open')return new Promise(resolve=>setTimeout(()=>resolve(Response.json({address:shortcutChats.find(c=>c.id===JSON.parse(init.body).threadId)?.paneId??${JSON.stringify(panes.web)},reused:true})),window.__stOpenDelay??0));if(u.pathname==='/api/medo/new'){window.__stCreatedProjects.push(JSON.parse(init.body).projectId);return Promise.resolve(Response.json({address:${JSON.stringify(panes.web)},reused:true}));}return demoFetch(u.href,init);};
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
  await armShortcuts(page);
  await page.keyboard.press("a");
  await page
    .getByRole("button", { name: "Fixture conversation", exact: true })
    .click();
  await page.locator(".composer-text:visible").waitFor();
  const more = page.locator(".header-more-button:visible");
  await more.click();
  const menu = page.getByRole("menu", { name: "More", exact: true });
  await menu.waitFor();
  // Allow the menu's positioning loop to check the host's right edge repeatedly.
  await page.evaluate(() => new Promise<void>((resolve) => {
    let left = 8;
    const frame = () => { if (--left === 0) resolve(); else requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
  }));
  assert(await menu.isVisible(), "Header More stays open in the embedded viewport");
  const menuBox = (await menu.boundingBox())!;
  const moreBox = (await more.boundingBox())!;
  assert(Math.abs(menuBox.x + menuBox.width - (moreBox.x + moreBox.width)) < 2,
    "Header More aligns with its button in the host viewport");
  if (process.env.ST_V2_EVIDENCE) await page.screenshot({ path: process.env.ST_V2_EVIDENCE.replace(/\.png$/, "-more.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  await more.click();
  await menu.waitFor();
  await page.locator(".composer-text:visible").click();
  await menu.waitFor({ state: "hidden" });
  const conversations = page.locator(".medo-sidebar-head");
  await conversations
    .getByRole("button", { name: "Hide workspace list", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Show workspace list", exact: true })
    .click();
  await conversations.waitFor();
  assert.equal(
    await page.locator(".st-topbar, .st-ovis-root .header-side .brand").count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link")
      .first()
      .innerText(),
    "Agents",
  );
  assert(
    (await conversations.boundingBox())!.y < 4,
    "Conversations starts at the top of the sidebar",
  );

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
  const conversationUrl = page.url();
  await armShortcuts(page);
  await page.keyboard.press("o");
  await page.waitForURL(`${base}/overview`);
  await armShortcuts(page);
  await page.keyboard.press("a");
  await page.waitForURL(conversationUrl);
  assert.equal(
    await page.locator(".composer-text:visible").inputValue(),
    "Draft stays here until I send it.",
    "Navigation consumes its letter and preserves the Agents draft and route",
  );
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
  await page.evaluate(() => Object.assign(Reflect.get(window, "__stMedoState"), { status: "working", updated: 2 }));
  await page.getByRole("button", { name: "Refresh projects", exact: true }).click();
  await page.locator(".medo-chat .medo-spinner").waitFor();
  await page.getByRole("button", { name: "Actions for project Garden", exact: true }).click();
  await page.getByRole("menuitem", { name: "Customize project", exact: true }).click();
  await page.locator(".st-ovis-root .medo-overlay").waitFor();
  // A completion behind a project dialog remains unread until the chat is visible again.
  await page.evaluate(() => {
    Object.assign(Reflect.get(window, "__stMedoState"), { status: "done", updated: 3 });
    window.dispatchEvent(new Event("focus"));
  });
  await page.locator(".medo-chat.is-unread").waitFor();
  await page.locator(".medo-chat .medo-spinner").waitFor({ state: "hidden" });
  assert.equal(await page.locator('.medo-colors input[type="color"]').count(), 4);
  await page.getByLabel("Border color", { exact: true }).fill("#718d62");
  assert.equal(await page.getByLabel("Appearance preview").evaluate((el) => getComputedStyle(el).borderTopColor), "rgb(113, 141, 98)");
  await page.getByRole("button", { name: "Save appearance", exact: true }).click();
  await page.locator(".medo-overlay").waitFor({ state: "hidden" });
  await page.locator(".medo-chat.is-unread").waitFor({ state: "hidden" });
  assert.equal(await page.locator(".medo-project").evaluate((el) => getComputedStyle(el).borderTopColor), "rgb(113, 141, 98)");
  await page.getByRole("button", { name: "Actions for project Garden", exact: true }).click();
  await page.getByRole("menuitem", { name: "Customize project", exact: true }).click();
  await page.locator(".st-ovis-root .medo-overlay").waitFor();
  await page.keyboard.press("Escape");
  await page.locator(".medo-overlay").waitFor({ state: "hidden" });
  await page.getByRole("switch", { name: "Workmode", exact: true }).click();
  await page.locator('.st-ovis-root[style*="--bg: #19120e;"]').waitFor();
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.getByRole("heading", { name: "Your services" }).waitFor();
  await page.keyboard.press("Control+k");
  assert.equal(await page.locator(".st-ovis-section:visible").count(), 0);
  await page.getByRole("link", { name: "Agents", exact: true }).click();
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
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+c");
  assert.equal(
    await page.locator(".st-shortcut-indicator").getAttribute("data-step"),
    "0",
  );
  await armShortcuts(page);
  await page.keyboard.press("o");
  await page.waitForURL(`${base}/overview`);
  await armShortcuts(page);
  await page.keyboard.press("a");
  await page.locator(".xterm:visible").waitFor();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.locator(".composer-text:visible").waitFor();
  await verifyAgentsShortcuts(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.getByRole("heading", { name: "Your services" }).waitFor();
  await page.getByRole("link", { name: "Agents", exact: true }).click();
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
  await page
    .getByRole("button", { name: "Open workspace list", exact: true })
    .click();
  const drawer = page.getByRole("dialog", {
    name: "Workspace list",
    exact: true,
  });
  await drawer.waitFor();
  await drawer
    .locator(".medo-sidebar-head")
    .getByRole("button", { name: "Close workspace list", exact: true })
    .click();
  await drawer.waitFor({ state: "hidden" });
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
  await page.getByRole("button", { name: "Fixture conversation", exact: true }).hover();
  await page.getByRole("button", { name: "Actions for Fixture conversation", exact: true }).click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const rename = page.getByRole("dialog", { name: "Rename conversation", exact: true });
  const name = rename.getByLabel("Conversation name", { exact: true });
  await name.waitFor();
  assert.equal(await name.inputValue(), "Fixture conversation");
  assert(await name.evaluate((el) => document.activeElement === el));
  await name.fill("   ");
  assert(await rename.getByRole("button", { name: "Save name", exact: true }).isDisabled());
  await name.fill("Garden planning");
  await page.evaluate(() => { Reflect.get(window, "__stMedoState").renameFail = true; });
  await name.press("Enter");
  await rename.getByRole("alert").waitFor();
  assert.equal(await name.inputValue(), "Garden planning");
  await page.getByRole("button", { name: "Fixture conversation", exact: true }).waitFor();
  await page.evaluate(() => { Reflect.get(window, "__stMedoState").renameFail = false; });
  await rename.getByRole("button", { name: "Save name", exact: true }).click();
  await rename.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Garden planning", exact: true }).waitFor();
  await page.getByRole("button", { name: "Refresh projects", exact: true }).click();
  await page.getByRole("button", { name: "Actions for Garden planning", exact: true }).click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await name.fill("Discard this name");
  await name.press("Escape");
  await rename.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Garden planning", exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "Native Ovis browser acceptance passed: dual sidebar, chat, scoped modal/styles, draft retention and hidden shortcuts.",
  );
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0];
  if (page) {
    console.error((await page.locator("body").innerText()).slice(-6000));
    await page.screenshot({
      path: "/tmp/st-keyboard-ovis-failed.png",
    });
  }
  throw error;
} finally {
  await browser.close();
  server.stop(true);
}

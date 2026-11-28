import assert from "node:assert/strict";
import type { Browser, Page } from "playwright-core";
import { createGateway } from "../services/web-gateway/gateway";
import panes from "../integrations/ovis/app/site/demo/fixtures/panes.json";

async function picker(page: Page) {
  await page.keyboard.press("Control");
  await page.keyboard.press("Control");
  await page.locator('.st-shortcut-indicator[data-step="2"]').waitFor();
  await page.keyboard.press("e");
  const dialog = page.getByRole("dialog", { name: "Recent conversations and terminals" });
  await dialog.getByRole("option").first().waitFor();
  return dialog;
}

export async function verifySharedRecents(browser: Browser, base: string, setup: string) {
  const gateway = createGateway({ port: 0, publicOrigin: "https://fixture.test", monitorOrigin: base, ovisOrigin: base });
  const endpoint = `http://127.0.0.1:${gateway.port}/api/recent-conversations`;
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  let releaseRead: (() => void) | undefined;
  let readGate: Promise<void> | undefined;
  let readStarted = () => {};
  let failRead = false;
  const pauseReads = () => {
    const started = new Promise<void>((resolve) => { readStarted = resolve; });
    readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    return started;
  };
  const resumeReads = () => { releaseRead?.(); releaseRead = undefined; readGate = undefined; };
  try {
    for (const context of contexts) {
      await context.addInitScript({ content: setup });
      await context.route("**/api/recent-conversations", async (route) => {
        if (route.request().method() === "GET") {
          if (failRead) return route.fulfill({ status: 503, body: "unavailable" });
          if (readGate) { readStarted(); await readGate; }
        }
        const response = await fetch(endpoint, { method: route.request().method(), headers: { "content-type": "application/json" }, body: route.request().postData() ?? undefined });
        await route.fulfill({ status: response.status, contentType: "application/json", body: await response.text() });
      });
    }
    const [a, b] = await Promise.all(contexts.map((context) => context.newPage()));
    const open = async (page: Page, pane: string, view: string) => {
      await page.goto(`${base}/agents?pane=${encodeURIComponent(pane)}&view=${view}`);
      await page.locator(view === "terminal" ? ".xterm:visible" : ".composer-text:visible").waitFor();
      const dialog = await picker(page);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
    };
    await open(a!, panes.web, "terminal");
    await open(b!, panes.flaky, "chat");
    const shared = await (await fetch(endpoint)).json();
    assert.equal(shared.items[0].paneId, panes.flaky);
    assert.equal(shared.items[1].paneId, panes.web);
    let dialog = await picker(a!);
    const firstOrder = await dialog.locator('[role="option"] strong').allTextContents();
    assert.match(await dialog.locator('[aria-selected="true"]').innerText(), /Conversation/);
    await a!.keyboard.press("Escape");
    dialog = await picker(b!);
    // The highlighted row differs by current selection; compare the identities/order.
    assert.deepEqual(await dialog.locator('[role="option"] strong').allTextContents(), firstOrder);
    assert.match(await dialog.locator('[aria-selected="true"]').innerText(), /Terminal/);
    await b!.keyboard.press("Enter");
    await b!.waitForURL((url) => url.searchParams.get("pane") === panes.web && url.searchParams.get("view") === "terminal");
    await b!.locator(".xterm:visible").waitFor();
    await b!.reload();
    await b!.locator(".xterm:visible").waitFor();
    dialog = await picker(b!);
    assert.equal(await dialog.getByRole("option").count(), 2);
    if (process.env.ST_SHORTCUT_EVIDENCE) await b!.screenshot({ path: `${process.env.ST_SHORTCUT_EVIDENCE}-shared-recents.png` });
    await b!.keyboard.press("Escape");
    const started = pauseReads();
    await b!.keyboard.press("Control"); await b!.keyboard.press("Control"); await b!.keyboard.press("e");
    await b!.getByText("Loading recent items…").waitFor();
    await started;
    await b!.keyboard.press("Escape");
    const response = b!.waitForResponse("**/api/recent-conversations");
    resumeReads();
    await response;
    assert.equal(await b!.getByRole("dialog", { name: "Recent conversations and terminals" }).count(), 0);
    // A quick Enter is retained while the authoritative order is being fetched.
    const nextRead = pauseReads();
    await b!.keyboard.press("Control"); await b!.keyboard.press("Control"); await b!.keyboard.press("e");
    await nextRead;
    await b!.keyboard.press("Enter");
    resumeReads();
    await b!.waitForURL((url) => url.searchParams.get("pane") === panes.flaky);
    await b!.locator(".composer-text:visible").waitFor();
    failRead = true;
    dialog = await picker(b!);
    await dialog.getByText(/Couldn’t sync recent items/).waitFor();
    assert.equal(await dialog.getByRole("option").count(), 2);
    console.log("Shared recents: independent contexts, unseen navigation, reload, delayed Enter, cancellation and outage fallback passed");
  } finally {
    releaseRead?.();
    await Promise.all(contexts.map((context) => context.close()));
    gateway.stop(true);
  }
}

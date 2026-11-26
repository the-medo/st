import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import type { Page } from "playwright-core";

export async function verifyAgentActivity(page: Page) {
  const link = page.locator(".st-sidebar .nav-agents");
  const counts = async (working: number, unread: number, attention: number) => {
    await page
      .locator(
        `.st-sidebar .nav-agents[aria-description="${working} working, ${unread} finished and unread, ${attention} need attention"]`,
      )
      .waitFor({ state: "attached" });
  };
  const refresh = () =>
    page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const evidence = process.env.ST_AGENT_ACTIVITY_EVIDENCE;
  if (evidence) await mkdir(evidence, { recursive: true });
  await counts(0, 0, 0);
  assert.equal(
    await link
      .locator(".st-agent-activity [data-status], .st-agent-compact")
      .count(),
    0,
    "Zero counts have no badges",
  );
  assert.equal(
    await page.getByRole("button", { name: "Refresh projects" }).count(),
    0,
    "The status loads without opening Agents or a session",
  );
  await page.evaluate(async () => {
    const catalog = await (await fetch("/agents/api/medo/catalog")).json();
    catalog.chats[0].status = "working";
    catalog.chats.push(
      ...[
        { id: "work-two", status: "working" },
        { id: "work-three", status: "working" },
        { id: "needs-input", status: "blocked" },
        { id: "archived", status: "working", archived: true },
        { id: "completed", status: "blocked", done: true },
      ].map((patch) => ({
        ...catalog.chats[0],
        paneId: undefined,
        title: patch.id,
        ...patch,
      })),
    );
    Reflect.set(window, "__stActivityCatalog", catalog);
    sessionStorage.setItem("fixture:activity-catalog", JSON.stringify(catalog));
  });
  await refresh();
  await counts(3, 0, 1);
  assert.equal(await link.locator('[data-status="unread"]').count(), 0);
  const spinner = link.locator(
    '.st-agent-activity [data-status="working"] svg',
  );
  assert.equal(
    await spinner.evaluate((el) => getComputedStyle(el).animationName),
    "st-agent-spin",
  );
  assert.equal(
    await spinner.evaluate(
      (el) => getComputedStyle(el).animationIterationCount,
    ),
    "infinite",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await spinner.evaluate((el) => getComputedStyle(el).animationName),
    "none",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => {
    const catalog = Reflect.get(window, "__stActivityCatalog");
    catalog.chats[0].status = "idle";
    catalog.chats[0].updated++;
    sessionStorage.setItem("fixture:activity-catalog", JSON.stringify(catalog));
  });
  await refresh();
  await counts(2, 1, 1);
  assert.deepEqual(
    await link.locator(".st-agent-activity b").allTextContents(),
    ["2", "1", "1"],
  );
  if (evidence) await page.screenshot({ path: `${evidence}/expanded.png` });
  await page.reload();
  await counts(2, 1, 1);
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  assert.equal(await link.locator(".st-agent-activity").isVisible(), false);
  assert.equal(
    await link.locator(".st-agent-compact").getAttribute("data-status"),
    "attention",
  );
  assert.equal(await link.locator(".st-agent-compact").innerText(), "1");
  if (evidence) await page.screenshot({ path: `${evidence}/collapsed.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = page.locator(".st-mobile-agents");
  assert.equal(await mobile.locator(".st-agent-compact").innerText(), "1");
  assert.equal(
    await mobile.getAttribute("aria-description"),
    "2 working, 1 finished and unread, 1 need attention",
  );
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  if (evidence) await page.screenshot({ path: `${evidence}/mobile.png` });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await link.click();
  await page
    .getByRole("button", { name: "Fixture conversation", exact: true })
    .click();
  await page.locator(".composer-text:visible").waitFor();
  await counts(2, 0, 1);
  assert.equal(
    await link.locator('.st-agent-activity [data-status="unread"]').count(),
    0,
  );
  await page.evaluate(() => {
    Reflect.get(window, "__stActivityCatalog").chats.find(
      (chat: { id: string }) => chat.id === "needs-input",
    ).done = true;
  });
  await refresh();
  await counts(2, 0, 0);
  assert.equal(
    await link.locator('.st-agent-activity [data-status="attention"]').count(),
    0,
  );
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  assert.equal(
    await link
      .locator(".st-agent-compact svg")
      .evaluate((el) => getComputedStyle(el).animationName),
    "st-agent-spin",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await mobile
      .locator(".st-agent-compact svg")
      .evaluate((el) => getComputedStyle(el).animationName),
    "st-agent-spin",
  );
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await page.evaluate(() => {
    Reflect.get(window, "__stActivityCatalog").chats.find(
      (chat: { id: string }) => chat.id === "needs-input",
    ).done = false;
  });
  await refresh();
  await counts(2, 0, 1);
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.evaluate(() => {
    Reflect.get(window, "__stActivityCatalog").chats[0].status = "working";
  });
  await refresh();
  await counts(3, 0, 1);
  await page.evaluate(() => {
    const chat = Reflect.get(window, "__stActivityCatalog").chats[0];
    chat.status = "done";
    chat.updated++;
  });
  await refresh();
  await counts(2, 1, 1);
  // A retained, hidden conversation must not acknowledge its new answer.
  await refresh();
  await counts(2, 1, 1);
  await link.click();
  await page.locator(".composer-text:visible").waitFor();
  await counts(2, 0, 1);
  await page.evaluate(() =>
    Reflect.set(window, "__stActivityUnavailable", true),
  );
  await refresh();
  await page
    .locator('.nav-agents[aria-description^="Last known agent activity:"]')
    .waitFor();
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await refresh();
  await page
    .locator('.nav-agents[aria-description^="Last known agent activity:"]')
    .waitFor();
  // Restore the normal demo catalog for the rest of Agents acceptance.
  await page.evaluate(() => {
    Reflect.deleteProperty(window, "__stActivityCatalog");
    Reflect.deleteProperty(window, "__stActivityUnavailable");
    sessionStorage.removeItem("fixture:activity-catalog");
  });
  await refresh();
  await counts(0, 0, 0);
  console.log(
    "Agent activity passed: background counts, unread persistence/read receipts, attention, collapse/mobile, and outage recovery.",
  );
}

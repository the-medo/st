import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import panes from "../integrations/ovis/app/site/demo/fixtures/panes.json";
import { armShortcuts } from "./shortcuts-browser";

async function armPage(page: Page) {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control");
  await page.keyboard.press("Control");
  await page.locator('.st-shortcut-indicator[data-step="2"]').waitFor();
}

export async function verifyAgentsShortcuts(page: Page) {
  await page.evaluate(() =>
    Reflect.set(window, "__stExpandedShortcutsFixture", true),
  );
  await page.getByRole("button", { name: "Refresh projects" }).click();
  await page
    .getByRole("button", { name: "Actions for project Orchard" })
    .waitFor();
  await armShortcuts(page);
  await page.keyboard.press("a");
  await page
    .locator('.st-shortcut-indicator[data-scope="agents"][data-step="2"]')
    .waitFor();
  await page.locator('.medo-project-toggle[data-st-shortcut="9"]').waitFor();
  assert.equal(
    await page.locator(".medo-project-toggle[data-st-shortcut]").count(),
    9,
  );
  assert.equal(
    await page.locator(".medo-chat-open[data-st-shortcut]").count(),
    24,
  );
  assert.equal(
    await page
      .locator(
        '.medo-chat-open[data-st-shortcut="E"], .medo-chat-open[data-st-shortcut="Q"]',
      )
      .count(),
    0,
  );
  assert.equal(
    await page
      .locator(".medo-chat-open[data-st-shortcut]")
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-st-shortcut")).join(""),
      ),
    "ABCDFGHIJKLMNOPRSTUVWXYZ",
  );
  if (process.env.ST_SHORTCUT_EVIDENCE) {
    await page.waitForTimeout(200);
    await page.screenshot({
      path: `${process.env.ST_SHORTCUT_EVIDENCE}-agents.png`,
    });
  }
  await page.keyboard.press("c");
  await page.waitForURL((url) => url.searchParams.get("pane") === panes.flaky);
  await page.locator('.st-shortcut-indicator[data-step="0"]').waitFor();
  await armShortcuts(page);
  await page.keyboard.press("a");
  await page.keyboard.press("q");
  await page
    .getByRole("dialog", { name: "New conversation", exact: true })
    .waitFor();
  await page.keyboard.press("Escape");

  // A collapsed project expands, opens its first conversation, then gets its own keys.
  await page.locator('[data-st-project="garden"] .medo-project-toggle').click();
  await armShortcuts(page);
  await page.keyboard.press("a");
  await page.evaluate(() => Reflect.set(window, "__stOpenDelay", 1000));
  await page.keyboard.press("1");
  await page
    .locator(
      '[data-st-project="garden"] .medo-chat-open[aria-busy="true"][data-st-shortcut="1"]',
    )
    .waitFor();
  await page.keyboard.press("1");
  await page
    .locator('.st-shortcut-indicator[data-scope="project"][data-step="2"]')
    .waitFor();
  await page
    .locator('[data-st-project="garden"] .medo-chat-open[aria-busy="true"]')
    .waitFor({ state: "hidden" });
  await page.evaluate(() => Reflect.set(window, "__stOpenDelay", 0));
  await page
    .locator('[data-st-project="garden"][data-st-shortcut-selected="true"]')
    .waitFor();
  await page
    .locator('[data-st-project="garden"] .medo-chat-open[data-st-shortcut="9"]')
    .waitFor();
  assert.equal(
    await page.locator(".medo-chat-open[data-st-shortcut]").count(),
    9,
  );
  assert.equal(
    await page
      .locator('[data-st-project="project-1"] [data-st-shortcut]')
      .count(),
    0,
  );
  await page
    .locator('[data-st-project="garden"] .medo-chat.is-selected')
    .first()
    .waitFor();
  if (process.env.ST_SHORTCUT_EVIDENCE) {
    await page.waitForTimeout(200);
    await page.screenshot({
      path: `${process.env.ST_SHORTCUT_EVIDENCE}-project.png`,
    });
  }
  await page.keyboard.press("o");
  await page.getByRole("menuitem", { name: /Customize/ }).click();
  await page.getByRole("dialog", { name: /Garden/ }).waitFor();
  await page.keyboard.press("Escape");
  await armShortcuts(page);
  await page.keyboard.press("a");
  await page.keyboard.press("2");
  await page
    .locator('[data-st-project="project-1"] [data-st-shortcut="Q"]')
    .waitFor();
  await page.keyboard.press("q");
  assert.deepEqual(
    await page.evaluate(() => Reflect.get(window, "__stCreatedProjects")),
    ["project-1"],
  );
  await page.locator(".composer-text:visible").waitFor();

  // Double Ctrl inside a conversation exposes the sidebar and toolbar together,
  // even if the user collapsed the sidebar. Each key has exactly one target.
  await page
    .locator(".medo-sidebar-head")
    .getByRole("button", { name: "Hide workspace list", exact: true })
    .click();
  await armPage(page);
  await page
    .locator('.st-shortcut-indicator[data-scope="conversation"]')
    .waitFor();
  for (const key of ["T", "Y", "F", "O"])
    await page.locator(`.st-ovis-root [data-st-shortcut="${key}"]`).waitFor();
  await page.locator('.medo-project-toggle[data-st-shortcut="9"]').waitFor();
  assert.equal(
    await page.locator(".medo-project-toggle[data-st-shortcut]").count(),
    9,
  );
  assert.equal(
    await page
      .locator(".medo-chat-open[data-st-shortcut]")
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-st-shortcut")).join(""),
      ),
    "ABCDGHIJKLMNPRSUVWXZ",
  );
  const keys = await page
    .locator(".st-ovis-root [data-st-shortcut]")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-st-shortcut")));
  assert.equal(
    new Set(keys).size,
    keys.length,
    "Sidebar and toolbar never share a shortcut key",
  );
  await page.keyboard.press("c");
  await page.waitForURL((url) => url.searchParams.get("pane") === panes.flaky);
  await page.locator('.st-shortcut-indicator[data-step="0"]').waitFor();
  await armPage(page);
  await page.keyboard.press("1");
  await page
    .locator('[data-st-project="garden"][data-st-shortcut-selected="true"]')
    .waitFor();
  await page.waitForURL((url) => url.searchParams.get("pane") === panes.web);
  await page
    .locator('[data-st-project="garden"] .medo-chat-open[data-st-shortcut="9"]')
    .waitFor();
  await armPage(page);
  await page.keyboard.press("y");
  await page.locator(".xterm:visible").waitFor();
  const terminalUrl = page.url();
  await armPage(page);
  await page.keyboard.press("y");
  await page.locator(".composer-text:visible").waitFor();
  const chatUrl = page.url();
  await armPage(page);
  await page.keyboard.press("e");
  const recent = page.getByRole("dialog", {
    name: "Recent conversations and terminals",
  });
  await recent.waitFor();
  assert.match(
    await recent.locator('[aria-selected="true"] strong').innerText(),
    /Fixture conversation/,
  );
  await recent.locator('[aria-selected="true"] .st-recent-status').waitFor();
  await recent
    .locator('[aria-selected="true"] .agent-mark svg[role="img"]')
    .waitFor();
  assert.match(
    await recent.locator('[aria-selected="true"]').innerText(),
    /Terminal/,
  );
  assert.equal(page.url(), chatUrl, "Cycling does not navigate before Enter");
  const selected = await recent
    .locator('[aria-selected="true"]')
    .getAttribute("id");
  await page.keyboard.press("e");
  await page.keyboard.press("Shift+E");
  assert.equal(
    await recent.locator('[aria-selected="true"]').getAttribute("id"),
    selected,
  );
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  assert.equal(
    await recent.locator('[aria-selected="true"]').getAttribute("id"),
    selected,
  );
  if (process.env.ST_SHORTCUT_EVIDENCE) {
    await page.waitForTimeout(200);
    await page.screenshot({
      path: `${process.env.ST_SHORTCUT_EVIDENCE}-recent.png`,
    });
  }
  await page.keyboard.press("Enter");
  await page.waitForURL(terminalUrl);
  await page.locator(".xterm:visible").waitFor();
  await armPage(page);
  await page.keyboard.press("e");
  await page.keyboard.press("Escape");
  assert.equal(page.url(), terminalUrl);
  await page.locator('.st-shortcut-indicator[data-step="0"]').waitFor();

  await armPage(page);
  await page.keyboard.press("Shift");
  await page.locator('.st-sidebar[data-shortcuts-ready="true"]').waitFor();
  await page.keyboard.press("Escape");
  // Other Ctrl+Shift combinations must not accidentally arm the main sidebar.
  await page.keyboard.press("Control+Shift+p");
  await page.locator('.st-shortcut-indicator[data-step="0"]').waitFor();

  await armPage(page);
  await page.keyboard.press("t");
  await page.waitForURL((url) => url.searchParams.get("pane") !== panes.web);
  assert.equal(
    await page.locator(".tab-strip, .header-tabs-sheet, .context-tabs").count(),
    0,
  );
  await page
    .getByRole("button", { name: "New terminal", exact: true })
    .waitFor();
  await page.locator(".xterm:visible").waitFor();
  await armPage(page);
  await page.keyboard.press("f");
  await page
    .getByRole("button", { name: "Close files", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Close files", exact: true }).click();
  await armPage(page);
  await page.keyboard.press("o");
  await page.getByRole("menu").waitFor();
  const menu = (await page.getByRole("menu").boundingBox())!;
  const host = (await page.locator(".st-ovis-root").boundingBox())!;
  assert(
    menu.x >= host.x && menu.x + menu.width <= host.x + host.width + 1,
    "More menu stays within the embedded Agents viewport",
  );

  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Fixture conversation", exact: true })
    .click();
  await page.locator(".composer-text:visible").waitFor();
  console.log(
    "Agents shortcuts passed: project and conversation numbering, reserved keys, quick add, toolbar, recent chat/terminal cycling, confirmation and cancellation.",
  );
}

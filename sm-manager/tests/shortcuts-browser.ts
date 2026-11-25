import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import {
  CTRL_TAP_WINDOW,
  SHORTCUT_WINDOW,
} from "../frontend/src/app/useSidebarShortcuts";
import { ui } from "./v2-fixtures";

export async function armShortcuts(page: Page) {
  // Router updates can change the address before a lazy screen has committed.
  const path = new URL(page.url()).pathname;
  await page
    .locator(
      `.st-sidebar a[aria-current="page"]:is([href="${path}"], [href^="${path}?"])`,
    )
    .waitFor();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Shift");
  await page.locator('.st-shortcut-indicator[data-step="2"]').waitFor();
}

export async function verifyShortcuts(page: Page, base: string) {
  await page.goto(base);
  await page.getByRole("heading", { name: "Your services" }).waitFor();
  const indicator = page.locator(".st-shortcut-indicator");
  const stage = async (value: number) => {
    await page.waitForFunction(
      (n) =>
        document
          .querySelector(".st-shortcut-indicator")
          ?.getAttribute("data-step") === String(n),
      value,
    );
  };
  assert.equal(await indicator.isVisible(), false);
  assert.equal(await page.locator(".st-shortcut-key:visible").count(), 0);
  await page.keyboard.press("Control");
  await stage(1);
  assert.equal(await page.locator(".st-shortcut-key:visible").count(), 0);
  await page.waitForTimeout(330);
  assert.equal(
    await page
      .locator(".st-shortcut-progress")
      .evaluate((el) => getComputedStyle(el).strokeDashoffset),
    "50px",
  );
  if (process.env.ST_SHORTCUT_EVIDENCE)
    await page.screenshot({
      path: `${process.env.ST_SHORTCUT_EVIDENCE}-half.png`,
    });
  // Start a fresh pair so capturing evidence cannot accidentally expire the tap.
  await page.keyboard.press("Escape");
  await armShortcuts(page);
  await page.waitForTimeout(380);
  assert.equal(
    await page
      .locator(".st-shortcut-progress")
      .evaluate((el) => getComputedStyle(el).strokeDashoffset),
    "0px",
  );
  assert.equal(await page.locator(".st-shortcut-key:visible").count(), 13);
  if (process.env.ST_SHORTCUT_EVIDENCE)
    await page.screenshot({
      path: `${process.env.ST_SHORTCUT_EVIDENCE}-ready.png`,
    });
  await page.keyboard.press("p");
  await page.waitForURL(`${base}/projects`);
  await stage(0);

  for (const [key, path] of Object.entries({
    o: "/overview",
    n: "/containers",
    g: "/github",
    s: "/storage",
    z: "/zed",
    d: "/dbs",
    f: "/faceplate",
    q: "/air-quality",
    t: "/planner/tasks",
    c: "/planner/calendar",
    h: "/",
  })) {
    await armShortcuts(page);
    await page.keyboard.press(key);
    await page.waitForURL(base + path);
  }

  // Page navigation stays armed, omits the current page and exposes its own Q.
  await armShortcuts(page);
  await page.keyboard.press("t");
  const planner = page.frameLocator('iframe[title="ST Planner"]');
  await planner.locator('button[data-st-shortcut="Q"]').waitFor();
  assert.equal(await planner.locator('a[data-st-shortcut="T"]').count(), 0);
  await planner
    .locator("body")
    .evaluate(
      (_el, delay) => Reflect.set(window, "__stDelayNextQuickAdd", delay),
      SHORTCUT_WINDOW + 200,
    );
  for (const [key, path, label] of [
    ["o", "contacts", "New"],
    ["n", "notes", "New note"],
    ["j", "journals", "New journal"],
    ["t", "tasks", "New task"],
  ]) {
    await page.keyboard.press(key!);
    await page.waitForURL(`${base}/planner/${path}`);
    await planner
      .getByRole("button", { name: label, exact: true })
      .and(planner.locator('[data-st-shortcut="Q"]'))
      .waitFor();
    await stage(2);
    await planner.locator('button[data-st-shortcut="Q"]').waitFor();
    await page.keyboard.press("q");
    await planner.getByRole("dialog").waitFor();
    await stage(0);
    await planner.getByRole("button", { name: "Cancel" }).click();
    await page.keyboard.press("Control");
    await page.keyboard.press("Control");
    await page
      .locator('.st-shortcut-indicator[data-scope="planner"][data-step="2"]')
      .waitFor();
  }
  await page.keyboard.press("c");
  await page.waitForURL(`${base}/planner/calendar`);
  await planner
    .locator('.fc-day-today [data-st-calendar-new][data-st-shortcut="Q"]')
    .waitFor();
  await page.keyboard.press("q");
  await planner.getByRole("dialog", { name: "New event today" }).waitFor();
  assert.equal(await planner.locator("[data-st-calendar-new]").count(), 0);
  await planner.getByRole("button", { name: "Cancel" }).click();
  await page.keyboard.press("Control");
  await page.keyboard.press("Control");
  await stage(2);
  await planner.getByRole("button", { name: "New event today" }).click();
  await planner.getByRole("dialog", { name: "New event today" }).waitFor();
  await stage(0);
  await planner.getByRole("button", { name: "Cancel" }).click();
  await page.keyboard.press("Control");
  await page.keyboard.press("Control");
  await stage(2);
  await page.keyboard.press("ArrowLeft");
  await page.locator('.st-sidebar[data-shortcuts-ready="true"]').waitFor();
  await page.keyboard.press("h");
  await page.waitForURL(base + "/");

  // Neither a held Ctrl nor a normal Ctrl combination counts as two taps.
  await page.keyboard.down("Control");
  await page.keyboard.down("Control");
  await stage(0);
  await page.keyboard.up("Control");
  await stage(1);
  await page.keyboard.press("Escape");
  await page.keyboard.down("Control");
  await page.waitForTimeout(CTRL_TAP_WINDOW + 50);
  await page.keyboard.up("Control");
  await stage(0);
  await page.keyboard.press("Control+c");
  await stage(0);
  await page.keyboard.press("Control");
  await stage(1);
  await page.waitForTimeout(CTRL_TAP_WINDOW + 50);
  await stage(0);
  await armShortcuts(page);
  await page.waitForTimeout(SHORTCUT_WINDOW + 50);
  await stage(0);

  for (const cancel of ["Escape", "ArrowRight", "Control+c"]) {
    await armShortcuts(page);
    await page.keyboard.press(cancel);
    await stage(0);
    assert.equal(page.url(), base + "/");
  }
  await armShortcuts(page);
  await page.getByRole("heading", { name: "Your services" }).click();
  await stage(0);
  await armShortcuts(page);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await stage(0);

  await page.getByRole("link", { name: "Tasks", exact: true }).click();
  const input = page
    .frameLocator('iframe[title="ST Planner"]')
    .getByLabel("Task title");
  await input.fill("draft");
  await input.press("End");
  await page.keyboard.press("p");
  assert.equal(await input.inputValue(), "draftp");
  await armShortcuts(page);
  // Unconfigured optional shortcuts pass through, even when the mode is armed.
  await page.keyboard.press("a");
  assert.equal(await input.inputValue(), "draftpa");
  await armShortcuts(page);
  await page.keyboard.press("Control+a");
  assert.equal(
    await input.evaluate((el) => (el as HTMLInputElement).selectionEnd),
    7,
  );
  assert.equal(
    await input.evaluate((el) => (el as HTMLInputElement).selectionStart),
    0,
  );
  await input.press("End");
  await armShortcuts(page);
  await page.keyboard.press("p");
  await page.waitForURL(`${base}/projects`);
  await armShortcuts(page);
  await page.keyboard.press("t");
  await page.waitForURL(`${base}/planner/tasks`);
  assert.equal(
    await input.inputValue(),
    "draftpa",
    "Shortcut letter never enters a planner draft",
  );
  // A document reload preserves WindowProxy identity; listeners must reconnect.
  await page
    .locator('iframe[title="ST Planner"]')
    .evaluate((el) =>
      (el as HTMLIFrameElement).contentWindow!.location.reload(),
    );
  await input.fill("reloaded");
  await armShortcuts(page);
  assert.equal(
    await input.evaluate((el) => {
      const event = new KeyboardEvent("keydown", {
        key: "p",
        code: "KeyP",
        bubbles: true,
        cancelable: true,
        isComposing: true,
      });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    }),
    false,
    "IME composition passes through and cancels the mode",
  );
  await stage(0);
  await page.keyboard.press("ControlRight");
  await page.keyboard.press("ControlRight");
  await stage(2);
  await page.keyboard.press("Shift");
  await page.keyboard.down("t");
  await page.keyboard.down("t");
  await page.keyboard.up("t");
  assert.equal(
    await input.inputValue(),
    "reloaded",
    "Holding a navigation letter never types repeats into the draft",
  );
  await armShortcuts(page);
  await page.keyboard.press("o");
  await page.waitForURL(`${base}/overview`);

  await armShortcuts(page);
  await page.keyboard.press("w");
  await page.waitForURL(`${base}/overview?workmode=1`);
  await armShortcuts(page);
  assert.equal(
    await page.locator('.st-sidebar [data-shortcut="F"]').count(),
    0,
  );
  await page.keyboard.press("q");
  await stage(0);
  assert.equal(page.url(), `${base}/overview?workmode=1`);
  await armShortcuts(page);
  await page.keyboard.press("p");
  await page.waitForURL(`${base}/projects?workmode=1`);
  await armShortcuts(page);
  await page.keyboard.press("w");
  await page.waitForURL(`${base}/projects`);

  for (const width of [900, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await armShortcuts(page);
    assert.equal(await page.locator(".st-shortcut-key:visible").count(), 13);
    assert(
      await page
        .locator(".st-sidebar")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    );
    if (process.env.ST_SHORTCUT_EVIDENCE)
      await page.screenshot({
        path: `${process.env.ST_SHORTCUT_EVIDENCE}-${width}.png`,
      });
    await page.keyboard.press("Escape");
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await armShortcuts(page);
  assert.equal(
    await page
      .locator(".st-shortcut-progress")
      .evaluate((el) => getComputedStyle(el).transitionDuration),
    "0s",
  );
  assert.equal(
    await page
      .locator(".st-shortcut-orb")
      .evaluate((el) => getComputedStyle(el).animationName),
    "none",
  );
  await page.keyboard.press("Escape");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  ui.printer_url = `${base}/printer-shortcut`;
  await page
    .context()
    .route("**/printer-shortcut", (route) =>
      route.fulfill({ body: "Printer fixture" }),
    );
  await page.goto(base);
  await page
    .getByRole("link", { name: "Prusa Connect", exact: true })
    .waitFor();
  await armShortcuts(page);
  const popupPromise = page.waitForEvent("popup");
  await page.keyboard.press("r");
  const popup = await popupPromise;
  await popup.waitForLoadState();
  assert.equal(popup.url(), `${base}/printer-shortcut`);
  assert.equal(await popup.evaluate(() => window.opener), null);
  await popup.close();
  ui.printer_url = null;
  await page.context().unroute("**/printer-shortcut");
  await page.goto(base);
  console.log(
    "Sidebar shortcuts passed: ring stages, navigation, native chords, timing, cancellation, planner focus/reload, drafts, Workmode, responsive keycaps, reduced motion.",
  );
}

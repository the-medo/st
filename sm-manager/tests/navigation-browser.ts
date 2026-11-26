import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import type { Page } from "playwright-core";

export async function verifyNavigation(page: Page, base: string) {
  const rail = page.locator(".st-sidebar");
  const mobile = page.getByRole("navigation", {
    name: "Mobile navigation",
    exact: true,
  });
  const more = mobile.getByRole("button", { name: "More", exact: true });
  const sheet = page.getByRole("dialog", { name: "More to explore" });
  const evidence = process.env.ST_NAVIGATION_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  const screenshot = async (name: string) => {
    if (evidence) await page.screenshot({ path: `${evidence}/${name}.png` });
  };
  await page.goto(base);
  await page.getByRole("heading", { name: "Your services" }).waitFor();
  await screenshot("desktop-expanded");
  const toggle = page.getByRole("button", { name: "Collapse sidebar" });
  // Click the right border away from its visible handle.
  await toggle.click({ position: { x: 6, y: 100 } });
  await page.waitForFunction(
    () =>
      document.querySelector(".st-sidebar")?.getAttribute("data-collapsed") ===
      "true",
  );
  assert.equal((await rail.boundingBox())!.width, 64);
  assert.equal(await rail.locator(".st-sidebar-footer").isVisible(), false);
  assert.equal(await rail.locator(".nav-label").first().isVisible(), false);
  assert.equal(
    await rail.getByRole("link", { name: "Calendar", exact: true }).isVisible(),
    true,
  );
  await rail.getByRole("link", { name: "Projects", exact: true }).click();
  await page.getByPlaceholder("Project, branch, path…").waitFor();
  await page.reload();
  await page.getByPlaceholder("Project, branch, path…").waitFor();
  assert.equal(
    (await rail.boundingBox())!.width,
    64,
    "Collapse preference survives navigation and reload",
  );
  await screenshot("desktop-collapsed");
  await page.keyboard.down("Control");
  await page.keyboard.press("Shift");
  await page.keyboard.up("Control");
  await page.keyboard.press("o");
  await page.waitForURL(`${base}/overview`);
  const expand = page.getByRole("button", { name: "Expand sidebar" });
  await expand.focus();
  await expand.press("Enter");
  assert.equal((await rail.boundingBox())!.width, 174);
  await page.setViewportSize({ width: 900, height: 1000 });
  assert.equal(
    (await rail.boundingBox())!.width,
    174,
    "An explicit expanded preference also works on tablets",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  await mobile.waitFor();
  assert.equal(await rail.isVisible(), false);
  assert.equal(await mobile.locator(":scope > a, :scope > button").count(), 5);
  assert.deepEqual(await mobile.locator(".nav-label").allTextContents(), [
    "Overview",
    "Calendar",
    "Agents",
    "Assistant",
  ]);
  assert.equal(
    await mobile
      .getByRole("link", { name: "Assistant", exact: true })
      .getAttribute("href"),
    "/assistant",
  );
  assert.equal(
    await mobile
      .getByRole("link", { name: "Agents", exact: true })
      .getAttribute("href"),
    "/agents",
  );
  const agentsIcon = await mobile.locator(".nav-herdr-icon").boundingBox();
  const ordinaryIcon = await mobile.locator(".nav-icon").first().boundingBox();
  assert(
    agentsIcon!.width > ordinaryIcon!.width * 2,
    "Herdr is the raised central action",
  );
  await screenshot("mobile-navigation");
  await more.click();
  await sheet.waitFor();
  assert.equal(await more.getAttribute("aria-expanded"), "true");
  await sheet.evaluate((el) =>
    Promise.all(el.getAnimations().map((animation) => animation.finished)),
  );
  await screenshot("mobile-more");
  await sheet.getByRole("button", { name: "Close menu" }).focus();
  await page.keyboard.press("Shift+Tab");
  assert(
    await sheet.evaluate((el) => el.contains(document.activeElement)),
    "Focus stays inside the sheet",
  );
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden" });
  assert(
    await more.evaluate((el) => el === document.activeElement),
    "Closing restores focus to More",
  );
  await more.click();
  await sheet.getByRole("link", { name: "Projects", exact: true }).click();
  await sheet.waitFor({ state: "hidden" });
  await page.getByPlaceholder("Project, branch, path…").waitFor();
  assert.equal(await more.getAttribute("data-active"), "true");
  await more.click();
  await sheet.getByRole("switch", { name: "Workmode" }).click();
  await page.waitForURL(/workmode=1/);
  await sheet.waitFor({ state: "hidden" });
  await more.click();
  assert.equal(
    await sheet.getByRole("link", { name: "Faceplate", exact: true }).count(),
    0,
  );
  await page.keyboard.press("Escape");
  await mobile.getByRole("link", { name: "Calendar", exact: true }).click();
  await page.waitForURL(`${base}/planner/calendar?workmode=1`);
  await page
    .frameLocator('iframe[title="ST Planner"]')
    .getByRole("heading", { name: "Fixture planner" })
    .waitFor();
  const planner = await page.locator(".st-planner-section").boundingBox();
  const dock = await mobile.boundingBox();
  assert(
    planner!.y + planner!.height < dock!.y - 15,
    "Planner stays above the dock and raised Agents button",
  );
  await more.click();
  await page.goBack();
  await sheet.waitFor({ state: "hidden" });
  await more.click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await sheet.waitFor({ state: "hidden" });
  assert.equal(await mobile.isVisible(), false);
  assert.equal(await page.evaluate(() => document.body.style.overflow), "");
  for (const size of [
    { width: 320, height: 568 },
    { width: 667, height: 375 },
  ]) {
    await page.setViewportSize(size);
    await page.goto(base);
    await more.click();
    await sheet.evaluate((el) =>
      Promise.all(el.getAnimations().map((animation) => animation.finished)),
    );
    const bounds = (await sheet.boundingBox())!;
    assert(
      bounds.x >= 0 &&
        bounds.y >= 0 &&
        bounds.x + bounds.width <= size.width &&
        bounds.y + bounds.height <= size.height,
    );
    await sheet
      .getByRole("switch", { name: "Workmode" })
      .scrollIntoViewIfNeeded();
    await page.keyboard.press("Escape");
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "No horizontal overflow on small phones or landscape",
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await more.click();
  await sheet.waitFor();
  await page.mouse.click(8, 8);
  await sheet.waitFor({ state: "hidden" });
  await page.evaluate(() => localStorage.removeItem("st-sidebar-collapsed"));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base);
}

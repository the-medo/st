import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { githubFixture } from "./github-fixture";
import { ui } from "./v2-fixtures";

export async function verifyGitHub(page: Page, base: string) {
  let value = structuredClone(githubFixture);
  let refreshes = 0;
  await page.route("**/api/ui-config", (route) =>
    route.fulfill({ json: { ...ui, ovis: true } }),
  );
  await page.route("**/api/github*", (route) => {
    if (new URL(route.request().url()).searchParams.has("refresh")) refreshes++;
    return route.fulfill({ json: value });
  });
  await page.goto(`${base}/github`);
  await page.getByRole("table", { name: "Current sprint tasks" }).waitFor();
  assert.equal(
    await page.getByRole("link", { name: "Codex", exact: true }).count(),
    0,
  );
  const agents = page.getByRole("link", { name: "Agents", exact: true });
  assert(
    await agents.evaluate((el) => getComputedStyle(el).boxShadow !== "none"),
  );
  assert.equal(
    await page
      .getByRole("table", { name: "Current sprint tasks" })
      .locator("tbody tr")
      .count(),
    3,
  );
  for (const status of ["Done", "Delivered"])
    await page
      .getByRole("link", { name: `${status} sprint task ↗`, exact: true })
      .waitFor();
  assert.equal(
    await page
      .getByRole("link", { name: "Ship feature ↗", exact: true })
      .getAttribute("href"),
    "https://github.com/example/service/pull/42",
  );
  assert.match(
    await page.getByRole("table", { name: "Open pull requests" }).innerText(),
    /Draft[\s\S]*Conflicts[\s\S]*Changes requested[\s\S]*Failure/,
  );
  assert.equal(
    await page.locator("details.github-backlog").getAttribute("open"),
    null,
  );
  await page.locator(".github-backlog summary").click();
  const backlog = page.getByRole("table", { name: "Backlog issues" });
  assert.equal(await backlog.locator("tbody tr").count(), 2);
  assert.doesNotMatch(await backlog.innerText(), /Done|Delivered/);
  await page.getByRole("checkbox", { name: "Assigned to me" }).check();
  assert.equal(await backlog.locator("tbody tr").count(), 1);
  await page.getByRole("checkbox", { name: "Assigned to me" }).uncheck();
  await page
    .getByRole("combobox", { name: "Filter by repository" })
    .selectOption("example/platform");
  assert.equal(await backlog.locator("tbody tr").count(), 1);
  assert.match(await backlog.innerText(), /Backlog improvement/);
  await page
    .getByRole("combobox", { name: "Filter by repository" })
    .selectOption("");
  await page.getByRole("searchbox").fill("Delivered");
  assert.equal(
    await page
      .getByRole("table", { name: "Current sprint tasks" })
      .locator("tbody tr")
      .count(),
    1,
  );
  await page.getByRole("searchbox").fill("");
  await page.getByRole("button", { name: "Refresh GitHub" }).click();
  await page.waitForFunction(
    () =>
      !document
        .querySelector('[aria-label="Refresh GitHub"]')
        ?.hasAttribute("disabled"),
  );
  assert.equal(refreshes, 1);
  for (const workmode of [false, true]) {
    await page.goto(`${base}/github${workmode ? "?workmode=1" : ""}`);
    await page.getByRole("table", { name: "Current sprint tasks" }).waitFor();
    for (const width of [1440, 900, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `GitHub fits ${width}px`,
      );
      assert(await agents.isVisible());
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  if (process.env.ST_GITHUB_EVIDENCE) {
    await page.goto(`${base}/github`);
    await page.getByRole("table", { name: "Current sprint tasks" }).waitFor();
    await page.locator(".github-backlog summary").click();
    await page.screenshot({
      path: process.env.ST_GITHUB_EVIDENCE,
      fullPage: true,
    });
  }
  value.project.error = "GitHub is unavailable. Showing saved work.";
  value.project.stale = true;
  await page.reload();
  await page
    .getByText(/GitHub is unavailable/)
    .first()
    .waitFor();
  assert.equal(
    await page
      .getByRole("table", { name: "Current sprint tasks" })
      .locator("tbody tr")
      .count(),
    3,
  );
  value = structuredClone(githubFixture);
  value.project.data = null;
  value.project.error = "Project access needs read:project.";
  await page.reload();
  await page
    .getByText("Project access needs read:project.", { exact: true })
    .first()
    .waitFor();
  await page.getByRole("table", { name: "Open pull requests" }).waitFor();
  await page.unroute("**/api/github*");
  await page.unroute("**/api/ui-config");
}

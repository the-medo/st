import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import type { History } from "../frontend/src/lib/types";

export function resourceFixture(url: URL): History {
  const entity = url.searchParams.get("entity") || "host";
  const now = Math.floor(Date.now() / 60_000) * 60;
  const base =
    entity === "host"
      ? 8e9
      : entity === "projects"
        ? 3e9
        : entity === "other"
          ? 4e9
          : entity === "codex"
            ? 0
            : 1e9;
  return {
    entity,
    hours: Number(url.searchParams.get("hours") || 24),
    bucket_seconds: 60,
    started_at: now - 86400,
    points: Array.from({ length: 15 }, (_, i) => ({
      timestamp: now - (15 - i) * 60,
      memory_bytes: i === 12 ? null : base + (Math.sin(i / 2) * base) / 5,
      cpu_percent: i === 12 ? null : base / 1e9 + Math.sin(i / 2),
    })).filter((_, i) => i !== 8 && (entity !== "codex" || i === 14)),
  };
}

export async function verifyOverviewCharts(page: Page, base: string) {
  let mode = "normal",
    requests = 0;
  await page.route("**/api/history?*", (route) => {
    requests++;
    const data = resourceFixture(new URL(route.request().url()));
    if (
      mode === "offline" ||
      (mode === "partial" && data.entity === "project:project1")
    )
      return route.fulfill({
        status: 503,
        json: { error: "Fixture unavailable" },
      });
    if (mode === "empty") data.points = [];
    return route.fulfill({ json: data });
  });
  try {
    await page.goto(`${base}/overview`);
    const panel = page.locator(".history-panel").first(),
      plot = panel.locator("svg");
    await plot.waitFor();
    await panel.getByRole("button", { name: "15m", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector(".chart-unit")?.textContent === "15m · memory",
    );
    await plot.waitFor();
    assert.equal(await plot.locator(".chart-grid").count(), 5);
    assert.match(
      (await plot.textContent())!,
      /0.0G[\s\S]*total capacity · zoom to usage/,
    );
    assert.equal(
      await plot.getAttribute("preserveAspectRatio"),
      null,
      "SVG labels use measured pixel dimensions without stretching",
    );
    const dimensions = (await plot.getAttribute("viewBox"))!
      .split(" ")
      .map(Number);
    const box = (await plot.boundingBox())!;
    assert(Math.abs(dimensions[2]! - box.width) <= 1);
    const projectPath = plot.locator('[data-series="project:project1"] path');
    const color = await projectPath.first().getAttribute("stroke");
    assert.equal(
      await projectPath.count(),
      3,
      "Missing and null buckets break the path",
    );
    assert.equal(
      await plot.locator('[data-series="codex"] circle').count(),
      1,
      "An isolated zero sample remains visible",
    );
    assert.equal(
      await plot
        .locator('[data-series="projects"] path')
        .first()
        .getAttribute("stroke-dasharray"),
      "6 4",
    );
    assert.equal(
      await plot
        .locator('[data-series="other"] path')
        .first()
        .getAttribute("stroke-dasharray"),
      "3 4",
    );
    assert.equal(
      await page
        .locator("#allocation .allocation-color")
        .first()
        .evaluate((el) => (el as HTMLElement).style.backgroundColor),
      "rgb(88, 166, 255)",
    );
    assert(await panel.locator(".legend-value").first().innerText());
    await panel
      .getByRole("combobox", { name: "Chart scale" })
      .selectOption("capacity");
    await plot.locator(".chart-capacity line").waitFor({ state: "attached" });
    const beforeMetric = requests;
    await panel.getByRole("button", { name: "CPU", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector(".chart-unit")?.textContent ===
        "15m · machine CPU %",
    );
    assert.equal(
      requests,
      beforeMetric,
      "Both metrics use the existing history response",
    );
    assert.equal(await plot.locator(".chart-capacity").count(), 0);
    assert.match((await plot.textContent())!, /100%/);
    await plot.focus();
    await plot.press("End");
    assert.match(
      await panel.getByRole("tooltip").innerText(),
      /Bucket averages[\s\S]*%/,
    );
    await page.keyboard.press("Escape");
    await panel.getByRole("button", { name: "Memory", exact: true }).click();
    await panel
      .getByRole("combobox", { name: "History source" })
      .selectOption("project:project1");
    await projectPath.first().waitFor();
    assert.equal(
      await projectPath.first().getAttribute("stroke"),
      color,
      "Selecting a project preserves its assigned color",
    );
    await panel
      .getByRole("combobox", { name: "History source" })
      .selectOption("worktree:tree1");
    await plot.locator('[data-series="worktree:tree1"]').waitFor();
    assert.equal(
      await plot
        .locator('[data-series="worktree:tree1"] path')
        .first()
        .getAttribute("stroke"),
      color,
    );
    await panel
      .getByRole("button", { name: "Garden / main", exact: true })
      .click();
    await panel
      .getByText("No series selected. Toggle a legend item to show it.", {
        exact: true,
      })
      .waitFor();
    await panel
      .getByRole("button", { name: "Garden / main", exact: true })
      .click();
    await plot.waitFor();
    await panel
      .getByRole("combobox", { name: "History source" })
      .selectOption("all");
    await projectPath.first().waitFor();
    mode = "partial";
    await panel.getByRole("button", { name: "6h", exact: true }).click();
    await panel.getByText("unavailable", { exact: true }).waitFor();
    assert(
      await panel
        .getByRole("button", { name: "Garden", exact: true })
        .isDisabled(),
    );
    assert.equal(await plot.locator("[data-series]").count(), 4);
    mode = "offline";
    await panel.getByRole("button", { name: "1h", exact: true }).click();
    await panel
      .getByText("History unavailable. Retrying…", { exact: true })
      .waitFor();
    mode = "empty";
    await panel.getByRole("button", { name: "Retry", exact: true }).click();
    await panel
      .getByText("No samples in this range.", { exact: true })
      .waitFor();
    assert.equal(
      await panel.getByText("no samples", { exact: true }).count(),
      5,
    );
    mode = "normal";
    await panel.getByRole("button", { name: "15m", exact: true }).click();
    await plot.waitFor();
    await panel
      .getByRole("combobox", { name: "Chart scale" })
      .selectOption("usage");
    if (process.env.ST_OVERVIEW_EVIDENCE)
      await page.screenshot({
        path: process.env.ST_OVERVIEW_EVIDENCE,
        fullPage: true,
      });
    await page.setViewportSize({ width: 390, height: 844 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "Restored controls and legends fit a phone",
    );
    assert.equal(await plot.locator(".chart-grid").count(), 5);
    await panel.getByRole("button", { name: "30d", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector(".chart-unit")?.textContent === "30d · memory",
    );
    await plot.waitFor();
    assert.match((await plot.textContent())!, /Now/);
  } finally {
    await page.unroute("**/api/history?*");
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
}

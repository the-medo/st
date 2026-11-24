import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import type { AirData } from "../frontend/src/features/air-quality/model";

// Synthetic values cover all scales, peaks, missing buckets and daily coverage.
export function airFixture(url: URL): AirData {
  const now = 1795514400,
    hours = Number(url.searchParams.get("hours") || 6);
  const requested = url.searchParams.get("bucket") || "auto";
  const bucket =
    requested === "auto"
      ? Math.max(60, (hours * 3600) / 60)
      : Number(requested);
  const count = Math.min(60, Math.floor((hours * 3600) / bucket));
  const points = Array.from({ length: count }, (_, i) => ({
    timestamp: now - (count - i) * bucket,
    co2: i === 14 || i === 15 ? null : 800 + Math.sin(i / 7) * 280,
    co2_peak: i === 14 || i === 15 ? null : 1800,
    pm1: 4 + Math.sin(i / 6) * 3,
    pm25: 8 + Math.sin(i / 6) * 5,
    pm25_peak: 22,
    pm4: 12 + Math.sin(i / 6) * 6,
    pm10: 15 + Math.sin(i / 6) * 8,
    pm10_peak: 28,
    voc: 100 + Math.sin(i / 5) * 40,
    nox: 3 + Math.sin(i / 6),
    temperature: 23 + Math.sin(i / 8),
    humidity: 45 + Math.sin(i / 6) * 5,
  }));
  return {
    enabled: true,
    source_url: "https://airq.m5stack.com/001122334455",
    raw_url: "https://ezdata2.m5stack.com/api/v2/001122334455/dataMacByKey/raw",
    now,
    hours,
    bucket_seconds: bucket,
    poll_seconds: 60,
    started_at: now - 86400,
    stale: false,
    error: null,
    latest: points.at(-1)!,
    points,
    daily: {
      pm25: { value: 9, coverage: 0.5, complete: false },
      pm10: { value: 18, coverage: 1, complete: true },
    },
  };
}

export async function verifyAirQuality(page: Page, base: string) {
  let mode:
    | "normal"
    | "failed-range"
    | "offline"
    | "stale"
    | "empty"
    | "missing-gas"
    | "disabled" = "normal";
  await page.route("**/api/air-quality?*", (route) => {
    const url = new URL(route.request().url()),
      data = airFixture(url);
    if (mode === "offline" || (mode === "failed-range" && data.hours === 24))
      return route.fulfill({
        status: 503,
        json: { error: "Fixture unavailable" },
      });
    if (mode === "stale") data.stale = true;
    if (mode === "empty" || mode === "disabled") {
      data.points = [];
      data.latest = null;
    }
    if (mode === "disabled") data.enabled = false;
    if (mode === "missing-gas") {
      data.points = data.points.map((point) => ({
        ...point,
        voc: null,
        nox: null,
      }));
      data.latest = { ...data.latest!, voc: null, nox: null };
    }
    return route.fulfill({ json: data });
  });
  try {
    await page.goto(`${base}/air-quality`);
    await page.locator(".air-card").nth(8).waitFor();
    await page.locator("#air-chart-climate svg").waitFor();
    assert.equal(await page.locator(".air-chart svg").count(), 2);
    const air = page.locator("#air-chart-air"),
      climate = page.locator("#air-chart-climate");
    assert.match(
      await air.innerText(),
      /CO₂ · ppm[\s\S]*PM · µg\/m³[\s\S]*Gas index/,
    );
    assert.equal(await air.locator("[data-reference]").count(), 3);
    const a = (await page.locator("#air-panel-air").boundingBox())!,
      c = (await page.locator("#air-panel-climate").boundingBox())!;
    assert.equal(a.y, c.y, "The two original combined charts are side by side");
    assert(
      Math.abs(
        (await page.locator('[data-air-metric="temperature"]').boundingBox())!
          .x - c.x,
      ) < 1,
      "Climate cards align with their chart",
    );
    assert.match(
      await page.locator('[data-air-metric="pm25"]').innerText(),
      /Collecting daily average[\s\S]*50% of day covered/,
    );
    const path = await air
      .locator('[data-series="co2"] path')
      .last()
      .getAttribute("d");
    assert.equal(
      path!.split("M").length - 1,
      2,
      "Missing readings break the mean path",
    );
    const box = (await air.boundingBox())!;
    await air.hover({ position: { x: box.width - 106, y: 100 } });
    const reading = page.locator('#air-reading-air [data-air-reading="co2"]');
    await reading.waitFor();
    assert.match(
      await reading.innerText(),
      /peak 1,800[\s\S]*Peak · \+300 ppm above[\s\S]*120% of reference \(peak\)/,
    );
    assert.equal(
      await reading
        .locator(".air-reading-percentage")
        .getAttribute("data-tone"),
      "high",
    );
    await page.locator('[data-air-metric="co2"]').click();
    assert(await air.evaluate((el) => el === document.activeElement));
    await air.press("Home");
    const first = await page
      .locator("#air-reading-air .air-reading-time")
      .innerText();
    await air.press("ArrowRight");
    assert.notEqual(
      await page.locator("#air-reading-air .air-reading-time").innerText(),
      first,
    );
    await climate.focus();
    await climate.press("End");
    assert.match(
      await page.locator("#air-reading-climate").innerText(),
      /Temperature[\s\S]*°C[\s\S]*Humidity[\s\S]*%/,
    );

    await page.locator('#air-bucket-air [data-air-bucket="300"]').click();
    await page.locator('#air-range-air [data-air-hours="12"]').click();
    await page.waitForFunction(() =>
      document
        .querySelector("#air-chart-air")
        ?.getAttribute("aria-label")
        ?.includes("12 hours"),
    );
    assert.equal(
      await page.locator("#air-bucket-select-air").inputValue(),
      "300",
      "Valid buckets survive range changes",
    );
    assert.equal(
      await page.locator("#air-range-select-climate").inputValue(),
      "6",
      "Ranges remain independent",
    );
    mode = "failed-range";
    await page.locator('#air-range-air [data-air-hours="24"]').click();
    await page
      .getByText(/Could not load 24h history.*Showing previous 12h history/)
      .waitFor();
    assert.match((await air.getAttribute("aria-label"))!, /12 hours/);
    mode = "normal";
    await page.locator('#air-range-air [data-air-hours="6"]').click();
    await page.waitForFunction(() =>
      document.querySelector("#air-load-air")?.hasAttribute("hidden"),
    );

    await page.locator("#air-fullscreen-air").click();
    await page.waitForFunction(
      () => document.fullscreenElement?.id === "air-panel-air",
    );
    await air.focus();
    await air.press("End");
    assert(await reading.isVisible());
    await page.evaluate(() => document.exitFullscreen());
    await page.waitForFunction(
      () =>
        document
          .querySelector("#air-fullscreen-air")
          ?.getAttribute("aria-pressed") === "false",
    );
    await page.evaluate(() =>
      Object.defineProperty(document, "fullscreenEnabled", {
        configurable: true,
        get: () => false,
      }),
    );
    await page.locator("#air-fullscreen-air").click();
    await page.locator("dialog[open] #air-chart-air").waitFor();
    assert(
      await reading.isVisible(),
      "The fullscreen fallback keeps inspection state",
    );
    await page.keyboard.press("Escape");
    await page.locator("dialog[open]").waitFor({ state: "hidden" });
    assert.equal(
      await page.locator("#air-bucket-select-air").inputValue(),
      "300",
    );
    await page.waitForFunction(
      () => document.activeElement?.id === "air-fullscreen-air",
    );
    await page.locator("#air-fullscreen-air").click();
    await page.locator("dialog[open] #air-fullscreen-air").click();
    await page.locator("dialog[open]").waitFor({ state: "hidden" });
    await page.locator(".air-charts > #air-panel-air").waitFor();

    if (process.env.ST_AIR_EVIDENCE)
      await page.screenshot({
        path: process.env.ST_AIR_EVIDENCE,
        fullPage: true,
      });
    await page.setViewportSize({ width: 900, height: 1000 });
    assert(
      (await climate.boundingBox())!.y > (await air.boundingBox())!.y,
      "Charts stack at the original breakpoint",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "Only the card strip scrolls horizontally on mobile",
    );
    await page.locator("#air-range-select-air").selectOption("720");
    await page.waitForFunction(() =>
      document
        .querySelector("#air-chart-air")
        ?.getAttribute("aria-label")
        ?.includes("720 hours"),
    );
    assert.equal(
      await page.locator("#air-bucket-select-air").inputValue(),
      "auto",
      "Invalid short buckets reset to Auto",
    );
    assert(
      await page
        .locator('#air-bucket-select-air option[value="60"]')
        .isDisabled(),
    );
    await page.locator("#air-range-select-climate").selectOption("1");
    assert(
      await page
        .locator('#air-bucket-select-climate option[value="86400"]')
        .isDisabled(),
    );
    await page
      .getByText("Chart guide & level references", { exact: true })
      .click();
    await page
      .getByText("Particles · daily exposure", { exact: true })
      .waitFor();

    mode = "missing-gas";
    await page.reload();
    await page
      .locator('#air-legend-air [data-air-series="voc"] small')
      .waitFor();
    assert(
      !(await air.innerText()).includes("Gas index"),
      "The optional gas scale disappears when unavailable",
    );
    await air.focus();
    await air.press("End");
    assert.match(
      await page
        .locator('#air-reading-air [data-air-reading="voc"]')
        .innerText(),
      /— index[\s\S]*Unavailable/,
    );
    mode = "stale";
    await page.reload();
    await page.getByText(/Stale · last known reading/).waitFor();
    assert.equal(
      await page.locator('.air-card .air-level[data-tone="neutral"]').count(),
      9,
    );
    mode = "empty";
    await page.reload();
    // The two sections fetch independently; a loading placeholder is not an empty result.
    await page
      .getByText("No readings for this section in this range yet.", {
        exact: true,
      })
      .nth(1)
      .waitFor();
    assert.equal(
      await page
        .getByText("No readings for this section in this range yet.", {
          exact: true,
        })
        .count(),
      2,
    );
    mode = "disabled";
    await page.reload();
    await page.getByText(/Air quality is not configured/).waitFor();
    mode = "offline";
    await page.reload();
    await page
      .getByText("Air quality unavailable. Retrying shortly…", { exact: true })
      .waitFor();
    await page
      .locator(".air-load")
      .filter({ hasText: "Retrying shortly" })
      .nth(1)
      .waitFor();
    assert.equal(
      await page
        .locator(".air-load")
        .filter({ hasText: "Retrying shortly" })
        .count(),
      2,
    );
  } finally {
    await page.unroute("**/api/air-quality?*");
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
}

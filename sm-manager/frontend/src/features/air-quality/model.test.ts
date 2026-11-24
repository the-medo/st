import { describe, expect, test } from "bun:test";
import {
  airBucketAllowed,
  airChartScales,
  airLevel,
  airPercentage,
  airPointStatus,
  type AirData,
} from "./model";

const dailyData = {
  stale: false,
  daily: { pm25: { value: 9, complete: true, coverage: 1 } },
} as AirData;

describe("original Air Quality comparisons", () => {
  test("a historical peak takes priority without changing a covered daily card", () => {
    const status = airPointStatus("pm25", 10, 35);
    expect(status.detail).toBe("Peak · +20 µg/m³ above 15 µg/m³ · 24h ref");
    expect(airPercentage(status)).toMatchObject({
      tone: "high",
      peak: true,
      label: "233.3",
    });
    expect(airLevel("pm25", 35, dailyData, false)).toEqual([
      "good",
      "Daily average below reference",
    ]);
    expect(
      airLevel(
        "pm25",
        35,
        {
          ...dailyData,
          daily: { pm25: { value: 35, coverage: 0.5, complete: false } },
        },
        false,
      ),
    ).toEqual(["neutral", "Collecting daily average"]);
  });
  test("small exceedances remain visible instead of rounding to the reference", () => {
    const status = airPointStatus("co2", 1000.01, null);
    expect(status.detail).toBe("+<1 ppm above 1,000 ppm reminder");
    expect(airPercentage(status)).toMatchObject({
      tone: "high",
      label: ">100",
    });
    expect(airPointStatus("co2", 900, 1800).detail).toBe(
      "Peak · +300 ppm above 1,500 ppm ventilation ref",
    );
  });
  test("humidity uses percentage points and missing gas readings stay neutral", () => {
    expect(airPointStatus("humidity", 25, null).detail).toBe(
      "5 pp below 30% ideal minimum",
    );
    expect(airPointStatus("humidity", 45, 65).detail).toBe(
      "Peak · +5 pp above 60% ceiling",
    );
    expect(airPointStatus("humidity", 60, null).label).toBe("Warning");
    for (const value of [null, undefined, 0, NaN]) {
      expect(airPointStatus("voc", value, null)).toMatchObject({
        tone: "neutral",
        label: "Unavailable",
      });
    }
    expect(airLevel("co2", 2500, { ...dailyData, stale: true }, false)).toEqual(
      ["neutral", "Last known reading"],
    );
    expect(airLevel("co2", 2500, dailyData, true)).toEqual([
      "neutral",
      "Last known reading",
    ]);
  });
  test("scales include peaks and negative temperatures without mixing units", () => {
    const air = airChartScales("air", [
      { timestamp: 1, co2: 800, co2_peak: 2400, pm25: 9 },
    ]);
    expect(air.map((axis) => axis.id)).toEqual(["co2", "particles"]);
    expect(air[0]!.maximum).toBeGreaterThanOrEqual(2400);
    expect(air[1]!.maximum).toBe(50);
    const climate = airChartScales("climate", [
      { timestamp: 1, temperature: -12, humidity: 45 },
    ]);
    expect(climate[0]!.minimum).toBeLessThanOrEqual(-12);
    expect(climate[1]!.minimum).toBe(0);
    expect(climate[1]!.maximum).toBe(100);
  });
  test("bucket availability respects the range and the server's 1440 point limit", () => {
    expect(airBucketAllowed(720, 60)).toBe(false);
    expect(airBucketAllowed(720, 1800)).toBe(true);
    expect(airBucketAllowed(1, 21600)).toBe(false);
    expect(airBucketAllowed(12, 300)).toBe(true);
    expect(airBucketAllowed(720, "auto")).toBe(true);
  });
});

import { expect, test } from "bun:test";
import { sampleAt, segments } from "../components/Chart";
import { safeUrl } from "./api";
test("chart segments preserve missing readings and time gaps", () => {
  const p = [
    { timestamp: 0, value: 1 },
    { timestamp: 10, value: null },
    { timestamp: 20, value: 2 },
    { timestamp: 200, value: 3 },
  ];
  expect(segments(p, 10).map((s) => s.length)).toEqual([1, 1, 1]);
  expect(segments([{ timestamp: 0, value: NaN }], 10)).toEqual([]);
});
test("links reject executable URLs and embedded credentials", () => {
  expect(safeUrl("javascript:alert(1)")).toBeNull();
  expect(safeUrl("https://user:secret@example.com")).toBeNull();
  expect(safeUrl("https://example.com/a")).toBe("https://example.com/a");
});
import { isWorkmode, workScope, workCodex } from "./workmode";
import { snapshot } from "../../../tests/v2-fixtures";
test("Workmode honors explicit off and matches repository ownership without changing source", () => {
  expect(isWorkmode("?workmode=false")).toBe(false);
  expect(isWorkmode("?workmode=on")).toBe(true);
  const work = structuredClone(snapshot);
  work.projects[0]!.info!.repository_url = "https://github.com/ydistri/example";
  const scope = workScope(work);
  expect(scope.projects).toHaveLength(1);
  expect(workScope(snapshot).projects).toHaveLength(0);
  expect(workCodex(work, scope.projects, scope.paths).memory_bytes).toBe(0);
  expect(snapshot.projects[0]!.info!.repository_url).toBe(
    "https://example.test/garden",
  );
});

test("chart tooltips align independent sample times without filling missing buckets", () => {
  const points = [
    { timestamp: 100.02, value: 10 },
    { timestamp: 160.02, value: null },
    { timestamp: 220.02, value: NaN },
    { timestamp: 400.02, value: 0 },
  ];
  expect(sampleAt(points, 100, 60)?.value).toBe(10);
  expect(sampleAt(points, 160, 60)).toBeNull();
  expect(sampleAt(points, 220, 60)).toBeNull();
  expect(sampleAt(points, 310, 60)).toBeNull();
  expect(sampleAt(points, 400, 60)?.value).toBe(0);
  expect(sampleAt([], 100, 60)).toBeNull();
  expect(sampleAt([{ timestamp: NaN, value: 20 }], 100, 60)).toBeNull();
});

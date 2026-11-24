import { expect, test } from "bun:test";
import {
  resourceCeiling,
  historySources,
  projectColors,
} from "./resourceHistory";
import { segments } from "../components/Chart";
import { snapshot } from "../../../tests/v2-fixtures";

test("resource scales retain readable headroom and never clip over-capacity usage", () => {
  expect(resourceCeiling(true, "usage", 32e9, 0)).toBe(64 * 1024 ** 2);
  expect(resourceCeiling(false, "usage", 0, 1.1)).toBe(1.5);
  expect(resourceCeiling(false, "capacity", 0, 120)).toBe(120);
  expect(resourceCeiling(true, "capacity", 32e9, 35e9)).toBe(35e9);
});
test("project colors match worktrees and remain stable when projects are added or reordered", () => {
  const original = historySources(snapshot).find(
    (source) => source.id === "project:project1",
  )!.color;
  expect(
    historySources(snapshot).find((source) => source.id === "worktree:tree1")!
      .color,
  ).toBe(original);
  const changed = structuredClone(snapshot);
  changed.projects.unshift({
    ...changed.projects[0]!,
    name: "AAA new project",
    id: "new-project",
    worktrees: [],
  });
  expect(projectColors(changed.projects).get("project1")).toBe(original);
  changed.projects.reverse();
  expect(
    historySources(changed).find((source) => source.id === "project:project1")!
      .color,
  ).toBe(original);
});
test("resource traces break at a missing bucket while preserving isolated zero samples", () => {
  expect(
    segments(
      [
        { timestamp: 0, value: 0 },
        { timestamp: 120, value: 2 },
      ],
      60,
      1.5,
    ),
  ).toHaveLength(2);
});

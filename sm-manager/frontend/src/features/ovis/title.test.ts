import { expect, test } from "bun:test";
import { agentsPageTitle } from "./title";
test("Agents titles use conversation names and hide raw session identifiers", () => {
  expect(agentsPageTitle("Ovis")).toBe("Agents");
  expect(agentsPageTitle("Garden plan · Ovis")).toBe("Garden plan");
  expect(agentsPageTitle("Ovis · Ovis")).toBe("Ovis");
  expect(agentsPageTitle("00000000-0000-4000-8000-000000000099 · Ovis")).toBe(
    "Agents",
  );
  expect(agentsPageTitle("w1:p2 · Ovis")).toBe("Agents");
});

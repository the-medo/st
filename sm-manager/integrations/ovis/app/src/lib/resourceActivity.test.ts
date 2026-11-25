import { expect, test } from "bun:test";
import { usedResources } from "./resourceActivity.ts";
import type { ConversationPart, ConversationTurn } from "../../shared/protocol.ts";
const page = (parts: ConversationPart[]): ConversationTurn[] => [{ role: "assistant", ts: null, parts }];
const call = (status: string): ConversationPart => ({ kind: "tool", name: "search", summary: "search", input: "", output: "", call_id: "call-1", mcp: { server: "docs", tool: "search", status } });

test("counts explicit MCP calls once and keeps their latest state", () => {
  const used = usedResources(page([call("inProgress"), call("failed"), { kind: "text", text: "Used mcp__secret__search" }]));
  expect(used.servers).toHaveLength(1);
  expect(used.servers[0]).toMatchObject({ name: "docs", calls: 1, failed: 1, pending: 0 });
});
test("keeps skill paths distinct, latest evidence, and no prose inference", () => {
  const used = usedResources(page([
    { kind: "skill", skill: { name: "review", path: "/one/SKILL.md", evidence: "instructions", status: "requested" } },
    { kind: "skill", skill: { name: "review", path: "/two/SKILL.md", evidence: "instructions", status: "loaded" } },
    { kind: "skill", skill: { name: "review", path: "/one/SKILL.md", evidence: "instructions", status: "failed" } },
    { kind: "text", text: "Available skills: deploy" },
  ]));
  expect(used.skills.map(skill => skill.status)).toEqual(["failed", "loaded"]);
  expect(usedResources([])).toEqual({ skills: [], servers: [] });
});

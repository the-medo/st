import { expect, test } from "bun:test";
import type { MedoActivity, MedoChat } from "../../../../integrations/ovis/app/shared/medo";
import { observeMedoChats } from "../../../../integrations/ovis/app/src/lib/medoReadState";
import { agentActivityLabel, countAgentActivity } from "./activity";

const activity = (patch: Partial<MedoActivity> = {}): MedoActivity => ({ revision: 1, completionId: 'turn', unread: false, status: 'idle', ...patch });
const chat = (id: string, status = 'idle', patch: Partial<MedoChat> = {}): MedoChat => ({
  id, status, title: id, project: "fixture", cwd: "/fixture", updated: 1,
  archived: false, unavailable: null, folder: null, activity: activity({ status }), ...patch,
});

test("counts active work and input requests once, excluding archived and user-completed conversations", () => {
  const chats = [
    chat("work", "working"), chat("input", "blocked"), chat("read"),
    chat("waiting", "waiting"), chat("unknown", "unknown"),
    chat("archived", "working", { archived: true }), chat("complete", "blocked", { done: true }),
  ];
  expect(countAgentActivity(chats, new Map())).toEqual({ working: 1, attention: 1, unread: 0 });
});

test("navigation uses the same server receipts and status as the list even with stale catalogues", () => {
  const chats = [chat("one", "done", { activity: activity({ unread: true, status: 'done' }) }),
    chat("two", "done", { activity: activity({ unread: true, status: 'done' }) })];
  const unread = observeMedoChats(new Map(), chats);
  expect(countAgentActivity(chats, unread)).toEqual({ working: 0, attention: 0, unread: 2 });
  const read = observeMedoChats(unread, [chat("one", "idle", { activity: activity({ revision: 2 }) })]);
  expect(countAgentActivity(chats, read)).toEqual({ working: 0, attention: 0, unread: 1 });
  const working = observeMedoChats(read, [chat("two", "working", { activity: activity({ revision: 2, status: 'working' }) })]);
  expect(countAgentActivity(chats, working)).toEqual({ working: 1, attention: 0, unread: 0 });
  // A fresh catalogue is already authoritative on its first render, before effects merge it.
  expect(countAgentActivity([chat("one", "done", { activity: activity({ revision: 3, unread: true, status: 'done' }) })], read).unread).toBe(1);
});

test("metadata changes and terminal reopening cannot make historical conversations unread", () => {
  const saved = [chat("saved", "idle", { unavailable: "Terminal ended" })];
  const baseline = observeMedoChats(new Map(), saved);
  const next = [chat("saved", "done", { updated: 9999 })];
  expect(countAgentActivity(next, observeMedoChats(baseline, next)).unread).toBe(0);
});

test("loading and unavailable activity never imply there is no work", () => {
  expect(agentActivityLabel(null, false)).toBe("Checking agent activity");
  expect(agentActivityLabel(null, true)).toBe("Agent status unavailable");
  expect(agentActivityLabel({ working: 2, unread: 1, attention: 3 }, true)).toBe(
    "Last known agent activity: 2 working, 1 finished and unread, 3 need attention. Status updates unavailable.",
  );
});

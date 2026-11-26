import { expect, test } from "bun:test";
import type { MedoChat } from "../../../../integrations/ovis/app/shared/medo";
import { observeMedoChats } from "../../../../integrations/ovis/app/src/lib/medoReadState";
import { agentActivityLabel, countAgentActivity } from "./activity";

const chat = (
  id: string,
  status?: string,
  patch: Partial<MedoChat> = {},
): MedoChat => ({
  id,
  status,
  title: id,
  project: "fixture",
  cwd: "/fixture",
  updated: 1,
  archived: false,
  unavailable: null,
  folder: null,
  ...patch,
});

test("counts active work and input requests once, excluding archived and user-completed conversations", () => {
  const chats = [
    chat("work", "working"),
    chat("input", "blocked"),
    chat("read", "idle"),
    chat("waiting", "waiting"),
    chat("unknown", "unknown"),
    chat("archived", "working", { archived: true }),
    chat("complete", "blocked", { done: true }),
  ];
  expect(countAgentActivity(chats, new Map())).toEqual({
    working: 1,
    attention: 1,
    unread: 0,
  });
});

test("a completed turn is counted only until its conversation is read", () => {
  const working = [chat("one", "working"), chat("two", "working")];
  const before = observeMedoChats(new Map(), working, null);
  const finished = [chat("one", "idle"), chat("two", "done", { updated: 2 })];
  const unread = observeMedoChats(before, finished, null);
  expect(countAgentActivity(finished, unread)).toEqual({
    working: 0,
    attention: 0,
    unread: 2,
  });
  expect(
    countAgentActivity(finished, observeMedoChats(unread, finished, "one")),
  ).toEqual({ working: 0, attention: 0, unread: 1 });
  expect(countAgentActivity(working, unread)).toEqual({
    working: 2,
    attention: 0,
    unread: 0,
  });
  expect(countAgentActivity([chat("one", "blocked")], unread)).toEqual({
    working: 0,
    attention: 1,
    unread: 0,
  });
});

test("saved updates count as unread without treating every historical conversation as new", () => {
  const saved = [chat("saved", undefined, { unavailable: "Terminal ended" })];
  const baseline = observeMedoChats(new Map(), saved, null);
  expect(countAgentActivity(saved, baseline).unread).toBe(0);
  const next = [
    chat("saved", undefined, { updated: 2, unavailable: "Terminal ended" }),
  ];
  expect(
    countAgentActivity(next, observeMedoChats(baseline, next, null)).unread,
  ).toBe(1);
});

test("loading and unavailable activity never imply there is no work", () => {
  expect(agentActivityLabel(null, false)).toBe("Checking agent activity");
  expect(agentActivityLabel(null, true)).toBe("Agent status unavailable");
  expect(
    agentActivityLabel({ working: 2, unread: 1, attention: 3 }, true),
  ).toBe(
    "Last known agent activity: 2 working, 1 finished and unread, 3 need attention. Status updates unavailable.",
  );
});

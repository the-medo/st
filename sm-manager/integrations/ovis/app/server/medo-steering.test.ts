import { afterEach, expect, it } from "bun:test";
import { captureMedoSteering } from "./medo-steering.ts";

const previous = process.env["MEDO_PROJECTS"];
afterEach(() => {
  if (previous === undefined) delete process.env["MEDO_PROJECTS"];
  else process.env["MEDO_PROJECTS"] = previous;
});

const user = (id: string, text = "follow up") => ({ id, role: "user", text });
const history = (items = [user("original")], thread = "thread", turn = "turn") => ({
  thread: { id: thread }, turns: [{ id: turn, status: "inProgress", items }],
});

it("confirms a new user item inside the running turn, even when it repeats the first message", async () => {
  process.env["MEDO_PROJECTS"] = "1";
  let data = history();
  const payloads: Record<string, unknown>[] = [];
  const confirmed = await captureMedoSteering("t1", "follow up", async (payload) => { payloads.push(payload); return data; });
  expect(await confirmed?.()).toBe(false);
  data = history([user("original"), user("steering")]);
  expect(await confirmed?.()).toBe(true);
  expect(payloads.every((p) => p.operation === "conversation" && p.paneId === "t1")).toBe(true);
});

it("never confirms from old messages, assistant text, another message, thread or turn", async () => {
  process.env["MEDO_PROJECTS"] = "1";
  let data = history();
  const confirmed = await captureMedoSteering("t1", "follow up", async () => data);
  for (const next of [history(), history([{ ...user("new"), role: "assistant" }]),
    history([user("new", "different text")]), history([user("new")], "other-thread"),
    history([user("new")], "thread", "other-turn"), history([user("")])]) {
    data = next;
    expect(await confirmed?.()).toBe(false);
  }
});

it("leaves unavailable history unconfirmed and retries a later read without sending anything", async () => {
  process.env["MEDO_PROJECTS"] = "1";
  let fail = false;
  let data = history();
  const confirmed = await captureMedoSteering("t1", "follow up", async () => {
    if (fail) throw new Error("unavailable");
    return data;
  });
  fail = true;
  expect(await confirmed?.()).toBe(false);
  fail = false;
  data = history([user("new")]);
  expect(await confirmed?.()).toBe(true);
  expect(await captureMedoSteering("t1", "follow up", async () => null)).toBeUndefined();
  expect(await captureMedoSteering("t1", "follow up", async () => { throw new Error("unavailable"); })).toBeUndefined();
});

it("does not read a managed conversation outside ST or without an active turn", async () => {
  delete process.env["MEDO_PROJECTS"];
  expect(await captureMedoSteering("t1", "follow up", async () => { throw new Error("must not read"); })).toBeUndefined();
  process.env["MEDO_PROJECTS"] = "1";
  expect(await captureMedoSteering("t1", "follow up", async () => ({ ...history(), turns: [] }))).toBeUndefined();
});

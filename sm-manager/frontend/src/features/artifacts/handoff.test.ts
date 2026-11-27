import { expect, test } from "bun:test";
import {
  ComposerDraftStore,
  composerDraftKey,
} from "../../../../integrations/ovis/app/src/lib/composerDraft";
import { appendArtifactDraft } from "./handoff";

test("artifact handoff preserves a newer draft from another tab and stays agent-only", async () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
  const store = new ComposerDraftStore(
    () => storage,
    () => {},
    () => undefined,
  );
  const otherTab = new ComposerDraftStore(
    () => storage,
    () => {},
    () => undefined,
  );
  const key = composerDraftKey("fixture-artifact-chat");
  store.set(key, "An earlier draft");
  otherTab.set(key, "The latest unsent request");
  await appendArtifactDraft(key, "Improve artifact 123", store);
  expect(store.read(key)).toEqual({
    text: "The latest unsent request\n\nImprove artifact 123",
    sending: false,
  });
  expect(store.isAgentOnly(key)).toBe(true);
  otherTab.refresh(key);
  expect(otherTab.read(key).text).toBe(store.read(key).text);
  expect(otherTab.isAgentOnly(key)).toBe(true);
  otherTab.begin(key);
  await expect(
    appendArtifactDraft(key, "Should remain unsent", store),
  ).rejects.toThrow("sending a message");
  expect(store.read(key).text).not.toContain("Should remain unsent");
  otherTab.end(key);
});

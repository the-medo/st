import {
  composerDrafts,
  type ComposerDraftStore,
} from "../../../../integrations/ovis/app/src/lib/composerDraft";

export async function appendArtifactDraft(
  key: string,
  text: string,
  store: ComposerDraftStore = composerDrafts,
) {
  const append = () => {
    store.refresh(key);
    if (store.read(key).sending)
      throw new Error(
        "This conversation is sending a message. Wait and retry.",
      );
    store.markAgentOnly(key);
    store.set(key, (previous) => (previous ? previous + "\n\n" + text : text));
  };
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (locks) await locks.request(`ovis-send:${key}`, append);
  else append();
}

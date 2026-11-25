import { describe, expect, test } from "bun:test";
import { createAgentsShortcuts } from "./shortcuts";
import type { MedoCatalog } from "../../../../integrations/ovis/app/shared/medo";
import type { HostShortcutSelection } from "../../../../integrations/ovis/app/src/lib/hostShortcuts";

const thread = "00000000-0000-4000-8000-000000000001";
const catalog: MedoCatalog = {
  projects: [
    { id: "garden", name: "Garden", path: "/fixtures/garden", folders: [] },
  ],
  chats: [
    {
      id: thread,
      title: "Water the seedlings",
      project: "garden",
      cwd: "/fixtures/garden",
      updated: 1,
      archived: false,
      unavailable: null,
      folder: null,
      paneId: "w1:p1",
    },
  ],
  organizationRevision: 1,
};
const selection: HostShortcutSelection = {
  machineId: "local",
  paneId: "w1:p1",
  view: "chat",
  title: thread,
  workspace: "w1",
  open() {},
};
const pane = {
  machineId: "local",
  paneId: "w1:p1",
  title: thread,
  agent: "codex",
  status: "working",
  ended: false,
};

describe("recent conversation metadata", () => {
  test("resolves titles and project names from the catalogue, with live status and agent", () => {
    const store = createAgentsShortcuts(() => true);
    store.host.selection(selection);
    expect(store.details(store.recent()[0]!).title).toBe(
      "Untitled conversation",
    );
    store.host.catalog(catalog, () => {});
    store.host.panes([pane], ["local"]);
    expect(store.details(store.recent()[0]!)).toMatchObject({
      title: "Water the seedlings",
      workspace: "Garden",
      agent: "codex",
      status: "working",
    });
    store.host.selection({
      ...selection,
      paneId: "w1:p2",
      title: "Another conversation",
    });
    const order = store.recent().map((item) => item.id);
    store.host.panes([{ ...pane, status: "done" }], ["local"]);
    expect(store.recent().map((item) => item.id)).toEqual(order);
    expect(store.details(store.recent()[1]!).status).toBe("finished");
    store.host.catalog(
      {
        ...catalog,
        chats: [{ ...catalog.chats[0]!, title: "Renamed seedlings" }],
      },
      () => {},
    );
    expect(store.details(store.recent()[1]!).title).toBe("Renamed seedlings");
  });

  test("an ended pane keeps its named history and opens the saved page", () => {
    const opened: unknown[] = [];
    const store = createAgentsShortcuts(() => true);
    store.host.catalog(catalog, (...args) => opened.push(args));
    store.host.panes([pane], ["local"]);
    store.host.selection(selection);
    const frozen = store.recent()[0]!;
    store.host.panes([], ["local"]);
    store.host.catalog(
      { ...catalog, chats: [{ ...catalog.chats[0]!, paneId: undefined }] },
      (...args) => opened.push(args),
    );
    const item = store.details(frozen);
    expect(item).toMatchObject({
      title: "Water the seedlings",
      status: "ended",
      agent: "codex",
      available: true,
    });
    item.open();
    expect(opened).toEqual([[thread, true]]);
  });

  test("disconnection is not an ended terminal; ended shell without history is unavailable", () => {
    const store = createAgentsShortcuts(() => true);
    store.host.selection({
      ...selection,
      title: "Server logs",
      view: "terminal",
    });
    store.host.panes([], []);
    expect(store.details(store.recent()[0]!).status).toBe("disconnected");
    store.host.panes([], ["local"]);
    expect(store.details(store.recent()[0]!)).toMatchObject({
      status: "ended",
      available: false,
    });
  });

  test("hidden background updates do not count as visits", () => {
    const store = createAgentsShortcuts(() => false);
    store.host.selection(selection);
    store.host.catalog(catalog, () => {});
    expect(store.recent()).toEqual([]);
  });
});

test("remembered thread identity survives loss of the pane binding and saved pages show live status", () => {
  const store = createAgentsShortcuts(() => true);
  store.host.catalog(catalog, () => {});
  store.host.panes([pane], ["local"]);
  store.host.selection(selection);
  const firstId = store.recent()[0]!.id;
  store.host.catalog(
    { ...catalog, chats: [{ ...catalog.chats[0]!, paneId: undefined }] },
    () => {},
  );
  store.host.selection(selection);
  expect(store.recent()).toHaveLength(1);
  expect(store.recent()[0]!.id).toBe(firstId);
  expect(store.details(store.recent()[0]!).title).toBe("Water the seedlings");
  store.host.catalog(catalog, () => {});
  store.host.selection({
    ...selection,
    paneId: `medo:${thread}`,
    threadId: thread,
    saved: true,
  });
  expect(store.recent()).toHaveLength(1);
  expect(store.details(store.recent()[0]!).status).toBe("working");
});

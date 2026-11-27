import { describe, expect, test } from "bun:test";
import { createAgentsShortcuts } from "./shortcuts";
import type { MedoCatalog } from "../../../../integrations/ovis/app/shared/medo";
import type { HostShortcutSelection } from "../../../../integrations/ovis/app/src/lib/hostShortcuts";
import { RecentHistory } from "../../../../services/web-gateway/recent-history";
import type { RecentTarget } from "../../../../packages/recent-conversations";

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

test("independent windows load shared order and open an unvisited terminal in the correct view", async () => {
  const history = new RecentHistory();
  const api = { read: async () => history.list(), visit: async (item: RecentTarget) => history.visit(item) };
  const first = createAgentsShortcuts(() => true, api), second = createAgentsShortcuts(() => true, api);
  const opened: unknown[] = [];
  try {
    second.host.targets?.((...args) => opened.push(args));
    first.host.catalog(catalog, () => {});
    first.host.selection({ ...selection, view: "terminal" });
    await first.refresh();
    second.host.selection({ ...selection, paneId: "w1:p2" });
    await second.refresh();
    await first.refresh();
    expect(first.recent().map((item) => item.id)).toEqual(second.recent().map((item) => item.id));
    second.host.panes([pane], ["local"]);
    second.details(second.recent()[1]!).open();
    expect(opened).toEqual([["local", "w1:p1", "terminal"]]);
    const reloaded = createAgentsShortcuts(() => true, api);
    await reloaded.refresh();
    expect(reloaded.recent().map((item) => item.id)).toEqual(first.recent().map((item) => item.id));
    const order = history.list();
    first.host.catalog({ ...catalog, chats: [{ ...catalog.chats[0]!, title: "New title" }] }, () => {});
    first.host.selection({ ...selection, view: "terminal", title: "New title" });
    await first.refresh();
    expect(history.list()).toEqual(order);
  } finally { history.close(); }
});

test("a delayed read cannot erase a newer selection and writes preserve click order", async () => {
  const history = new RecentHistory();
  let finishRead!: (items: RecentTarget[]) => void;
  const store = createAgentsShortcuts(() => true, {
    read: () => new Promise((resolve) => { finishRead = resolve; }),
    visit: async (item) => history.visit(item),
  });
  const refresh = store.refresh();
  await Promise.resolve();
  store.host.selection(selection);
  store.host.selection({ ...selection, paneId: "second" });
  finishRead([]);
  await refresh;
  expect(store.recent()[0]?.paneId).toBe("second");
  // The next read waits until both queued visits reach the backend.
  const final = store.refresh();
  while (history.list().length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  finishRead(history.list());
  await final;
  expect(store.recent().map((item) => item.paneId)).toEqual(["second", selection.paneId]);
  history.close();
});

test("failed sync keeps a usable local list, and hidden selections never write visits", async () => {
  let visits = 0, active = false;
  const store = createAgentsShortcuts(() => active, {
    read: async () => [],
    visit: async () => { visits++; throw new Error("offline"); },
  });
  store.host.selection(selection);
  await store.refresh();
  expect(visits).toBe(0);
  active = true;
  store.host.selection({ ...selection, paneId: "second" });
  expect(await store.refresh()).toBe(false);
  expect(store.recent()[0]?.paneId).toBe("second");
});

test("shared history resolves moved panes in the recorded view and ended threads as saved conversations", async () => {
  const target: RecentTarget = { ...selection, threadId: thread, view: "terminal" };
  const store = createAgentsShortcuts(() => true, { read: async () => [target], visit: async () => [] });
  const opened: unknown[] = [];
  store.host.targets?.((...args) => opened.push(args));
  store.host.catalog({ ...catalog, chats: [{ ...catalog.chats[0]!, paneId: "new-pane" }] }, (...args) => opened.push(args));
  store.host.panes([{ ...pane, paneId: "new-pane" }], ["local"]);
  await store.refresh();
  expect(store.details(store.recent()[0]!).status).toBe("working");
  store.details(store.recent()[0]!).open();
  expect(opened).toEqual([["local", "new-pane", "terminal"]]);
  store.host.panes([], ["local"]);
  store.host.catalog({ ...catalog, chats: [{ ...catalog.chats[0]!, paneId: undefined }] }, (...args) => opened.push(args));
  store.details(store.recent()[0]!).open();
  expect(opened[1]).toEqual([thread, true]);
});

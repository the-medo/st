import type { MedoCatalog } from "../../../../integrations/ovis/app/shared/medo";
import { recentKey, sameRecent, RECENT_LIMIT, type RecentTarget } from "../../../../packages/recent-conversations";
import { recentHistoryApi, type RecentHistoryApi } from "./recentHistory";
import type {
  HostShortcuts,
  HostShortcutSelection,
  HostShortcutPane,
} from "../../../../integrations/ovis/app/src/lib/hostShortcuts";

export type RecentConversation = HostShortcutSelection & { id: string };
export type RecentStatus =
  | "working"
  | "blocked"
  | "finished"
  | "running"
  | "ended"
  | "disconnected"
  | "archived"
  | "unknown";
export const recentStatusLabels: Record<RecentStatus, string> = {
  working: "Working",
  blocked: "Needs input",
  finished: "Finished",
  running: "Running",
  ended: "Terminal ended",
  disconnected: "Disconnected",
  archived: "Archived",
  unknown: "Status unknown",
};
const readableTitle = (title: string) =>
  title.trim() &&
  !/^(?:medo:)?[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
    title.trim(),
  );

// Metadata changes never reorder the picker. Only a visit changes recency.
export function createAgentsShortcuts(
  isActive = () => location.pathname.startsWith("/agents") && document.visibilityState === "visible",
  api?: RecentHistoryApi,
) {
  let current: RecentConversation | null = null;
  let recent: RecentConversation[] = [];
  let catalog: MedoCatalog | null = null;
  let catalogState: {
    data: MedoCatalog;
    at: number;
    unavailable: boolean;
  } | null = null;
  let panes: HostShortcutPane[] = [];
  let connectedMachines: string[] = [];
  let openChat: ((threadId: string, saved: boolean) => void) | null = null;
  let selectProject: ((id: string) => void) | null = null;
  let openTarget: ((machineId: string, paneId: string, view: "chat" | "terminal") => void) | null = null;
  // Serialize this window's writes and reads. Never send a whole cached list back.
  let pending = Promise.resolve();
  let syncFailed = false;
  let visitVersion = 0;
  let revision = 0;
  const listeners = new Set<() => void>();
  const changed = () => {
    revision++;
    listeners.forEach((listener) => listener());
  };
  const chatFor = (item: HostShortcutSelection) =>
    item.machineId === "local"
      ? catalog?.chats.find(
          (chat) =>
            chat.id === item.threadId ||
            chat.paneId === item.paneId ||
            `medo:${chat.id}` === item.paneId,
        )
      : undefined;
  const remember = (item: RecentConversation): RecentConversation => {
    const previous = recent.find(
      (entry) =>
        entry.machineId === item.machineId &&
        entry.paneId === item.paneId &&
        entry.view === item.view,
    );
    const chat = chatFor(item);
    const pane = panes.find(
      (pane) =>
        pane.machineId === item.machineId && pane.paneId === item.paneId,
    );
    return {
      ...item,
      threadId: chat?.id ?? item.threadId ?? previous?.threadId,
      agent:
        pane?.agent ?? item.agent ?? previous?.agent ?? (chat ? "codex" : null),
    };
  };
  const hydrate = (items: RecentTarget[]) => {
    recent = items.map((item) => remember({
      ...item, id: recentKey(item),
      open: () => openTarget?.(item.machineId, item.paneId, item.view),
    }));
    changed();
  };
  const persist = (item: RecentConversation) => {
    if (!api) return;
    const { open: _open, id: _id, ...target } = item;
    const version = ++visitVersion;
    pending = pending.then(async () => {
      try {
        const items = await api.visit(target);
        syncFailed = false;
        if (version === visitVersion) hydrate(items);
      } catch { syncFailed = true; }
    });
  };
  const refresh = () => {
    const version = visitVersion;
    const result = pending.then(async () => {
      if (api) {
        try {
          const items = await api.read();
          // Don't overwrite a newer local visit while its POST is queued.
          if (version === visitVersion && !syncFailed) hydrate(items);
          // A failed write means this window still has an unsaved visit.
        } catch { return false; }
      }
      return !syncFailed;
    });
    pending = result.then(() => {});
    return result;
  };
  const details = (entry: RecentConversation) => {
    const item = recent.find((candidate) => sameRecent(candidate, entry)) ?? entry;
    const chat = chatFor(item);
    const pane = panes.find(
      (pane) =>
        pane.machineId === item.machineId &&
        (pane.paneId === item.paneId ||
          pane.paneId === chat?.paneId),
    );
    const draft =
      item.machineId === "local"
        ? catalog?.drafts?.find((draft) => draft.address === item.paneId)
        : undefined;
    const project = catalog?.projects.find(
      (project) => project.id === (chat?.project ?? draft?.project),
    );
    const agent = pane?.agent ?? item.agent ?? (chat ? "codex" : null);
    const ended =
      pane?.ended ||
      !!chat?.unavailable ||
      (!pane && connectedMachines.includes(item.machineId));
    const rawStatus = pane?.status ?? chat?.status;
    const status: RecentStatus = chat?.archived
      ? "archived"
      : ended
        ? "ended"
        : !connectedMachines.includes(item.machineId)
          ? "disconnected"
          : rawStatus === "working"
            ? "working"
            : rawStatus === "blocked"
              ? "blocked"
              : agent
                ? rawStatus === "done" || rawStatus === "idle"
                  ? "finished"
                  : "unknown"
                : "running";
    const title = chat?.title || draft?.title || pane?.title || item.title;
    return {
      ...item,
      threadId: chat?.id ?? item.threadId,
      agent,
      status,
      title:
        readableTitle(title) && title !== item.paneId
          ? title
          : item.view === "chat"
            ? "Untitled conversation"
            : "Terminal",
      workspace: project?.name ?? item.workspace,
      available: !ended || !!chat,
      open: () => {
        if (chat && (ended || (chat.paneId && chat.paneId !== item.paneId))) {
          if (!ended && chat.paneId && openTarget) openTarget(item.machineId, chat.paneId, item.view);
          else openChat?.(chat.id, !!ended);
        } else if (item.saved && item.threadId) openChat?.(item.threadId, true);
        else if (!ended) item.open();
      },
    };
  };
  const host: HostShortcuts = {
    selection(selection) {
      if (!selection) {
        current = null;
        return;
      }
      const next = remember({ ...selection, id: "" });
      const id = recentKey(next);
      const matches = (item: RecentConversation) =>
        sameRecent(item, next);
      const same = current !== null && matches(current);
      current = { ...next, id: same ? current!.id : id };
      if (isActive()) {
        if (same)
          recent = recent.map((item) => (matches(item) ? current! : item));
        else {
          recent = [current, ...recent.filter((item) => !matches(item))].slice(
            0,
            RECENT_LIMIT,
          );
          persist(current);
        }
        changed();
      }
    },
    targets(open) { openTarget = open; },
    projects(select) {
      selectProject = select;
    },
    catalog(next, open, unavailable = false) {
      openChat = open;
      if (catalog === next && catalogState?.unavailable === unavailable) return;
      catalogState = {
        data: next,
        at: catalog === next ? catalogState!.at : Date.now(),
        unavailable,
      };
      catalog = next;
      recent = recent.map(remember);
      if (current) current = remember(current);
      changed();
    },
    panes(next, connected) {
      panes = next;
      connectedMachines = connected;
      recent = recent.map(remember);
      changed();
    },
  };
  return {
    host,
    selection: () => current,
    catalog: () => catalogState,
    recent: () => recent,
    refresh,
    details,
    selectProject: (id: string) => selectProject?.(id),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => revision,
  };
}
const store = createAgentsShortcuts(undefined, recentHistoryApi);
export const agentsShortcuts = store.host;
export const agentsSelection = store.selection;
export const recentConversations = store.recent;
export const recentDetails = store.details;
export const subscribeRecent = store.subscribe;
export const recentRevision = store.snapshot;
export const refreshRecentConversations = store.refresh;
export const selectAgentsProject = store.selectProject;

export const agentsCatalog = store.catalog;

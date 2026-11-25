import type { MedoCatalog } from "../../../../integrations/ovis/app/shared/medo";
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
  isActive = () => location.pathname.startsWith("/ovis"),
) {
  let current: RecentConversation | null = null;
  let recent: RecentConversation[] = [];
  let catalog: MedoCatalog | null = null;
  let panes: HostShortcutPane[] = [];
  let connectedMachines: string[] = [];
  let openChat: ((threadId: string, saved: boolean) => void) | null = null;
  let selectProject: ((id: string) => void) | null = null;
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
  const details = (entry: RecentConversation) => {
    const item = recent.find((candidate) => candidate.id === entry.id) ?? entry;
    const chat = chatFor(item);
    const pane = panes.find(
      (pane) =>
        pane.machineId === item.machineId &&
        (pane.paneId === item.paneId ||
          (item.saved && pane.paneId === chat?.paneId)),
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
        if (chat && (ended || (chat.paneId && chat.paneId !== item.paneId)))
          openChat?.(chat.id, !!ended);
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
      const id = JSON.stringify([
        next.machineId,
        next.threadId ?? next.paneId,
        next.view,
      ]);
      const matches = (item: RecentConversation) =>
        item.machineId === next.machineId &&
        item.view === next.view &&
        (item.id === id ||
          (!!next.threadId && item.threadId === next.threadId));
      const same = current !== null && matches(current);
      current = { ...next, id: same ? current!.id : id };
      if (isActive()) {
        if (same)
          recent = recent.map((item) => (matches(item) ? current! : item));
        else
          recent = [current, ...recent.filter((item) => !matches(item))].slice(
            0,
            30,
          );
        changed();
      }
    },
    projects(select) {
      selectProject = select;
    },
    catalog(next, open) {
      openChat = open;
      if (catalog === next) return;
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
    recent: () => recent,
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
const store = createAgentsShortcuts();
export const agentsShortcuts = store.host;
export const agentsSelection = store.selection;
export const recentConversations = store.recent;
export const recentDetails = store.details;
export const subscribeRecent = store.subscribe;
export const recentRevision = store.snapshot;
export const selectAgentsProject = store.selectProject;

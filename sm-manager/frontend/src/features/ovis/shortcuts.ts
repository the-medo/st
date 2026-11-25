import type {
  HostShortcuts,
  HostShortcutSelection,
} from "../../../../integrations/ovis/app/src/lib/hostShortcuts";

export type RecentConversation = HostShortcutSelection & { id: string };
let current: RecentConversation | null = null;
let recent: RecentConversation[] = [];
let selectProject: ((id: string) => void) | null = null;
export const agentsShortcuts: HostShortcuts = {
  selection(selection) {
    if (!selection) {
      current = null;
      return;
    }
    const id = JSON.stringify([
      selection.machineId,
      selection.paneId,
      selection.view,
    ]);
    current = { ...selection, id };
    // The mounted Agents tree also updates while hidden. Only visits count.
    if (location.pathname.startsWith("/ovis")) {
      recent = [current, ...recent.filter((item) => item.id !== id)].slice(
        0,
        30,
      );
    }
  },
  projects(select) {
    selectProject = select;
  },
};
export const agentsSelection = () => current;
export const recentConversations = () => recent;
export const selectAgentsProject = (id: string) => selectProject?.(id);

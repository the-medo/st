import type { MedoCatalog } from '../../shared/medo.ts';

/** Optional host integration; standalone Ovis keeps its own shortcut system. */
export interface HostShortcutSelection {
  machineId: string;
  paneId: string;
  threadId?: string;
  view: 'chat' | 'terminal';
  title: string;
  workspace: string;
  agent?: string | null;
  saved?: boolean;
  open: () => void;
}

export interface HostShortcutPane {
  machineId: string;
  paneId: string;
  title: string;
  agent: string | null;
  status: string;
  ended: boolean;
}

export interface HostShortcuts {
  selection: (selection: HostShortcutSelection | null) => void;
  projects: (select: ((id: string) => void) | null) => void;
  catalog: (catalog: MedoCatalog, open: (threadId: string, saved: boolean) => void, unavailable?: boolean) => void;
  panes: (panes: HostShortcutPane[], connectedMachines: string[]) => void;
}

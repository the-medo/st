/** Optional host integration; standalone Ovis keeps its own shortcut system. */
export interface HostShortcutSelection {
  machineId: string;
  paneId: string;
  view: 'chat' | 'terminal';
  title: string;
  workspace: string;
  open: () => void;
}

export interface HostShortcuts {
  selection: (selection: HostShortcutSelection | null) => void;
  projects: (select: ((id: string) => void) | null) => void;
}

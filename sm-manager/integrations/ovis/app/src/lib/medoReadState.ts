import { useEffect, useState, useSyncExternalStore } from 'react';
import type { MedoChat } from '../../shared/medo.ts';

export const MEDO_READ_KEY = 'ovis:project-chat-activity:v1';
interface Activity { updated: number; working: boolean; unread: boolean }
export type MedoReadState = ReadonlyMap<string, Activity>;

export function parseMedoReadState(value: string | null): MedoReadState {
  try {
    const entries: unknown = JSON.parse(value ?? '[]');
    if (!Array.isArray(entries)) return new Map();
    return new Map(entries.filter((entry): entry is [string, Activity] => {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') return false;
      const state = entry[1];
      return state && typeof state === 'object' && Number.isFinite(state.updated)
        && typeof state.working === 'boolean' && typeof state.unread === 'boolean';
    }));
  } catch { return new Map(); }
}

/** Seed existing history quietly; track subsequent changes even across browser restarts. */
export function observeMedoChats(previous: MedoReadState, chats: readonly MedoChat[], visibleId: string | null): MedoReadState {
  const next = new Map<string, Activity>();
  let changed = previous.size !== chats.length;
  for (const chat of chats) {
    const before = previous.get(chat.id);
    const working = chat.status === 'working';
    const finished = before?.working && (chat.status === 'idle' || chat.status === 'done');
    const updated = Math.max(before?.updated ?? 0, chat.updated);
    const unread = chat.id === visibleId ? false
      : Boolean(before && (before.unread || finished || chat.updated > before.updated));
    if (!before || before.updated !== updated || before.working !== working || before.unread !== unread) changed = true;
    next.set(chat.id, { updated, working, unread });
  }
  return changed ? next : previous;
}

function load(): MedoReadState {
  try { return parseMedoReadState(window.localStorage.getItem(MEDO_READ_KEY)); }
  catch { return new Map(); }
}

// The host navigation and the conversation list must share one read receipt.
// In-memory subscribers also work when browser storage is unavailable.
let current: MedoReadState | undefined;
const listeners = new Set<() => void>();
export const medoReadSnapshot = (): MedoReadState => current ??= load();
const notify = () => listeners.forEach((listener) => listener());
const storageChanged = (event: StorageEvent) => {
  if (event.key !== MEDO_READ_KEY && event.key !== null) return;
  current = load();
  notify();
};
export function subscribeMedoReadState(listener: () => void): () => void {
  if (!listeners.size) window.addEventListener('storage', storageChanged);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener('storage', storageChanged);
  };
}
export function observeSharedMedoChats(chats: readonly MedoChat[], visibleId: string | null): void {
  const previous = medoReadSnapshot();
  const next = observeMedoChats(previous, chats, visibleId);
  if (next === previous) return;
  current = next;
  try { window.localStorage.setItem(MEDO_READ_KEY, JSON.stringify([...next])); }
  catch { /* Private storage may be unavailable; activity still works for this visit. */ }
  notify();
}
export function useMedoReadSnapshot(): MedoReadState {
  return useSyncExternalStore(subscribeMedoReadState, medoReadSnapshot);
}

export function useMedoReadState(chats: readonly MedoChat[] | undefined, selectedPaneId: string | null, covered: boolean, readerId?: string): MedoReadState {
  const state = useMedoReadSnapshot();
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    const visibility = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, []);
  useEffect(() => {
    // While this view is hidden, the host observes its fresh background catalog.
    // A retained conversation list must not overwrite it with its old snapshot.
    if (!chats || !visible) return;
    const visibleId = readerId ?? (!covered ? chats.find((chat) => chat.paneId === selectedPaneId)?.id ?? null : null);
    observeSharedMedoChats(chats, visibleId);
  }, [chats, selectedPaneId, visible, covered, readerId]);
  return state;
}

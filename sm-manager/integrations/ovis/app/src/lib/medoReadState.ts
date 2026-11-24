import { useEffect, useState } from 'react';
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

export function useMedoReadState(chats: readonly MedoChat[] | undefined, selectedPaneId: string | null, covered: boolean, readerId?: string): MedoReadState {
  const [state, setState] = useState(load);
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    const visibility = () => setVisible(document.visibilityState === 'visible');
    const storage = (event: StorageEvent) => { if (event.key === MEDO_READ_KEY || event.key === null) setState(load()); };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('storage', storage);
    return () => { document.removeEventListener('visibilitychange', visibility); window.removeEventListener('storage', storage); };
  }, []);
  useEffect(() => {
    if (!chats) return;
    const visibleId = visible ? readerId ?? (!covered ? chats.find((chat) => chat.paneId === selectedPaneId)?.id ?? null : null) : null;
    setState((previous) => observeMedoChats(previous, chats, visibleId));
  }, [chats, selectedPaneId, visible, covered, readerId]);
  useEffect(() => {
    if (!state.size) return;
    try {
      const value = JSON.stringify([...state]);
      if (window.localStorage.getItem(MEDO_READ_KEY) !== value) window.localStorage.setItem(MEDO_READ_KEY, value);
    } catch { /* Private storage may be unavailable; activity still works for this visit. */ }
  }, [state]);
  return state;
}

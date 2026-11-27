import { useEffect, useSyncExternalStore } from 'react';
import type { MedoActivity, MedoChat, MedoReadReceipt } from '../../shared/medo.ts';
import type { ConversationTurn } from '../../shared/protocol.ts';
import { paneCovered } from './panePresentation.ts';

export type MedoReadState = ReadonlyMap<string, MedoActivity>;
export const MEDO_READ_EVENT = 'st-conversation-read';

export function medoActivityOf(chat: Pick<MedoChat, 'id' | 'activity'>, read: MedoReadState): MedoActivity | undefined {
  const held = read.get(chat.id);
  return chat.activity && (!held || chat.activity.revision > held.revision) ? chat.activity : held ?? chat.activity;
}

/** Only server revisions can advance activity. Metadata timestamps and localStorage are not receipts. */
export function observeMedoChats(previous: MedoReadState, chats: readonly Pick<MedoChat, 'id' | 'activity'>[]): MedoReadState {
  let next: Map<string, MedoActivity> | undefined;
  for (const chat of chats) {
    const incoming = chat.activity;
    if (!incoming || !Number.isSafeInteger(incoming.revision) || incoming.revision <= 0) continue;
    const before = (next ?? previous).get(chat.id);
    if (before && before.revision >= incoming.revision) continue;
    next ??= new Map(previous);
    next.set(chat.id, incoming);
  }
  return next ?? previous;
}

// An in-memory projection of the server, shared by the list, navigation and app badge.
// Old tabs may still write their v1 browser key; those writes have no authority here.
let current: MedoReadState = new Map();
const listeners = new Set<() => void>();
export const medoReadSnapshot = (): MedoReadState => current;
export function subscribeMedoReadState(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function observeSharedMedoChats(chats: readonly Pick<MedoChat, 'id' | 'activity'>[]): void {
  const next = observeMedoChats(current, chats);
  if (next === current) return;
  current = next;
  listeners.forEach(listener => listener());
}
export function useMedoReadSnapshot(): MedoReadState {
  return useSyncExternalStore(subscribeMedoReadState, medoReadSnapshot);
}

/** A loaded native final answer identifies exactly the turn actually presented. */
export function medoCompletionPresentation(historyId: string | undefined, turns: readonly ConversationTurn[]): string | undefined {
  const last = turns.at(-1);
  if (!historyId?.startsWith('medo:') || last?.role !== 'assistant' || !last.turn_id
    || !last.parts.some(part => part.kind === 'text' && (part.phase === 'final_answer' || part.failed))) return undefined;
  return JSON.stringify([historyId.slice(5), last.turn_id]);
}

const pending = new Set<string>();
const retryAt = new Map<string, number>();
async function acknowledge(threadId: string, completionId: string): Promise<void> {
  const key = JSON.stringify([threadId, completionId]);
  if (pending.has(key) || (retryAt.get(key) ?? 0) > Date.now()) return;
  pending.add(key);
  try {
    const response = await fetch('/api/medo/read-completion', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId, completionId }), signal: AbortSignal.timeout(15_000), cache: 'no-store',
    });
    if (!response.ok) throw new Error(`Read receipt failed (${response.status})`);
    const receipt: MedoReadReceipt = await response.json();
    observeSharedMedoChats([{ id: receipt.threadId, activity: receipt.activity }]);
    retryAt.delete(key);
    window.dispatchEvent(new Event(MEDO_READ_EVENT));
  } catch {
    // Keep the unread indication until it is saved. Retry while the answer is still visible.
    retryAt.set(key, Date.now() + 5_000);
  } finally { pending.delete(key); }
}

export function useMedoReadState(chats: readonly MedoChat[] | undefined, selectedPaneId: string | null, covered: boolean, readerId?: string): MedoReadState {
  const state = useMedoReadSnapshot();
  useEffect(() => { if (chats) observeSharedMedoChats(chats); }, [chats]);
  useEffect(() => {
    if (!chats) return;
    const inspect = () => {
      if (document.visibilityState !== 'visible' || covered || paneCovered()) return;
      const chat = chats.find(chat => readerId ? chat.id === readerId : chat.paneId === selectedPaneId);
      if (!chat) return;
      const activity = medoActivityOf(chat, medoReadSnapshot());
      if (!activity?.unread || !activity.completionId) return;
      const proof = JSON.stringify([chat.id, activity.completionId]);
      const presented = [...document.querySelectorAll('[data-medo-read]')].some(node =>
        node.getAttribute('data-medo-read') === proof && !node.closest('[hidden],[inert],[aria-hidden="true"],.is-hidden'));
      if (presented) void acknowledge(chat.id, activity.completionId);
    };
    const observer = new MutationObserver(inspect);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['data-medo-read', 'hidden', 'inert', 'aria-hidden', 'open', 'aria-modal'] });
    const timer = setInterval(inspect, 5_000);
    document.addEventListener('visibilitychange', inspect);
    window.addEventListener('online', inspect);
    inspect();
    return () => {
      observer.disconnect(); clearInterval(timer);
      document.removeEventListener('visibilitychange', inspect);
      window.removeEventListener('online', inspect);
    };
  }, [chats, selectedPaneId, covered, readerId, state]);
  return state;
}

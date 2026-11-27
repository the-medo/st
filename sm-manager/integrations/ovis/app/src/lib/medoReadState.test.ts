import { expect, it } from 'bun:test';
import type { MedoActivity, MedoChat } from '../../shared/medo.ts';
import { medoCompletionPresentation, observeMedoChats } from './medoReadState.ts';

const activity = (patch: Partial<MedoActivity> = {}): MedoActivity => ({ revision: 1, completionId: 'turn', unread: false, status: 'idle', ...patch });
const chat = (patch: Partial<MedoChat> = {}): MedoChat => ({ id: 'thread', title: 'Fix sidebar', project: 'st', cwd: '/fixture', updated: 10, archived: false, unavailable: null, folder: null, paneId: 'pane', status: 'idle', activity: activity(), ...patch });

it('takes server state on a fresh device without consulting the browser or metadata timestamps', () => {
  const unread = chat({ activity: activity({ unread: true, status: 'done' }) });
  expect(observeMedoChats(new Map(), [unread]).get('thread')?.unread).toBe(true);
  const read = observeMedoChats(new Map(), [chat()]);
  expect(observeMedoChats(read, [chat({ updated: 9999, title: 'Renamed', status: 'done' })])).toBe(read);
  expect(observeMedoChats(read, [chat({ updated: 9 })])).toBe(read);
});

it('a delayed catalogue cannot undo a newer receipt from another device', () => {
  const unread = chat({ activity: activity({ revision: 2, unread: true, status: 'done' }) });
  const before = observeMedoChats(new Map(), [unread]);
  const read = observeMedoChats(before, [chat({ activity: activity({ revision: 3 }) })]);
  expect(observeMedoChats(read, [unread])).toBe(read);
  expect(observeMedoChats(read, [chat({ activity: activity({ revision: 4, completionId: 'next', unread: true, status: 'done' }) })]).get('thread')?.unread).toBe(true);
});

it('status advances only on server revision and a partial catalogue does not erase receipts', () => {
  const first = observeMedoChats(new Map(), [chat(), chat({ id: 'other' })]);
  const next = observeMedoChats(first, [chat({ activity: activity({ revision: 2, status: 'working' }) })]);
  expect(next.get('thread')?.status).toBe('working');
  expect(next.get('other')?.unread).toBe(false);
  expect(observeMedoChats(next, [chat({ activity: undefined })])).toBe(next);
  for (const revision of [0, NaN, 1.5]) expect(observeMedoChats(next, [chat({ activity: activity({ revision }) })])).toBe(next);
});

it('a read names the native final turn actually loaded, never a user prompt or stale answer', () => {
  const final = { role: 'assistant' as const, ts: null, turn_id: 'turn-b', parts: [{ kind: 'text' as const, phase: 'final_answer' as const, text: 'Finished.' }] };
  expect(medoCompletionPresentation('medo:thread', [final])).toBe('["thread","turn-b"]');
  expect(medoCompletionPresentation('other:thread', [final])).toBeUndefined();
  expect(medoCompletionPresentation('medo:thread', [{ ...final, turn_id: undefined }])).toBeUndefined();
  expect(medoCompletionPresentation('medo:thread', [{ ...final, role: 'user' }])).toBeUndefined();
  expect(medoCompletionPresentation('medo:thread', [{ ...final, parts: [{ kind: 'text', text: 'Still thinking', phase: 'commentary' }] }])).toBeUndefined();
  expect(medoCompletionPresentation('medo:thread', [{ ...final, parts: [{ kind: 'text', text: 'Failed', failed: true }] }])).toBe('["thread","turn-b"]');
});

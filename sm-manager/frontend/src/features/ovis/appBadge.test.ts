import { expect, test } from 'bun:test';
import { createAppBadge } from './appBadge';

test('sets the unread count, clears zero, and preserves it when disconnected', async () => {
  const values: number[] = [];
  const badge = createAppBadge({ setAppBadge: async n => { values.push(n); }, clearAppBadge: async () => { values.push(0); } });
  await badge(1); await badge(2); await badge(2); await badge(null); await badge(0);
  expect(values).toEqual([1, 2, 0]);
});

test('serializes a delayed set followed by a newer clear', async () => {
  const values: number[] = [];
  let finish!: () => void;
  const badge = createAppBadge({
    setAppBadge: async n => { await new Promise<void>(resolve => { finish = resolve; }); values.push(n); },
    clearAppBadge: async () => { values.push(0); },
  });
  const first = badge(3);
  const second = badge(0);
  finish();
  await Promise.all([first, second]);
  expect(values).toEqual([3, 0]);
});

test('unsupported platforms and rejected permission do not break activity; later updates can retry', async () => {
  await createAppBadge({})(4);
  let calls = 0;
  const badge = createAppBadge({ setAppBadge: async () => { if (++calls === 1) throw new Error('denied'); } });
  await badge(1); await badge(1); await badge(0);
  expect(calls).toBe(3);
});

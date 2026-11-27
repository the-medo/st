import { expect, test } from 'bun:test';
import type { MedoProviderOption } from '../../shared/medo.ts';
import type { ProviderUsage, UsageReport } from '../../shared/usage.ts';
import { weeklyRemaining } from './medoProviders.ts';
import { savedConversation, withSavedConversation } from './savedConversation.ts';

const option: MedoProviderOption = { id: 'codex', label: 'Codex', installed: true, usageKey: 'codex:active', error: null, models: [] };
const account = (key: string, used: number): ProviderUsage => ({ id: 'codex', key, account: null, plan: null, problem: null, checked_at: '2026-11-27T12:00:00Z',
  windows: [{ kind: 'week', scope: null, used_percent: used, resets_at: null, starts_at: null }] });

test('weekly badge uses the launched account and overall week, not another account, model or session', () => {
  const active = account('codex:active', 27.2);
  const report: UsageReport = { providers: [account('codex:other', 1), { ...active, windows: [
    { ...active.windows[0]!, kind: 'session', used_percent: 99 }, { ...active.windows[0]!, scope: 'Sonnet', used_percent: 7 }, ...active.windows,
  ] }] };
  expect(weeklyRemaining(option, report).percent).toBe(73);
  expect(weeklyRemaining({ ...option, usageKey: null }, report).percent).toBeNull();
  expect(weeklyRemaining(option, { providers: [account('codex:active', 100)] }).percent).toBe(0);
});

test('missing, stale, failed and expired limits never masquerade as unused quota', () => {
  const active = account('codex:active', 20);
  for (const report of [null, { providers: [] }, { providers: [{ ...active, problem: 'expired' as const }] },
    { providers: [{ ...active, windows: [] }] },
    { providers: [{ ...active, recorded: { by: 'omp' as const, stale: true, signed_in: true } }] },
    { server_time: '2026-11-27T12:00:00Z', providers: [{ ...active, windows: [{ ...active.windows[0]!, resets_at: '2026-11-26T12:00:00Z' }] }] },
  ]) expect(weeklyRemaining(option, report).percent).toBeNull();
});

test('saved Claude URLs keep their provider namespace through reloads', () => {
  const id = 'claude:00000000-0000-4000-8000-000000000001';
  const search = withSavedConversation('?pane=t1&view=terminal', id);
  expect(savedConversation(search)).toBe(id);
  expect(search).not.toContain('pane=');
  expect(savedConversation('?saved=claude:../../outside')).toBeNull();
});

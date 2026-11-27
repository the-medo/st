import type { MedoProviderOption } from '../../shared/medo.ts';
import type { UsageReport } from '../../shared/usage.ts';

/** Only the account the selected CLI actually uses supplies its badge. */
export function weeklyRemaining(provider: MedoProviderOption | undefined, report: UsageReport | null): { percent: number | null; note: string } {
  if (!report) return { percent: null, note: 'Loading weekly usage…' };
  const account = provider?.usageKey ? report.providers.find((item) => item.id === provider.id && item.key === provider.usageKey) : undefined;
  if (!account) return { percent: null, note: 'Weekly usage unavailable' };
  if (account.problem || account.recorded?.stale) return { percent: null, note: account.problem === 'expired' ? 'Sign in again to read weekly usage' : 'Weekly usage unavailable' };
  const week = account.windows.find((window) => window.kind === 'week' && window.scope === null);
  if (!week || !Number.isFinite(week.used_percent)) return { percent: null, note: 'Weekly usage unavailable' };
  if (week.resets_at && report.server_time && Date.parse(week.resets_at) <= Date.parse(report.server_time)) return { percent: null, note: 'Waiting for updated weekly usage' };
  const percent = Math.round(Math.max(0, Math.min(100, 100 - week.used_percent)));
  return { percent, note: `${percent}% of weekly usage remaining` };
}

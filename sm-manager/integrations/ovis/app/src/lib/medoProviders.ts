import type { MedoProviderOption } from '../../shared/medo.ts';
import type { UsageReport } from '../../shared/usage.ts';

/** Only the account the selected CLI actually uses supplies its badge. */
export function weeklyRemaining(provider: MedoProviderOption | undefined, report: UsageReport | null): { percent: number | null; label?: string; needsCliRefresh?: boolean; note: string } {
  if (!report) return { percent: null, label: 'Usage unavailable', note: 'Loading weekly usage…' };
  const account = provider?.usageKey ? report.providers.find((item) => item.id === provider.id && item.key === provider.usageKey) : undefined;
  if (!account) return { percent: null, label: 'Usage unavailable', note: 'Weekly usage unavailable' };
  if (account.problem || account.recorded?.stale) return { percent: null, needsCliRefresh: account.problem === 'expired', label: account.problem === 'expired' ? 'Usage needs refresh' : account.problem === 'rate_limited' ? 'Usage temporarily limited' : 'Usage unavailable', note: account.problem === 'expired' ? 'Open the CLI to refresh its usage access, then refresh usage here. Your stored login may still be valid.' : 'Weekly usage unavailable' };
  const week = account.windows.find((window) => window.kind === 'week' && window.scope === null);
  if (!week || !Number.isFinite(week.used_percent)) return { percent: null, label: 'Usage unavailable', note: 'Weekly usage unavailable' };
  if (week.resets_at && report.server_time && Date.parse(week.resets_at) <= Date.parse(report.server_time)) return { percent: null, label: 'Usage needs refresh', note: 'Waiting for updated weekly usage' };
  const percent = Math.round(Math.max(0, Math.min(100, 100 - week.used_percent)));
  return { percent, note: `${percent}% of weekly usage remaining` };
}

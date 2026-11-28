import { parseRecentTarget, type RecentTarget } from "../../../../packages/recent-conversations";

export type RecentHistoryApi = {
  read: () => Promise<RecentTarget[]>;
  visit: (target: RecentTarget) => Promise<RecentTarget[]>;
};
async function request(target?: RecentTarget): Promise<RecentTarget[]> {
  const response = await fetch("/api/recent-conversations", {
    method: target ? "POST" : "GET",
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
    ...(target ? { headers: { "content-type": "application/json" }, body: JSON.stringify(target) } : {}),
  });
  if (!response.ok) throw new Error("Recent history unavailable");
  const data = await response.json();
  if (!Array.isArray(data.items)) throw new Error("Invalid recent history");
  return data.items.map(parseRecentTarget);
}
export const recentHistoryApi: RecentHistoryApi = { read: () => request(), visit: request };

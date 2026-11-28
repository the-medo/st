/** Serializable navigation targets; callbacks and live status stay in the browser. */
export type RecentTarget = {
  machineId: string;
  paneId: string;
  threadId?: string;
  view: "chat" | "terminal";
  title: string;
  workspace: string;
  agent?: string | null;
  saved?: boolean;
};
export const RECENT_LIMIT = 30;
export const recentKey = (item: RecentTarget) =>
  JSON.stringify([item.machineId, item.threadId ?? item.paneId, item.view]);
export const sameRecent = (a: RecentTarget, b: RecentTarget) =>
  a.machineId === b.machineId && a.view === b.view &&
  (a.threadId && b.threadId ? a.threadId === b.threadId : a.paneId === b.paneId);

export function parseRecentTarget(value: unknown): RecentTarget {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a recent conversation target");
  const v = value as Record<string, unknown>;
  const string = (key: string, limit: number, empty = false) => {
    const text = v[key];
    if (typeof text !== "string" || text.length > limit || (!empty && !text.trim()) || /[\u0000-\u001f]/.test(text))
      throw new Error(`Invalid ${key}`);
    return text;
  };
  if (v.view !== "chat" && v.view !== "terminal") throw new Error("Invalid view");
  if (v.saved !== undefined && typeof v.saved !== "boolean") throw new Error("Invalid saved flag");
  return {
    machineId: string("machineId", 512), paneId: string("paneId", 1024),
    view: v.view, title: string("title", 4096, true), workspace: string("workspace", 4096, true),
    ...(v.threadId !== undefined ? { threadId: string("threadId", 1024) } : {}),
    ...(v.agent !== undefined ? { agent: v.agent === null ? null : string("agent", 128) } : {}),
    ...(v.saved !== undefined ? { saved: v.saved as boolean } : {}),
  };
}

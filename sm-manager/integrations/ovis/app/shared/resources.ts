/** Owner-only GET /api/medo/resources and /api/medo/skillshare, bound to pane_id. */
export interface ResourceInventory {
  skills: { name: string; description: string; path: string; scope: string; enabled: boolean; pluginId?: string | null }[];
  servers: { name: string; status: string; authStatus: string; environmentId?: string | null; pluginId?: string | null; tools: { name: string; description: string }[]; toolsUnavailable: boolean }[];
  errors: string[];
}
export interface SkillshareInventory {
  installed: boolean;
  checked: boolean;
  rows: { name: string; kind: "skill" | "agent" | "mcp"; scope: string; sync: "off" | "unknown" | "pending" | "synced"; update: "available" | "unknown" | "current" }[];
  errors: string[];
}

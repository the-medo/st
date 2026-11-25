/** Owner-only GET /api/medo/resources, bound to pane_id. */
export interface ResourceInventory {
  skills: { name: string; description: string; path: string; scope: string; enabled: boolean; pluginId?: string | null }[];
  servers: { name: string; status: string; authStatus: string; environmentId?: string | null; pluginId?: string | null; tools: { name: string; description: string }[]; toolsUnavailable: boolean }[];
  errors: string[];
}

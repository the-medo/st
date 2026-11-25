import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BookOpen, ChevronDown, Plug, RefreshCw, Search, X } from "lucide-react";
import type { ResourceInventory } from "../../shared/protocol.ts";
import { apiFetch } from "../lib/api-request-id.ts";
import { type ResourceActivity, usedResources } from "../lib/resourceActivity.ts";
import { MedoDialog } from "./MedoProjects.tsx";
import "./ResourcesPanel.css";

async function read<T>(path: string, paneId: string, signal: AbortSignal): Promise<T> {
  const response = await apiFetch(`/api/medo/${path}${path.includes("?") ? "&" : "?"}pane_id=${encodeURIComponent(paneId)}`, { signal });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message || "Resources could not be loaded.");
  return value as T;
}
const connection: Record<string, string> = { connected: "Connected", notStarted: "Not started", starting: "Connecting", authenticationRequired: "Sign-in needed", failed: "Connection failed", cancelled: "Cancelled", disabled: "Disabled", unknown: "Connection unknown" };
function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return <section className="resources-group"><h3>{title}<span>{count}</span></h3>{children}</section>;
}
function Row({ name, icon, status, children }: { name: string; icon: ReactNode; status: string; children?: ReactNode }) {
  return <details className="resources-row"><summary>{icon}<span className="resources-row-name">{name}<small>{status}</small></span><ChevronDown size={14} /></summary><div className="resources-detail">{children}</div></details>;
}

export function ResourcesPanel({ paneId, activity, docked, panelStart, onClose }: {
  paneId: string; activity: ResourceActivity | null; docked: boolean; panelStart?: ReactNode; onClose: () => void;
}) {
  const [tab, setTab] = useState<"used" | "available">("used");
  const [query, setQuery] = useState("");
  const [inventory, setInventory] = useState<ResourceInventory | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const focus = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!docked) return;
    const opener = document.activeElement;
    const surface = focus.current;
    surface?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected && (surface?.contains(document.activeElement) || document.activeElement === document.body)) opener.focus();
    };
  }, [docked]);
  const used = useMemo(() => usedResources(activity?.turns ?? []), [activity]);
  useEffect(() => {
    if (tab === "used") { setBusy(false); setError(""); return; }
    const controller = new AbortController();
    setBusy(true); setError("");
    const run = async () => {
      try {
        const value = await read<ResourceInventory>("resources", paneId, controller.signal);
        if (!controller.signal.aborted) setInventory(value);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Resources could not be loaded.");
      } finally { if (!controller.signal.aborted) setBusy(false); }
    };
    void run();
    return () => controller.abort();
  }, [paneId, tab, refresh]);
  const matches = (value: string) => value.toLowerCase().includes(query.toLowerCase().trim());
  const skills = (tab === "used" ? used.skills : inventory?.skills ?? []).filter(item => matches(`${item.name} ${"description" in item ? item.description : ""}`));
  const servers = (inventory?.servers ?? []).filter(item => matches(`${item.name} ${item.tools.map(tool => tool.name).join(" ")}`));
  const usedServers = used.servers.filter(item => matches(`${item.name} ${[...item.tools].join(" ")}`));
  const body = <>
    <div className="resources-tabs" role="group" aria-label="Resource view">
      {([['used', 'Used'], ['available', 'Available']] as const).map(([key, label]) => <button type="button" key={key} aria-pressed={tab === key} onClick={() => setTab(key)}>{label}</button>)}
    </div>
    <div className="resources-toolbar"><label><Search size={15} /><input aria-label="Filter resources" placeholder="Find a skill or MCP…" value={query} onChange={event => setQuery(event.target.value)} /></label>
      {tab !== "used" && <button type="button" aria-label="Refresh resources" title="Refresh resources" disabled={busy} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={16} /></button>}
    </div>
    <div className="resources-scroll">
      {busy && <p className="resources-note" role="status">Reading resources…</p>}
      {error && <p className="resources-warning" role="alert">{error}</p>}
      {tab === "used" && <>
        <p className="resources-note">Recorded in the loaded conversation history. Instructions loaded means the skill was read, not that its workflow finished. Calls hidden inside scripts may be absent.</p>
        {activity?.more && <button type="button" className="btn" disabled={activity.loadingEarlier} onClick={activity.loadEarlier}>{activity.loadingEarlier ? "Loading earlier activity…" : "Load earlier activity"}</button>}
        <Group title="Skills" count={skills.length}>{skills.map((skill, index) => <Row key={skill.path ?? index} name={skill.name} icon={<BookOpen size={16} />} status={"status" in skill ? ({ loaded: "Instructions loaded", requested: "Requested", failed: "Read failed" }[skill.status] ?? skill.status) : ""}><code>{skill.path || "No document path recorded"}</code></Row>)}</Group>
        <Group title="MCP calls" count={usedServers.reduce((sum, server) => sum + server.calls, 0)}>{usedServers.map(server => <Row key={server.name} name={server.name} icon={<Plug size={16} />} status={`${server.calls} ${server.calls === 1 ? "call" : "calls"}${server.failed ? ` · ${server.failed} failed` : ""}${server.pending ? ` · ${server.pending} running` : ""}`}><ul>{[...server.tools].map(tool => <li key={tool}><code>{tool}</code></li>)}</ul></Row>)}</Group>
        {!skills.length && !usedServers.length && <p className="resources-empty">{query ? "No matching activity." : activity ? "No skill or MCP activity recorded in these messages yet." : "Open the chat view to read its activity."}</p>}
      </>}
      {tab === "available" && inventory && <>
        <p className="resources-note">Reported by the agent for this project and conversation. Availability does not mean a resource was used.</p>
        {inventory.errors.map(message => <p role="status" className="resources-warning" key={message}>{message}</p>)}
        <Group title="Skills" count={skills.length}>{inventory.skills.filter(skill => matches(`${skill.name} ${skill.description}`)).map(skill => <Row key={skill.path} name={skill.name} icon={<BookOpen size={16} />} status={`${skill.enabled ? "Available" : "Disabled"} · ${skill.pluginId ? "Plugin" : skill.scope}`}><p>{skill.description}</p><code>{skill.path}</code></Row>)}</Group>
        <Group title="MCP servers" count={servers.length}>{servers.map(server => <Row key={`${server.environmentId}:${server.name}`} name={server.name} icon={<Plug size={16} />} status={`${connection[server.status] ?? "Connection unknown"} · ${server.tools.length} ${server.tools.length === 1 ? "tool" : "tools"}`}>
          {server.toolsUnavailable && <p className="resources-warning">Tool discovery is unavailable.</p>}
          {server.authStatus === "notLoggedIn" && <p>Sign in through the agent to use this server.</p>}
          <ul>{server.tools.map(tool => <li key={tool.name}><strong>{tool.name}</strong>{tool.description && <p>{tool.description}</p>}</li>)}</ul>
        </Row>)}</Group>
        {!skills.length && !servers.length && <p className="resources-empty">No matching resources reported.</p>}
      </>}
    </div>
  </>;
  return docked ? <aside id="resources-panel" className="resources-panel" aria-label="Skills & MCPs">
    {panelStart}<div ref={focus} tabIndex={-1} className="resources-content" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
      <header><div><h2>Skills & MCPs</h2><span>Conversation resources</span></div><button type="button" aria-label="Close resources" onClick={onClose}><X size={18} /></button></header>{body}
    </div>
  </aside> : <MedoDialog title="Skills & MCPs" onClose={onClose}><div id="resources-panel" className="resources-content resources-sheet">{body}</div></MedoDialog>;
}

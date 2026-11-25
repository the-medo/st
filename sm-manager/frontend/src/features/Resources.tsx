import { useState } from "react";
import type { Container, Process, Project, Worktree } from "../lib/types";
import { bytes, percent, ago } from "../lib/api";
import {
  External,
  Panel,
  Modal,
  Empty,
  Metric,
  Notice,
} from "../components/Ui";
import {
  CheckoutActions,
  CopyText,
  cleanupBrief,
  useMonitor,
} from "./MonitorContext";
import { HistoryChart } from "./HistoryChart";
export function ProcessTable({ items }: { items: Process[] }) {
  return items.length ? (
    <div className="st-table-scroll">
      <table>
        <thead>
          <tr>
            <th>Process</th>
            <th>Memory</th>
            <th>CPU</th>
            <th>PID</th>
            <th>Ownership</th>
          </tr>
        </thead>
        <tbody>
          {items.map((p) => (
            <tr key={`${p.pid}-${p.start_ticks}`}>
              <td>
                {p.name}
                <small>{p.cwd}</small>
              </td>
              <td>{bytes(p.memory_bytes)}</td>
              <td>{percent(p.cpu_percent)}</td>
              <td>{p.pid}</td>
              <td>{p.ownership}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty>No processes to show.</Empty>
  );
}
export function ContainerTable({
  items,
}: {
  items: (Container & { owner?: string; path?: string })[];
}) {
  return items.length ? (
    <div className="st-table-scroll">
      <table className="container-table">
        <thead>
          <tr>
            <th>Container</th>
            <th className="container-memory container-memory-column">Memory</th>
            <th className="container-tasks container-tasks-column">Tasks</th>
            <th className="container-cpu container-cpu-column">CPU</th>
            <th className="container-owner-column">Worktree</th>
            <th className="container-ports-column">Ports</th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id}>
              <td>
                <strong className="container-name">{c.name}</strong>
                <small className="container-image">{c.image}</small>
                <code>
                  {c.id.slice(0, 12)}
                  {!c.stats_available ? " · Stats unavailable" : ""}
                </code>
                <span className="container-mobile-owner">
                  {c.owner ?? "Unassigned"}
                  {c.path && <CheckoutActions path={c.path} />}
                </span>
                <span className="container-mobile-ports">
                  {c.ports.join(", ") || "—"}
                </span>
              </td>
              <td className="container-memory">{bytes(c.memory_bytes)}</td>
              <td className="container-tasks">{c.pids ?? "—"}</td>
              <td className="container-cpu">{percent(c.cpu_percent)}</td>
              <td className="container-owner-cell">
                {c.owner ?? "Unassigned"}
                <small>{c.ownership}</small>
                {c.path && <CheckoutActions path={c.path} />}
              </td>
              <td className="container-ports-cell">
                {c.ports.join(", ") || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty>No containers to show.</Empty>
  );
}
export function WorktreeDetail({
  id,
  close,
}: {
  id: string;
  close: () => void;
}) {
  const { snapshot } = useMonitor();
  const [brief, setBrief] = useState("");
  const [error, setError] = useState("");
  const s = snapshot.data;
  const tree = s?.projects.flatMap((p) => p.worktrees).find((w) => w.id === id);
  return (
    <Modal title={tree?.branch ?? "Worktree unavailable"} close={close}>
      {tree && s ? (
        <>
          <code>{tree.path}</code>
          <CheckoutActions path={tree.path} />
          <p>
            <small>
              Last Codex metadata update: {ago(tree.last_codex_activity)}
            </small>
          </p>
          <div className="st-metrics metrics">
            <Metric label="Memory" value={bytes(tree.memory_bytes)} />
            <Metric label="CPU" value={percent(tree.cpu_percent)} />
            <Metric label="Ports" value={tree.ports.join(", ") || "—"} />
          </div>
          <div className="st-actions">
            {tree.urls.map((l) => (
              <External key={l.url} url={l.url}>
                Port {l.port}
              </External>
            ))}
          </div>
          <h3>Processes</h3>
          <ProcessTable items={tree.processes} />
          <h3>Containers</h3>
          <ContainerTable items={tree.containers} />
          <h3>History</h3>
          <HistoryChart snapshot={s} initialEntity={`worktree:${id}`} />
          <div className="st-toolbar">
            <button
              onClick={() =>
                void cleanupBrief(id).then(
                  (v) => {
                    setBrief(
                      v.prompt + "\n" + JSON.stringify(v.resources, null, 2),
                    );
                    setError("");
                  },
                  (e) => setError(String(e)),
                )
              }
            >
              Generate cleanup brief
            </button>
            {brief && <CopyText text={brief} label="Copy cleanup brief" />}
          </div>
          {error && <Notice>{error}</Notice>}
          {brief && <pre className="st-copy">{brief}</pre>}
        </>
      ) : (
        <Notice>This worktree is no longer in the current snapshot.</Notice>
      )}
    </Modal>
  );
}
export function Projects() {
  const { projects } = useMonitor();
  const [query, setQuery] = useState(""),
    [running, setRunning] = useState(true),
    [sort, setSort] = useState("memory"),
    [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const shown = projects
    .map((p) => ({
      ...p,
      worktrees: p.worktrees.filter(
        (w) =>
          (!running || w.running) &&
          `${p.name} ${p.info?.description ?? ""} ${w.branch} ${w.path}`
            .toLowerCase()
            .includes(query.toLowerCase().trim()),
      ),
    }))
    .filter((p) => p.worktrees.length)
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : sort === "cpu"
          ? (b.cpu_percent ?? 0) - (a.cpu_percent ?? 0)
          : b.memory_bytes - a.memory_bytes,
    );
  const toggle = (id: string) =>
    setCollapsed((old) => {
      const n = new Set(old);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <>
      <div className="st-toolbar">
        <input
          aria-label="Search projects"
          placeholder="Project, branch, path…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label>
          <input
            type="checkbox"
            checked={running}
            onChange={(e) => setRunning(e.target.checked)}
          />
          Running only
        </label>
        <label>
          Sort
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="memory">Memory ↓</option>
            <option value="cpu">CPU ↓</option>
            <option value="name">Name A–Z</option>
          </select>
        </label>
        <small>{shown.length} projects</small>
      </div>
      {shown.map((p) => {
        const path =
          p.info?.primary_path ?? p.info?.path ?? p.worktrees[0]!.path;
        return (
          <article className="project-card" key={p.id}>
            <aside
              className="project-info"
              aria-label={`${p.name} project details`}
            >
              <div className="project-info-identity">
                <ProjectAvatar project={p} />
                <div>
                  <h3>{p.name}</h3>
                  <RunningBadge project={p} />
                </div>
              </div>
              <p className="project-description">
                {p.info?.description || "No description available."}
              </p>
              <div className="project-tags">
                {p.info?.languages?.map((language) => (
                  <span key={language}>{language}</span>
                ))}
                {p.info?.version && <span>v{p.info.version}</span>}
              </div>
              <div className="project-directory">
                <span>Checkout</span>
                <div className="checkout-actions">
                  <code>{path}</code>
                  <CheckoutActions primary path={path} />
                </div>
              </div>
              <div className="project-link">
                <External url={p.info?.repository_url}>Repository</External>
              </div>
              {[
                ...new Set(
                  p.worktrees.flatMap((w) => w.urls.map((l) => l.url)),
                ),
              ]
                .slice(0, 3)
                .map((url) => (
                  <div className="project-link" key={url}>
                    <External url={url}>Open app</External>
                  </div>
                ))}
            </aside>
            <div className="project-worktrees">
              <div className="project-heading">
                <div className="project-identity">
                  <div className="project-title">
                    <span className="project-overview-name">
                      <ProjectAvatar project={p} />
                      {p.name}
                      <CheckoutActions primary path={path} />
                    </span>
                    <span className="project-table-title">Worktrees</span>
                    <span className="project-heading-status">
                      <RunningBadge project={p} />
                    </span>
                  </div>
                  <div className="project-meta">
                    {p.worktrees.length} wt · {p.process_count} proc ·{" "}
                    {p.container_count} ctr
                  </div>
                </div>
                <div className="project-totals numeric">
                  <span className="project-memory" title="Project memory">
                    {bytes(p.memory_bytes)}
                  </span>
                  <span title="Project CPU">{percent(p.cpu_percent)}</span>
                </div>
                <button
                  className="collapse-button"
                  aria-label={`${collapsed.has(p.id) ? "Expand" : "Collapse"} ${p.name}`}
                  aria-expanded={!collapsed.has(p.id)}
                  aria-controls={`tree-${p.id}`}
                  onClick={() => toggle(p.id)}
                >
                  {collapsed.has(p.id) ? "+" : "−"}
                </button>
              </div>
              <div id={`tree-${p.id}`} hidden={collapsed.has(p.id)}>
                <div className="tree-columns">
                  <span>Worktree / branch</span>
                  <span className="services-heading">Proc / containers</span>
                  <span className="ports-heading">Ports</span>
                  <span className="align-right memory-heading">Memory</span>
                  <span className="align-right">CPU</span>
                  <span />
                </div>
                {p.worktrees.map((w) => (
                  <TreeRow
                    key={w.id}
                    tree={w}
                    inspect={() => setSelected(w.id)}
                  />
                ))}
              </div>
            </div>
          </article>
        );
      })}
      {!shown.length && (
        <Empty>
          {query
            ? "No projects match your search."
            : "No running projects. Turn off Running only to see idle worktrees."}
        </Empty>
      )}
      {selected && (
        <WorktreeDetail id={selected} close={() => setSelected(null)} />
      )}
    </>
  );
}
function ProjectAvatar({ project }: { project: Project }) {
  const initials =
    project.name
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => [...part][0])
      .join("")
      .toUpperCase() || "?";
  const icon = project.info?.icon_url;
  return (
    <span className="project-avatar" aria-hidden="true">
      <span>{initials}</span>
      {icon &&
        /^\/api\/project-icon\/[a-f0-9]{16}\/[a-f0-9]{16}$/.test(icon) && (
          <img src={icon} alt="" loading="lazy" />
        )}
    </span>
  );
}
function RunningBadge({ project }: { project: Project }) {
  return (
    <span
      className={`running-badge ${project.running_worktrees ? "" : "idle"}`}
    >
      {project.running_worktrees ? (
        <>
          <span className="status-dot" />
          Running
        </>
      ) : (
        "Idle"
      )}
    </span>
  );
}
function TreeRow({
  tree: w,
  inspect,
}: {
  tree: Worktree;
  inspect: () => void;
}) {
  return (
    <div className="worktree-row">
      <div className="worktree-name">
        <button className="branch-label" onClick={inspect} title={w.path}>
          <span className="branch-icon" aria-hidden="true">
            ⑂
          </span>
          <span className="branch-title">{w.branch}</span>
          <span className="branch-info">
            {w.is_main ? "[main]" : ""}
            {w.codex_managed && (
              <span className="codex-marker" title="Codex worktree">
                ✳
              </span>
            )}
          </span>
        </button>
        <CheckoutActions path={w.path} />
      </div>
      <span className="service-summary">
        {w.running
          ? `${w.processes.length} proc / ${w.containers.length} ctr`
          : "Idle"}
      </span>
      <span className="row-ports" title={w.ports.join(", ")}>
        {w.ports.join(", ") || "—"}
      </span>
      <span className="row-memory">
        {w.running ? bytes(w.memory_bytes) : "—"}
      </span>
      <span className="row-cpu">
        {w.running ? percent(w.cpu_percent) : "—"}
      </span>
      <span className="row-arrow" aria-hidden="true">
        ↗
      </span>
    </div>
  );
}
export function Containers() {
  const { snapshot, projects, scoped } = useMonitor();
  const s = snapshot.data;
  const all = [
    ...(scoped ? [] : (s?.unassigned_containers ?? [])),
    ...projects.flatMap((p) =>
      p.worktrees.flatMap((w) =>
        w.containers.map((c) => ({
          ...c,
          owner: `${p.name} / ${w.branch}`,
          path: w.path,
        })),
      ),
    ),
  ].sort((a, b) => (b.memory_bytes ?? 0) - (a.memory_bytes ?? 0));
  return (
    <Panel title="Running containers">
      <p>
        <small>{s?.docker.status}</small>
      </p>
      <ContainerTable items={all} />
    </Panel>
  );
}

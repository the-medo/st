import { useEffect, useState } from "react";
import { RefreshCw, GitPullRequest, CheckCheck, ListTodo } from "lucide-react";
import { api, ago, usePoll } from "../lib/api";
import { Empty, External, Notice, Panel } from "../components/Ui";
import "./github.css";

type Section<T> = {
  data: T | null;
  updated_at: number | null;
  stale: boolean;
  error: string | null;
};
export type GitHubTask = {
  id: string;
  kind: string;
  title: string;
  number: number | null;
  url: string;
  repository: string;
  state: string;
  status: string;
  completed: boolean;
  assignees: string[];
  labels: string[];
  sprint_id: string | null;
  sprint: string | null;
  updated_at: string;
  pull_requests: {
    number: number;
    title: string;
    url: string;
    state: string;
  }[];
};
export type GitHubPR = {
  id: string;
  title: string;
  number: number;
  url: string;
  repository: string;
  draft: boolean;
  review: string | null;
  mergeable: string;
  checks: string | null;
  additions: number;
  deletions: number;
  updated_at: string;
};
export type GitHubData = {
  organization: string;
  username: string;
  project_url: string;
  sprint_url: string;
  backlog_url: string;
  refreshing: boolean;
  refresh_after: number;
  cache_seconds: number;
  project: Section<{
    title: string;
    current_sprint: {
      id: string;
      title: string;
      startDate: string;
      endDate: string;
    } | null;
    sprint_tasks: GitHubTask[];
    backlog: GitHubTask[];
  }>;
  pull_requests: Section<GitHubPR[]>;
};

function Badge({ value }: { value: string }) {
  const lower = value.toLowerCase();
  const tone = ["done", "delivered", "approved", "success"].includes(lower)
    ? "success"
    : ["failure", "error", "changes requested", "conflicts"].includes(lower)
      ? "danger"
      : ["in progress", "pending", "review required", "expected"].includes(
            lower,
          )
        ? "pending"
        : "neutral";
  return <span className={`github-badge github-badge-${tone}`}>{value}</span>;
}
const label = (value: string | null, fallback: string) =>
  value
    ? value
        .toLowerCase()
        .replaceAll("_", " ")
        .replace(/^./, (letter) => letter.toUpperCase())
    : fallback;
const dateLabel = (date: string) =>
  new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(date + "T12:00:00"),
  );
function Updated({ at }: { at: string }) {
  const minutes = Math.floor(Math.max(0, Date.now() - Date.parse(at)) / 60000);
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] =
    minutes < 60
      ? [minutes, "minute"]
      : minutes < 1440
        ? [Math.floor(minutes / 60), "hour"]
        : [Math.floor(minutes / 1440), "day"];
  return (
    <time dateTime={at} title={new Date(at).toLocaleString()}>
      {new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
        -value,
        unit,
      )}
    </time>
  );
}
function SectionStatus({
  section,
  refreshing,
}: {
  section: Section<unknown>;
  refreshing: boolean;
}) {
  return (
    <>
      {section.error && (
        <Notice>
          {section.error}
          {section.data !== null && " Showing the last successful update."}
        </Notice>
      )}
      {!section.error && section.stale && (
        <Notice>
          Showing cached data.{refreshing && " Refreshing from GitHub…"}
        </Notice>
      )}
      {section.data === null && !section.error && (
        <Empty>
          {refreshing ? "Loading from GitHub…" : "Waiting for GitHub…"}
        </Empty>
      )}
    </>
  );
}
function TaskTable({
  tasks,
  backlog = false,
  empty,
}: {
  tasks: GitHubTask[];
  backlog?: boolean;
  empty: string;
}) {
  if (!tasks.length) return <Empty>{empty}</Empty>;
  return (
    <div className="st-table-scroll">
      <table
        className="github-table"
        aria-label={backlog ? "Backlog issues" : "Current sprint tasks"}
      >
        <thead>
          <tr>
            <th>Issue</th>
            <th>Status</th>
            {backlog && (
              <>
                <th>Assignees</th>
                <th>Sprint</th>
              </>
            )}
            <th>Linked PRs</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.id}>
              <td className="github-title-cell">
                <External url={task.url}>{task.title}</External>
                <div className="github-item-meta">
                  <span>
                    {task.repository || "Draft issue"}
                    {task.number ? ` #${task.number}` : ""}
                  </span>
                  {task.labels.map((l) => (
                    <span className="github-label" key={l}>
                      {l}
                    </span>
                  ))}
                </div>
              </td>
              <td>
                <Badge value={task.status} />
              </td>
              {backlog && (
                <>
                  <td>
                    {task.assignees.join(", ") || (
                      <span className="st-muted">Unassigned</span>
                    )}
                  </td>
                  <td>{task.sprint || "—"}</td>
                </>
              )}
              <td>
                <div className="github-linked-prs">
                  {task.pull_requests.length ? (
                    task.pull_requests.map((pr) => (
                      <span key={pr.url} title={`${pr.title} · ${pr.state}`}>
                        <External url={pr.url}>#{pr.number}</External>
                      </span>
                    ))
                  ) : (
                    <span className="st-muted">—</span>
                  )}
                </div>
              </td>
              <td>
                <Updated at={task.updated_at} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function PullRequests({ rows }: { rows: GitHubPR[] }) {
  if (!rows.length)
    return <Empty>No open pull requests match this view.</Empty>;
  return (
    <div className="st-table-scroll">
      <table className="github-table" aria-label="Open pull requests">
        <thead>
          <tr>
            <th>Pull request</th>
            <th>Status</th>
            <th>Review</th>
            <th>Checks</th>
            <th>Changes</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((pr) => (
            <tr key={pr.id}>
              <td className="github-title-cell">
                <External url={pr.url}>{pr.title}</External>
                <div className="github-item-meta">
                  {pr.repository} #{pr.number}
                </div>
              </td>
              <td>
                <Badge value={pr.draft ? "Draft" : "Open"} />
                {pr.mergeable === "CONFLICTING" && <Badge value="Conflicts" />}
              </td>
              <td>
                <Badge value={label(pr.review, "No review")} />
              </td>
              <td>
                <Badge value={label(pr.checks, "No checks")} />
              </td>
              <td className="github-changes">
                <span>+{pr.additions}</span> <span>−{pr.deletions}</span>
              </td>
              <td>
                <Updated at={pr.updated_at} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function GitHub() {
  const [interval, setInterval] = useState(2000);
  const { data, error, refresh } = usePoll<GitHubData>("/api/github", interval);
  const [requesting, setRequesting] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [refreshHint, setRefreshHint] = useState("");
  const [search, setSearch] = useState("");
  const [repository, setRepository] = useState("");
  const [mine, setMine] = useState(false);
  useEffect(() => {
    setInterval(data?.refreshing ? 2000 : 60000);
  }, [data?.refreshing]);
  async function forceRefresh() {
    setRequesting(true);
    setRefreshError("");
    setRefreshHint("");
    try {
      const response = await api<GitHubData>("/api/github?refresh=1");
      if (!response.refreshing && response.refresh_after > 0)
        setRefreshHint(
          `Updated recently. Refresh available in ${Math.ceil(response.refresh_after)} seconds.`,
        );
      refresh();
    } catch (cause) {
      setRefreshError(
        cause instanceof Error ? cause.message : "Refresh failed",
      );
    } finally {
      setRequesting(false);
    }
  }
  const project = data?.project.data;
  const sprint = project?.current_sprint;
  const tasks = project?.sprint_tasks ?? [];
  const prs = data?.pull_requests.data ?? [];
  const backlog = project?.backlog ?? [];
  const completed = tasks.filter((task) => task.completed).length;
  const repositories = [
    ...new Set(
      [...tasks, ...backlog, ...prs]
        .map((row) => row.repository)
        .filter(Boolean),
    ),
  ].sort();
  const matches = (row: GitHubTask | GitHubPR) =>
    (!repository || row.repository === repository) &&
    [
      row.title,
      row.repository,
      String(row.number ?? ""),
      ...("assignees" in row
        ? [...row.assignees, ...row.labels, row.status]
        : []),
    ]
      .join(" ")
      .toLowerCase()
      .includes(search.trim().toLowerCase());
  const shownBacklog = backlog.filter(
    (task) =>
      matches(task) &&
      (!mine ||
        task.assignees.some(
          (assignee) => assignee.toLowerCase() === data?.username.toLowerCase(),
        )),
  );
  const busy = requesting || data?.refreshing;
  return (
    <div className="github-page">
      <header className="github-header">
        <div className="github-heading">
          <GitPullRequest size={28} aria-hidden="true" />
          <div>
            <h1>GitHub</h1>
            <p>
              {data?.organization ?? "ydistri"}
              {data?.username && (
                <>
                  {" "}
                  <span> / </span> @{data.username}
                </>
              )}
            </p>
          </div>
        </div>
        <div className="github-actions">
          {data && <External url={data.project_url}>Open project</External>}
          <button
            onClick={() => void forceRefresh()}
            disabled={!!busy}
            aria-label="Refresh GitHub"
          >
            <RefreshCw size={14} aria-hidden="true" />
            {busy ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>
      <p className="github-sync" role="status">
        {busy
          ? "Fetching your latest work from GitHub…"
          : refreshHint ||
            "Refreshes hourly while you’re here. Use Refresh to check sooner."}
      </p>
      {(error || refreshError) && (
        <Notice retry={refresh}>{error || refreshError}</Notice>
      )}
      {!data ? (
        <Notice>Loading GitHub…</Notice>
      ) : (
        <>
          <div className="github-summary">
            <div>
              <ListTodo size={18} aria-hidden="true" />
              <span>
                My sprint tasks<strong>{project ? tasks.length : "—"}</strong>
              </span>
              <small>{sprint?.title ?? "Current sprint"}</small>
            </div>
            <div>
              <CheckCheck size={18} aria-hidden="true" />
              <span>
                Done / delivered<strong>{project ? completed : "—"}</strong>
              </span>
              <small>
                {tasks.length
                  ? `${Math.round((completed / tasks.length) * 100)}% of your sprint`
                  : "Included below"}
              </small>
            </div>
            <div>
              <GitPullRequest size={18} aria-hidden="true" />
              <span>
                Open pull requests
                <strong>{data.pull_requests.data ? prs.length : "—"}</strong>
              </span>
              <small>Across {data.organization}</small>
            </div>
          </div>
          <div className="github-filters">
            <input
              type="search"
              aria-label="Search GitHub work"
              placeholder="Search titles, issue numbers, labels…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <select
              aria-label="Filter by repository"
              value={repository}
              onChange={(event) => setRepository(event.target.value)}
            >
              <option value="">All repositories</option>
              {repositories.map((repo) => (
                <option key={repo}>{repo}</option>
              ))}
            </select>
          </div>
          <Panel
            title="My current sprint"
            className="github-section"
            actions={<External url={data.sprint_url}>Sprint board</External>}
          >
            <div className="github-section-meta">
              <span>
                {sprint ? (
                  <>
                    <strong>{sprint.title}</strong> ·{" "}
                    {dateLabel(sprint.startDate)} – {dateLabel(sprint.endDate)}
                  </>
                ) : (
                  "No active sprint"
                )}{" "}
                · Includes done and delivered
              </span>
              {data.project.updated_at && (
                <span>Updated {ago(data.project.updated_at)}</span>
              )}
            </div>
            <SectionStatus
              section={data.project}
              refreshing={data.refreshing}
            />
            {project && (
              <TaskTable
                tasks={tasks.filter(matches)}
                empty={
                  !sprint
                    ? "There is no active sprint for today in this project."
                    : "No assigned tasks match this sprint view."
                }
              />
            )}
          </Panel>
          <Panel
            title="My open pull requests"
            className="github-section"
            actions={
              <External
                url={`https://github.com/pulls?q=${encodeURIComponent(`is:pr is:open org:${data.organization} author:${data.username || "@me"}`)}`}
              >
                All my PRs
              </External>
            }
          >
            <div className="github-section-meta">
              <span>Authored by you · Drafts included</span>
              {data.pull_requests.updated_at && (
                <span>Updated {ago(data.pull_requests.updated_at)}</span>
              )}
            </div>
            <SectionStatus
              section={data.pull_requests}
              refreshing={data.refreshing}
            />
            {data.pull_requests.data && (
              <PullRequests rows={prs.filter(matches)} />
            )}
          </Panel>
          <details className="github-backlog st-panel panel">
            <summary>
              <span>
                Backlog{" "}
                <span className="github-count">
                  {project ? backlog.length : "—"}
                </span>
              </span>
              <small>
                Issues across the project · Excludes done and delivered
              </small>
            </summary>
            <div className="github-backlog-controls">
              <label>
                <input
                  type="checkbox"
                  checked={mine}
                  onChange={(event) => setMine(event.target.checked)}
                />{" "}
                Assigned to me
              </label>
              <span>{shownBacklog.length} matching issues</span>
              <External url={data.backlog_url}>Backlog board</External>
            </div>
            <SectionStatus
              section={data.project}
              refreshing={data.refreshing}
            />
            {project && (
              <TaskTable
                tasks={shownBacklog}
                backlog
                empty="No backlog issues match these filters."
              />
            )}
          </details>
        </>
      )}
    </div>
  );
}

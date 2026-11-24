import { useState } from "react";
import { api, bytes, ago, usePoll } from "../lib/api";
import { Empty, Panel, Notice } from "../components/Ui";
import { CheckoutActions, DbLink, ZedLink, useMonitor } from "./MonitorContext";
import { DetailsTooltip } from "../components/DetailsTooltip";
import postgresIcon from "../assets/engines/postgresql.svg";
import sqlserverIcon from "../assets/engines/sqlserver.svg";
import { WorktreeDetail } from "./Resources";
import type { Database, DiskUsage, ZedTree } from "../lib/types";
function ZedRows({ worktrees }: { worktrees: ZedTree[] }) {
  return (
    <div className="st-table-scroll">
      <table className="st-catalog-table st-zed-table">
        <colgroup>
          <col className="st-col-checkout" />
          <col />
          <col className="st-col-open" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Checkout</th>
            <th scope="col">Revision</th>
            <th scope="col" className="st-catalog-icon-cell">
              Open
            </th>
          </tr>
        </thead>
        <tbody>
          {worktrees.map((w) => (
            <tr key={w.path}>
              <td>
                <span className="st-ellipsis" title={w.name ?? w.path}>
                  {w.name ?? w.path}
                  {w.is_main ? " [main]" : ""}
                </span>
                <code className="st-ellipsis" title={w.path}>
                  {w.path}
                </code>
              </td>
              <td>
                <span className="st-ellipsis" title={w.revision ?? w.branch}>
                  {w.revision ?? w.branch ?? "—"}
                </span>
              </td>
              <td className="st-catalog-icon-cell">
                {w.zed_url ? (
                  <ZedLink url={w.zed_url} path={w.path} />
                ) : (
                  <span title="Zed launch unavailable">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function Zed() {
  const { zed, scope, workmode } = useMonitor();
  const groups = workmode ? scope.groups : (zed.data?.groups ?? []);
  return (
    <>
      {zed.error && <Notice retry={zed.refresh}>{zed.error}</Notice>}
      {groups.map((g) => (
        <Panel key={g.name} title={g.name}>
          {g.repositories.map((r) => (
            <section key={r.primary_path}>
              <h3>{r.name}</h3>
              <ZedRows worktrees={r.worktrees} />
            </section>
          ))}
        </Panel>
      ))}
      {!groups.length && !zed.error && (
        <Empty>
          {zed.data ? "No published checkouts." : "Loading checkout catalog…"}
        </Empty>
      )}
      {!workmode && !!zed.data?.monitor_only?.length && (
        <Panel title="Other discovered checkouts">
          <ZedRows worktrees={zed.data.monitor_only} />
        </Panel>
      )}
    </>
  );
}
function groupBy<T>(values: T[], key: (v: T) => string) {
  return [
    ...values.reduce((m, v) => {
      const k = key(v);
      m.set(k, [...(m.get(k) ?? []), v]);
      return m;
    }, new Map<string, T[]>()),
  ];
}
function EngineIcon({ engine }: { engine: string }) {
  const key = engine.toLowerCase();
  const src = /postgres/.test(key)
    ? postgresIcon
    : /microsoft sql|sql server|mssql|sqlserver/.test(key)
      ? sqlserverIcon
      : "/db.svg";
  return (
    <img
      className="st-engine-icon"
      src={src}
      alt={engine}
      title={engine}
      width="22"
      height="22"
    />
  );
}
function DbRows({ items, stale }: { items: Database[]; stale: boolean }) {
  return (
    <div className="st-table-scroll">
      <table className="st-catalog-table st-db-table">
        <colgroup>
          <col className="st-col-engine" />
          <col className="st-col-branch" />
          <col className="st-col-connection" />
          <col className="st-col-database" />
          <col />
          <col className="st-col-status" />
          <col className="st-col-open" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" aria-label="Engine">
              <span className="st-sr-only">Engine</span>
            </th>
            <th scope="col">Branch</th>
            <th scope="col">Connection</th>
            <th scope="col">Database</th>
            <th scope="col">Endpoint</th>
            <th scope="col">Status</th>
            <th scope="col" className="st-catalog-icon-cell">
              Open
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((d) => {
            const branch = d.owner?.branch || "—";
            const host =
              d.host?.includes(":") && !d.host.startsWith("[")
                ? `[${d.host}]`
                : d.host;
            const endpoint =
              [host, d.port].filter((v) => v != null).join(":") || "—";
            return (
              <tr key={d.id}>
                <td className="st-catalog-icon-cell">
                  <EngineIcon engine={d.engine} />
                </td>
                <td>
                  <DetailsTooltip label={branch}>
                    <strong className="st-details-title">
                      Database connection
                    </strong>
                    <dl>
                      <dt>Branch</dt>
                      <dd>
                        {d.owner
                          ? d.owner.branch || "Branch unavailable"
                          : "Not associated with a checkout"}
                      </dd>
                      <dt>Worktree</dt>
                      <dd>{d.owner?.worktree || "—"}</dd>
                      <dt>Path</dt>
                      <dd>{d.owner?.worktree_path || "—"}</dd>
                      <dt>Connection</dt>
                      <dd>{d.name}</dd>
                      <dt>Database</dt>
                      <dd>{d.database}</dd>
                      <dt>Engine</dt>
                      <dd>{d.engine}</dd>
                      <dt>Endpoint</dt>
                      <dd>{endpoint}</dd>
                    </dl>
                  </DetailsTooltip>
                </td>
                <td>
                  <span className="st-ellipsis" title={d.name}>
                    {d.name}
                  </span>
                </td>
                <td>
                  <span className="st-ellipsis" title={d.database}>
                    {d.database}
                  </span>
                </td>
                <td>
                  <span className="st-ellipsis" title={endpoint}>
                    {endpoint}
                  </span>
                </td>
                <td>
                  <span className="st-db-status" data-status={d.status}>
                    {d.status}
                  </span>
                </td>
                <td className="st-catalog-icon-cell">
                  {!stale && d.status === "available" ? (
                    <DbLink db={d} />
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
export function Dbs() {
  const { dbs, scope, workmode } = useMonitor();
  const catalog = dbs.data;
  const stale =
    !catalog ||
    catalog.stale ||
    Date.now() - dbs.at >= catalog.fresh_for_seconds * 1000;
  const connections = workmode
    ? scope.connections
    : (catalog?.connections ?? []);
  return (
    <>
      {dbs.error && <Notice retry={dbs.refresh}>{dbs.error}</Notice>}
      {catalog && (
        <Notice>
          {stale ? "Stale catalog · launch links disabled. " : ""}Last checked{" "}
          {new Date(catalog.checked_at).toLocaleString()}
        </Notice>
      )}
      {groupBy(
        connections,
        (d) => d.owner?.group ?? d.group ?? "Unassigned",
      ).map(([group, items]) => (
        <Panel key={group} title={group}>
          {groupBy(items, (d) => d.owner?.primary_path ?? "").map(
            ([repo, rows]) => (
              <section key={repo}>
                {repo && <h3>{rows[0]?.owner?.repository}</h3>}
                <DbRows items={rows} stale={stale} />
              </section>
            ),
          )}
        </Panel>
      ))}
      {!connections.length && (
        <Empty>
          {catalog
            ? "No databases in the catalog."
            : "Loading database catalog…"}
        </Empty>
      )}
      {connections.some((d) => d.status === "configured") && (
        <small>
          Configured databases are declared by their source; the last check
          could not verify them.
        </small>
      )}
    </>
  );
}
export function Storage() {
  const { projects } = useMonitor();
  const usage = usePoll<DiskUsage>("/api/disk-usage", 3000);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [detail, setDetail] = useState<string | null>(null);
  const scan = async (id: string) => {
    setBusy(true);
    setError("");
    try {
      await api(`/api/disk-usage?scan=1&project=${encodeURIComponent(id)}`);
      usage.refresh();
    } catch (e) {
      setError(String(e));
      usage.refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {(error || usage.error) && (
        <Notice retry={usage.refresh}>{error || usage.error}</Notice>
      )}
      {[...projects]
        .sort(
          (a, b) =>
            (usage.data?.projects[b.id]?.bytes ?? 0) -
            (usage.data?.projects[a.id]?.bytes ?? 0),
        )
        .map((p) => {
          const d = usage.data?.projects[p.id];
          const docker = d?.docker;
          return (
            <Panel
              key={p.id}
              title={p.name}
              actions={
                <button
                  disabled={busy || !!usage.data?.scanning}
                  onClick={() => void scan(p.id)}
                >
                  {usage.data?.scanning === p.id
                    ? "Scanning…"
                    : d
                      ? "Rescan"
                      : "Scan project"}
                </button>
              }
            >
              <CheckoutActions
                primary
                path={p.info?.primary_path ?? p.worktrees[0]?.path ?? ""}
              />
              {d ? (
                <>
                  <p>
                    {bytes(d.bytes)} on disk · scanned {ago(d.scanned_at)}{" "}
                    {d.partial ? "· partial scan (lower bound)" : ""}
                  </p>
                  {d.error && <Notice>{d.error}</Notice>}
                  <div className="st-table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Worktree</th>
                          <th>Total</th>
                          <th>Dependencies</th>
                          <th>Build/cache</th>
                          <th>Git</th>
                          <th>Other</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.worktrees.map((w) => (
                          <tr key={w.path}>
                            <td>
                              <button onClick={() => setDetail(w.worktree_id)}>
                                {w.branch}
                              </button>
                              <CheckoutActions path={w.path} />
                              {w.partial && (
                                <small title={w.notes.join("; ")}>
                                  Partial · {w.notes.join("; ")}
                                </small>
                              )}
                            </td>
                            <td>{bytes(w.bytes)}</td>
                            {[
                              "dependencies",
                              "build_cache",
                              "git",
                              "other",
                            ].map((k) => (
                              <td key={k}>{bytes(w.categories[k])}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {docker?.available ? (
                    <p>
                      <small>
                        Docker · {docker.container_count} containers including
                        stopped · writable {bytes(docker.writable_bytes)} ·
                        images {bytes(docker.image_bytes)}
                        {docker.shared_images ? " (shared)" : ""} · volumes{" "}
                        {bytes(docker.volume_bytes)}
                        {docker.shared_volumes ? " (shared)" : ""}
                        {docker.partial ? " · some sizes unavailable" : ""}
                      </small>
                    </p>
                  ) : (
                    <p>
                      <small>
                        {docker?.status ||
                          "Docker disk accounting unavailable."}
                      </small>
                    </p>
                  )}
                  <small>
                    Allocated blocks; links are not followed. Shared Docker
                    storage is not included in project disk totals. Scanning
                    deletes nothing.
                  </small>
                </>
              ) : (
                <Empty>
                  {usage.data?.scanning === p.id
                    ? "Measuring directory sizes in the background."
                    : "Not scanned yet."}
                </Empty>
              )}
            </Panel>
          );
        })}
      {!projects.length && <Empty>No projects discovered.</Empty>}
      {detail && <WorktreeDetail id={detail} close={() => setDetail(null)} />}
    </>
  );
}

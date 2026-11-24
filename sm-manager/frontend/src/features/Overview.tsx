import { useState } from "react";
import { bytes, percent } from "../lib/api";
import { Panel, Metric, Notice, Empty } from "../components/Ui";
import {
  CopyReport,
  CopyText,
  cleanupBrief,
  useMonitor,
} from "./MonitorContext";
import { Projects, ProcessTable, WorktreeDetail } from "./Resources";
import { HistoryChart } from "./HistoryChart";
import { codexColor, otherColor, projectColors } from "../lib/resourceHistory";
export function Overview() {
  const { snapshot } = useMonitor();
  const [selected, setSelected] = useState<Set<string>>(new Set()),
    [brief, setBrief] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [detail, setDetail] = useState<string | null>(null);
  const s = snapshot.data;
  if (!s)
    return (
      <Notice retry={snapshot.refresh}>
        {snapshot.error || "Collecting the first sample…"}
      </Notice>
    );
  const chosen = s.cleanup_candidates.filter((c) =>
    selected.has(c.worktree_id),
  );
  const prepare = async () => {
    setBusy(true);
    setError("");
    try {
      const plans = await Promise.all(
        chosen.map((c) => cleanupBrief(c.worktree_id)),
      );
      setBrief(
        plans
          .map((p) => p.prompt + "\n" + JSON.stringify(p.resources, null, 2))
          .join("\n\n"),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const colors = projectColors(s.projects);
  const allocated = [
    ...s.projects
      .filter((p) => p.memory_bytes > 0)
      .slice(0, 6)
      .map((p) => ({
        label: p.name,
        value: p.memory_bytes,
        color: colors.get(p.id)!,
      })),
    ...(s.codex.memory_bytes > 0
      ? [
          {
            label: "Codex processes",
            value: s.codex.memory_bytes,
            color: codexColor,
          },
        ]
      : []),
    {
      label: "System & other",
      color: otherColor,
      value: Math.max(
        0,
        s.system.memory_used - s.totals.memory_bytes - s.codex.memory_bytes,
      ),
    },
  ];
  const allocationMaximum = Math.max(1, ...allocated.map((item) => item.value));
  return (
    <>
      <div className="st-metrics metrics">
        <Metric
          label="Memory"
          value={bytes(s.system.memory_used)}
          detail={`of ${bytes(s.system.memory_total)}`}
        />
        <Metric
          label="Machine CPU"
          value={percent(s.system.cpu_percent)}
          detail={`${s.system.cores} logical cores`}
        />
        <Metric
          label="Swap"
          value={bytes(s.system.swap_used)}
          detail={`of ${bytes(s.system.swap_total)}`}
        />
        <Metric
          label="Running worktrees"
          value={s.totals.running_worktrees}
          detail={`of ${s.totals.worktree_count}`}
        />
      </div>
      <Panel title="Machine health" actions={<CopyReport />}>
        <div className="st-health">
          {s.machine_health?.checks.map((c) => (
            <article key={c.id} data-status={c.status}>
              <span>
                {c.label} · {c.status}
              </span>
              <strong>{c.value}</strong>
              <small>{c.detail}</small>
            </article>
          )) ?? <Empty>Health checks unavailable.</Empty>}
        </div>
      </Panel>
      <div className="overview-grid">
        <HistoryChart snapshot={s} />
        <Panel
          title="Memory allocation"
          className="allocation-panel"
          actions={<span className="subtle-tag">LIVE</span>}
        >
          <div id="allocation">
            {allocated.map((a, i) => {
              const color = a.color;
              return (
                <div className="allocation-row" key={i}>
                  <div className="allocation-label">
                    <span
                      className="allocation-color"
                      style={{ background: color }}
                    />
                    <strong>{a.label}</strong>
                    <span>{bytes(a.value)}</span>
                  </div>
                  <div
                    className="allocation-track"
                    role="meter"
                    aria-label={a.label}
                    aria-valuemin={0}
                    aria-valuemax={allocationMaximum}
                    aria-valuenow={a.value}
                    aria-valuetext={bytes(a.value)}
                  >
                    <span
                      style={{
                        width: `${(a.value / allocationMaximum) * 100}%`,
                        background: color,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="allocation-note">
            RSS + container working set; shared pages may overlap. System &amp;
            other is the remainder, including unassigned containers.
          </div>
        </Panel>
      </div>
      <Panel
        title="Cleanup candidates"
        actions={
          <button
            disabled={!chosen.length || busy}
            onClick={() => void prepare()}
          >
            {busy ? "Preparing…" : "Prepare combined brief"}
          </button>
        }
      >
        {s.cleanup_candidates.length ? (
          <div className="st-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Select</th>
                  <th>Project / worktree</th>
                  <th>Memory</th>
                  <th>Average CPU</th>
                  <th>Observed</th>
                </tr>
              </thead>
              <tbody>
                {s.cleanup_candidates.map((c) => (
                  <tr key={c.worktree_id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${c.project_name} ${c.branch}`}
                        checked={selected.has(c.worktree_id)}
                        onChange={(e) =>
                          setSelected((old) => {
                            const next = new Set(old);
                            if (e.target.checked) next.add(c.worktree_id);
                            else next.delete(c.worktree_id);
                            return next;
                          })
                        }
                      />
                    </td>
                    <td>
                      <button onClick={() => setDetail(c.worktree_id)}>
                        {c.project_name} / {c.branch}
                      </button>
                    </td>
                    <td>{bytes(c.memory_bytes)}</td>
                    <td>{percent(c.cpu_average)}</td>
                    <td>{Math.round(c.observed_seconds / 60)} min</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>
            No candidates right now. Apps need continuous low-CPU samples with
            no recent Codex metadata updates.
          </Empty>
        )}
        <p>
          <small>
            {chosen.length} selected ·{" "}
            {bytes(chosen.reduce((v, c) => v + c.memory_bytes, 0))}. Low CPU
            does not mean safe to stop. Briefs require fresh ownership checks
            and preserve source, databases and volumes.
          </small>
        </p>
        {error && <Notice>{error}</Notice>}
        {brief && (
          <>
            <CopyText text={brief} label="Copy combined brief" />
            <details>
              <summary>Review brief</summary>
              <pre className="st-copy">{brief}</pre>
            </details>
          </>
        )}
      </Panel>
      <h2 className="st-page-heading">Projects</h2>
      <Projects />
      <Panel title="Larger host processes">
        <ProcessTable items={s.other_processes} />
      </Panel>
      {detail && <WorktreeDetail id={detail} close={() => setDetail(null)} />}
    </>
  );
}

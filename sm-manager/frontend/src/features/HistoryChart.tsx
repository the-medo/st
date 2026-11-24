import { useEffect, useState } from "react";
import { api, bytes, percent } from "../lib/api";
import type { History, Snapshot } from "../lib/types";
import { Chart, type Series } from "../components/Chart";
import { Notice } from "../components/Ui";
const colors = [
  "#f0f6fc",
  "#63cf8c",
  "#c4b5fd",
  "#91a0b2",
  "#58a6ff",
  "#f0b65f",
  "#f778ba",
];
export function HistoryChart({
  snapshot,
  initialEntity = "all",
}: {
  snapshot: Snapshot;
  initialEntity?: string;
}) {
  const [hours, setHours] = useState(24),
    [metric, setMetric] = useState<"memory_bytes" | "cpu_percent">(
      "memory_bytes",
    ),
    [scale, setScale] = useState("usage"),
    [entity, setEntity] = useState(initialEntity);
  const [data, setData] = useState<{
    key: string;
    series: Series[];
    failed: number;
    at: number;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  const choices = [
    { id: "host", label: "Whole machine", dash: false },
    { id: "projects", label: "All projects · total", dash: true },
    { id: "codex", label: "Codex processes", dash: false },
    { id: "other", label: "System & other", dash: false },
    ...snapshot.projects.flatMap((p) => [
      { id: `project:${p.id}`, label: p.name, dash: false },
      ...p.worktrees.map((w) => ({
        id: `worktree:${w.id}`,
        label: `${p.name} / ${w.branch}`,
        dash: false,
      })),
    ]),
  ];
  const selected =
    entity === "all"
      ? choices.filter((c) => !c.id.startsWith("worktree:"))
      : choices.filter((c) => c.id === entity);
  const selection = JSON.stringify(selected);
  const key = `${hours}:${entity}:${metric}:${selection}`;
  useEffect(() => {
    let stopped = false;
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending || document.hidden) return;
      pending = true;
      const targets = JSON.parse(selection) as typeof selected;
      const results = await Promise.allSettled(
        targets.map((c) =>
          api<History>(
            `/api/history?hours=${hours}&entity=${encodeURIComponent(c.id)}`,
            {
              signal: AbortSignal.any([
                controller.signal,
                AbortSignal.timeout(15000),
              ]),
            },
          ),
        ),
      );
      if (!stopped)
        setData({
          key,
          at: Date.now() / 1000,
          failed: results.filter((r) => r.status === "rejected").length,
          series: results.flatMap((r, i) =>
            r.status === "fulfilled"
              ? [
                  {
                    id: targets[i]!.id,
                    label: targets[i]!.label,
                    color: colors[i % colors.length]!,
                    dash: targets[i]!.dash,
                    gap: r.value.bucket_seconds,
                    points: r.value.points.map((p) => ({
                      timestamp: p.timestamp,
                      value: p[metric],
                    })),
                  },
                ]
              : [],
          ),
        });
      pending = false;
    };
    void load();
    const timer = setInterval(load, 30000);
    document.addEventListener("visibilitychange", load);
    return () => {
      stopped = true;
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [selection, hours, metric, key, retry]);
  const current = data?.key === key ? data : null;
  return (
    <>
      <div className="st-toolbar">
        <label>
          Range
          <select
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
          >
            {[
              [0.25, "15m"],
              [1, "1h"],
              [6, "6h"],
              [24, "24h"],
              [168, "7d"],
              [720, "30d"],
            ].map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          Metric
          <select
            value={metric}
            onChange={(e) => setMetric(e.target.value as typeof metric)}
          >
            <option value="memory_bytes">Memory</option>
            <option value="cpu_percent">CPU</option>
          </select>
        </label>
        <label>
          Scale
          <select value={scale} onChange={(e) => setScale(e.target.value)}>
            <option value="usage">Zoom to usage</option>
            <option value="capacity">Full capacity</option>
          </select>
        </label>
        <label>
          Source
          <select value={entity} onChange={(e) => setEntity(e.target.value)}>
            <option value="all">All — resource comparison</option>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {current?.failed ? (
        <Notice retry={() => setRetry((v) => v + 1)}>
          {current.failed} series unavailable. Available series remain visible.
        </Notice>
      ) : null}
      {!current ? (
        <Notice>Loading history…</Notice>
      ) : (
        <Chart
          series={current.series}
          format={metric === "memory_bytes" ? bytes : percent}
          ceiling={
            scale === "capacity"
              ? metric === "memory_bytes"
                ? snapshot.system.memory_total
                : 100
              : undefined
          }
          start={current.at - hours * 3600}
          end={current.at}
        />
      )}
      <small>
        30-day retention · project RSS and container working sets may overlap.
      </small>
    </>
  );
}

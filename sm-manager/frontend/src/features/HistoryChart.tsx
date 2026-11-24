import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { History, Snapshot } from "../lib/types";
import { historySources } from "../lib/resourceHistory";
import { Chart } from "../components/Chart";
import { Notice } from "../components/Ui";

const ranges = [
  [0.25, "15m"],
  [1, "1h"],
  [6, "6h"],
  [24, "24h"],
  [168, "7d"],
  [720, "30d"],
] as const;
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
    [scale, setScale] = useState<"usage" | "capacity">("usage"),
    [entity, setEntity] = useState(initialEntity);
  const choices = historySources(snapshot);
  const selected =
    entity === "all"
      ? choices.filter((c) => !c.id.startsWith("worktree:"))
      : choices.filter((c) => c.id === entity);
  const selection = JSON.stringify(selected);
  const key = `${hours}:${entity}:${selection}`;
  const [data, setData] = useState<{
    key: string;
    series: ((typeof choices)[number] & { history: History | null })[];
    at: number;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let stopped = false,
      pending = false;
    const controller = new AbortController();
    const load = async () => {
      if (pending || stopped || document.hidden) return;
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
          series: results.map((result, i) => ({
            ...targets[i]!,
            history: result.status === "fulfilled" ? result.value : null,
          })),
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
  }, [selection, hours, key, retry]);
  const current = data?.key === key ? data : null;
  const failed =
    current?.series.filter((series) => !series.history).length ?? 0;
  const starts =
    current?.series.flatMap((series) =>
      series.history?.started_at == null ? [] : [series.history.started_at],
    ) ?? [];
  const historyNote = !current
    ? "Loading samples…"
    : failed
      ? `${failed} series unavailable · available series shown`
      : starts.length
        ? `Since ${new Date(Math.min(...starts) * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })} · bucket averages · gaps = no data`
        : "No samples in this range";
  return (
    <section className="st-panel panel history-panel">
      <div className="panel-heading">
        <h2>Resource activity</h2>
        <div className="segmented" role="group" aria-label="History range">
          {ranges.map(([value, label]) => (
            <button
              key={value}
              aria-pressed={hours === value}
              className={hours === value ? "selected" : ""}
              onClick={() => setHours(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="chart-toolbar">
        <div className="chart-tabs" role="group" aria-label="History metric">
          {(["memory_bytes", "cpu_percent"] as const).map((value) => (
            <button
              key={value}
              aria-pressed={metric === value}
              className={metric === value ? "selected" : ""}
              onClick={() => setMetric(value)}
            >
              {value === "memory_bytes" ? "Memory" : "CPU"}
            </button>
          ))}
        </div>
        <span className="chart-unit">
          {ranges.find(([value]) => value === hours)?.[1]} ·{" "}
          {metric === "memory_bytes" ? "memory" : "machine CPU %"}
        </span>
        <select
          className="st-history-scale"
          aria-label="Chart scale"
          value={scale}
          onChange={(event) => setScale(event.target.value as typeof scale)}
        >
          <option value="capacity">Full capacity</option>
          <option value="usage">Zoom to usage</option>
        </select>
        <select
          className="st-history-source"
          aria-label="History source"
          value={entity}
          onChange={(event) => setEntity(event.target.value)}
        >
          <option value="all">All — resource comparison</option>
          {choices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.id === "projects" ? "All projects · total" : choice.label}
            </option>
          ))}
        </select>
      </div>
      {failed > 0 && (
        <Notice retry={() => setRetry((value) => value + 1)}>
          {failed} series unavailable. Available series remain visible.
        </Notice>
      )}
      <Chart
        series={
          current?.series.map((series) => ({
            ...series,
            error: !series.history,
            gap: series.history?.bucket_seconds ?? 60,
            points:
              series.history?.points.map((point) => ({
                timestamp: point.timestamp,
                value: point[metric],
              })) ?? [],
          })) ?? []
        }
        metric={metric}
        scale={scale}
        capacity={snapshot.system.memory_total}
        start={current ? current.at - hours * 3600 : 0}
        end={current?.at ?? 0}
        loading={!current}
        viewKey={`${hours}:${entity}:${metric}`}
      />
      <div className="chart-footer">
        <span>{historyNote}</span>
        <span>30-day retention</span>
      </div>
    </section>
  );
}

import { useState } from "react";
export type ChartPoint = { timestamp: number; value: number | null };
export type Series = {
  id: string;
  label: string;
  color: string;
  points: ChartPoint[];
  gap: number;
  dash?: boolean;
};
export function segments(points: ChartPoint[], gap: number): ChartPoint[][] {
  const result: ChartPoint[][] = [];
  let line: ChartPoint[] = [];
  let previous: number | null = null;
  for (const p of points) {
    if (
      p.value == null ||
      !Number.isFinite(p.value) ||
      (previous != null && p.timestamp - previous > gap * 2.5)
    ) {
      if (line.length) result.push(line);
      line = [];
    }
    if (p.value != null && Number.isFinite(p.value)) line.push(p);
    previous = p.timestamp;
  }
  if (line.length) result.push(line);
  return result;
}
export function Chart({
  series,
  ceiling,
  format,
  compact = false,
  start,
  end,
}: {
  series: Series[];
  ceiling?: number;
  format: (v: number) => string;
  compact?: boolean;
  start?: number;
  end?: number;
}) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState<number | null>(null);
  const shown = series.filter((s) => !hidden.has(s.id));
  const points = shown.flatMap((s) => s.points);
  const times = [...new Set(points.map((p) => p.timestamp))].sort(
    (a, b) => a - b,
  );
  const min = start ?? times[0] ?? 0;
  const max = Math.max(min + 1, end ?? times.at(-1) ?? 1);
  const highest = Math.max(1, ...points.map((p) => p.value ?? 0));
  const top = Math.max(ceiling ?? highest * 1.12, highest);
  const width = 900;
  const height = compact ? 90 : 260;
  const x = (ts: number) => ((ts - min) / (max - min)) * (width - 16) + 8;
  const y = (v: number) => height - 12 - (v / top) * (height - 24);
  const selected =
    cursor == null
      ? null
      : times[Math.max(0, Math.min(times.length - 1, cursor))];
  const toggle = (id: string) =>
    setHidden((old) => {
      const n = new Set(old);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <div className={`st-chart ${compact ? "compact" : ""}`}>
      {!compact && <span className="st-chart-cap">{format(top)}</span>}
      {times.length ? (
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          role="group"
          aria-label="History chart. Arrow keys inspect samples; Escape dismisses."
          tabIndex={compact ? undefined : 0}
          onKeyDown={(e) => {
            if (
              ["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(
                e.key,
              )
            ) {
              e.preventDefault();
              setCursor(
                e.key === "Escape"
                  ? null
                  : e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? times.length - 1
                      : Math.max(
                          0,
                          Math.min(
                            times.length - 1,
                            (cursor ?? times.length - 1) +
                              (e.key === "ArrowLeft" ? -1 : 1),
                          ),
                        ),
              );
            }
          }}
          onPointerMove={(e) => {
            if (compact) return;
            const box = e.currentTarget.getBoundingClientRect();
            const ts = min + ((e.clientX - box.left) / box.width) * (max - min);
            setCursor(
              times.reduce(
                (best, t, i) =>
                  Math.abs(t - ts) < Math.abs(times[best]! - ts) ? i : best,
                0,
              ),
            );
          }}
          onPointerLeave={() => setCursor(null)}
        >
          {!compact &&
            [0, 0.25, 0.5, 0.75, 1].map((n) => (
              <line
                key={n}
                x1={8}
                x2={width - 8}
                y1={y(top * n)}
                y2={y(top * n)}
                className="st-gridline"
              />
            ))}
          {shown.flatMap((s) =>
            segments(s.points, s.gap).map((line, i) => (
              <polyline
                key={`${s.id}-${i}`}
                points={line
                  .map((p) => `${x(p.timestamp)},${y(p.value!)}`)
                  .join(" ")}
                fill="none"
                stroke={s.color}
                strokeWidth={compact ? 3 : 2}
                strokeDasharray={s.dash ? "8 5" : undefined}
                vectorEffect="non-scaling-stroke"
              />
            )),
          )}
          {selected != null && (
            <line
              x1={x(selected)}
              x2={x(selected)}
              y1={0}
              y2={height}
              stroke="currentColor"
              opacity=".4"
            />
          )}
        </svg>
      ) : (
        <EmptyChart />
      )}
      {!compact && (
        <>
          <div className="st-chart-times">
            <span>{new Date(min * 1000).toLocaleString()}</span>
            <span>{new Date(max * 1000).toLocaleString()}</span>
          </div>
          <div className="st-legend">
            {series.map((s) => (
              <button
                key={s.id}
                aria-pressed={!hidden.has(s.id)}
                onClick={() => toggle(s.id)}
              >
                <span style={{ background: s.color }} />
                {s.label}
              </button>
            ))}
          </div>
          <div className="st-chart-tooltip" role="status">
            {selected != null ? (
              <>
                <time>{new Date(selected * 1000).toLocaleString()}</time>
                {shown.map((s) => {
                  const point = s.points.find((p) => p.timestamp === selected);
                  return (
                    <span key={s.id}>
                      {s.label}:{" "}
                      {point?.value == null ? "—" : format(point.value)}
                    </span>
                  );
                })}
              </>
            ) : (
              "Bucket averages · gaps indicate missing data"
            )}
          </div>
        </>
      )}
    </div>
  );
}
function EmptyChart() {
  return <p className="st-empty">Waiting for history…</p>;
}

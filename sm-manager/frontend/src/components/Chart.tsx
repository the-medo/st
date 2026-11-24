import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from "react";
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

/** Independent series can have slightly different sample times. Never bridge a missing bucket. */
export function sampleAt(
  points: ChartPoint[],
  timestamp: number,
  bucket: number,
): ChartPoint | null {
  let nearest: ChartPoint | null = null;
  for (const point of points) {
    if (!Number.isFinite(point.timestamp)) continue;
    if (
      !nearest ||
      Math.abs(point.timestamp - timestamp) <
        Math.abs(nearest.timestamp - timestamp)
    )
      nearest = point;
  }
  return nearest &&
    Math.abs(nearest.timestamp - timestamp) <= Math.max(0, bucket) / 2 &&
    nearest.value != null &&
    Number.isFinite(nearest.value)
    ? nearest
    : null;
}
const nearestTime = (times: number[], timestamp: number) =>
  times.reduce((best, time) =>
    Math.abs(time - timestamp) < Math.abs(best - timestamp) ? time : best,
  );
type Cursor = { timestamp: number; y: number; input: "pointer" | "keyboard" };
type TooltipRow = { series: Series; point: ChartPoint | null };

function ChartTooltip({
  id,
  plot,
  timestamp,
  anchorX,
  anchorY,
  keyboard,
  rows,
  format,
}: {
  id: string;
  plot: RefObject<HTMLDivElement | null>;
  timestamp: number;
  anchorX: number;
  anchorY: number;
  keyboard: boolean;
  rows: TooltipRow[];
  format: (value: number) => string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({
    left: 4,
    top: 4,
    maxHeight: 320,
    visible: false,
  });
  useLayoutEffect(() => {
    const element = plot.current,
      tooltip = ref.current;
    if (!element || !tooltip) return;
    const place = () => {
      const box = element.getBoundingClientRect();
      let visibleTop = Math.max(4, -box.top + 4);
      let visibleBottom = Math.min(
        box.height - 4,
        window.innerHeight - box.top - 4,
      );
      for (
        let ancestor = element.parentElement;
        ancestor;
        ancestor = ancestor.parentElement
      ) {
        if (
          !/(auto|scroll|hidden|clip)/.test(
            getComputedStyle(ancestor).overflowY,
          )
        )
          continue;
        const clip = ancestor.getBoundingClientRect();
        visibleTop = Math.max(visibleTop, clip.top - box.top + 4);
        visibleBottom = Math.min(visibleBottom, clip.bottom - box.top - 4);
      }
      if (visibleBottom - visibleTop < 40) {
        setPosition((old) => (old.visible ? { ...old, visible: false } : old));
        return;
      }
      const maxHeight = Math.max(40, Math.min(320, visibleBottom - visibleTop));
      const height = Math.min(tooltip.offsetHeight, maxHeight);
      const width = tooltip.offsetWidth;
      const x = anchorX * box.width,
        y = anchorY * box.height;
      const left = Math.max(
        4,
        Math.min(
          box.width - width - 4,
          x + width + 14 <= box.width ? x + 14 : x - width - 14,
        ),
      );
      const top = Math.max(
        visibleTop,
        Math.min(visibleBottom - height, y + 14),
      );
      setPosition((old) =>
        old.left === left &&
        old.top === top &&
        old.maxHeight === maxHeight &&
        old.visible
          ? old
          : { left, top, maxHeight, visible: true },
      );
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    observer.observe(tooltip);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [plot, anchorX, anchorY]);
  const maximum = Math.max(1, ...rows.map((row) => row.point?.value ?? 0));
  return (
    <div
      ref={ref}
      id={id}
      className="st-chart-tooltip"
      role="tooltip"
      aria-live={keyboard ? "polite" : "off"}
      style={{
        left: position.left,
        top: position.top,
        maxHeight: position.maxHeight,
        visibility: position.visible ? "visible" : "hidden",
      }}
    >
      <div className="tooltip-heading">
        <strong>
          <time dateTime={new Date(timestamp * 1000).toISOString()}>
            {new Date(timestamp * 1000).toLocaleString()}
          </time>
        </strong>
        <span>Sample readings</span>
      </div>
      {rows.map(({ series, point }) => (
        <div className="allocation-row" key={series.id}>
          <div className="allocation-label">
            <span
              className="allocation-color"
              style={{ background: series.color }}
            />
            <strong>{series.label}</strong>
            <span>{point ? format(point.value!) : "—"}</span>
          </div>
          <div className="allocation-track" aria-hidden="true">
            <span
              style={{
                background: series.color,
                width: `${(Math.max(0, point?.value ?? 0) / maximum) * 100}%`,
              }}
            />
          </div>
        </div>
      ))}
      <div className="tooltip-note">— = no sample · Escape dismisses</div>
    </div>
  );
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
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const root = useRef<HTMLDivElement>(null),
    plot = useRef<HTMLDivElement>(null);
  const tooltipId = useId();
  const shown = useMemo(
    () => series.filter((s) => !hidden.has(s.id)),
    [series, hidden],
  );
  const points = useMemo(() => shown.flatMap((s) => s.points), [shown]);
  const times = useMemo(
    () =>
      [...new Set(points.map((p) => p.timestamp).filter(Number.isFinite))].sort(
        (a, b) => a - b,
      ),
    [points],
  );
  const min = start ?? times[0] ?? 0;
  const max = Math.max(min + 1, end ?? times.at(-1) ?? 1);
  const highest = useMemo(
    () =>
      points.reduce(
        (maximum, point) =>
          Number.isFinite(point.value)
            ? Math.max(maximum, point.value!)
            : maximum,
        1,
      ),
    [points],
  );
  const top = Math.max(ceiling ?? highest * 1.12, highest);
  const width = 900,
    height = compact ? 90 : 260;
  const x = (ts: number) => ((ts - min) / (max - min)) * (width - 16) + 8;
  const y = (v: number) => height - 12 - (v / top) * (height - 24);
  const selected =
    cursor && times.length ? nearestTime(times, cursor.timestamp) : null;
  const rows = useMemo(
    () =>
      selected == null
        ? []
        : shown.map((series) => ({
            series,
            point: sampleAt(series.points, selected, series.gap),
          })),
    [shown, selected],
  );
  const open = selected != null;
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: globalThis.PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setCursor(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setCursor(null);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  const inspect = (event: PointerEvent<SVGSVGElement>) => {
    if (compact || !times.length) return;
    const box = event.currentTarget.getBoundingClientRect();
    // Match the SVG's inset plot, rather than treating its padding as time.
    const ratio = Math.max(
      0,
      Math.min(
        1,
        (((event.clientX - box.left) / box.width) * width - 8) / (width - 16),
      ),
    );
    setCursor({
      timestamp: nearestTime(times, min + ratio * (max - min)),
      y: (event.clientY - box.top) / box.height,
      input: "pointer",
    });
  };
  const toggle = (id: string) => {
    setCursor(null);
    setHidden((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  return (
    <div ref={root} className={`st-chart ${compact ? "compact" : ""}`}>
      {!compact && <span className="st-chart-cap">{format(top)}</span>}
      <div
        ref={plot}
        className="st-chart-plot"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget))
            setCursor(null);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType !== "touch")
            setCursor((current) =>
              current?.input === "keyboard" ? current : null,
            );
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            setCursor(null);
          }
        }}
      >
        {times.length ? (
          <svg
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            role="group"
            aria-label="History chart. Arrow keys inspect samples; Escape dismisses."
            aria-describedby={open ? tooltipId : undefined}
            tabIndex={compact ? undefined : 0}
            onFocus={() => {
              if (!compact)
                setCursor(
                  (current) =>
                    current ?? {
                      timestamp: times.at(-1)!,
                      y: 0,
                      input: "keyboard",
                    },
                );
            }}
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              const current =
                selected == null ? times.length - 1 : times.indexOf(selected);
              const index =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? times.length - 1
                    : Math.max(
                        0,
                        Math.min(
                          times.length - 1,
                          current + (event.key === "ArrowLeft" ? -1 : 1),
                        ),
                      );
              setCursor({ timestamp: times[index]!, y: 0, input: "keyboard" });
            }}
            onPointerMove={(event) => {
              if (event.pointerType !== "touch") inspect(event);
            }}
            onPointerDown={inspect}
            onPointerCancel={() => setCursor(null)}
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
                y1={12}
                y2={height - 12}
                className="st-chart-crosshair"
              />
            )}
          </svg>
        ) : (
          <p className="st-empty">Waiting for history…</p>
        )}
        {selected != null && cursor && !compact && (
          <>
            {rows.map(
              ({ series, point }) =>
                point && (
                  <span
                    key={series.id}
                    className="st-chart-marker"
                    aria-hidden="true"
                    style={{
                      left: `${(x(selected) / width) * 100}%`,
                      top: `${(y(point.value!) / height) * 100}%`,
                      background: series.color,
                    }}
                  />
                ),
            )}
            <ChartTooltip
              id={tooltipId}
              plot={plot}
              timestamp={selected}
              anchorX={x(selected) / width}
              anchorY={cursor.y}
              keyboard={cursor.input === "keyboard"}
              rows={rows}
              format={format}
            />
          </>
        )}
      </div>
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
          <div className="st-chart-note">
            Bucket averages · gaps indicate missing data
          </div>
        </>
      )}
    </div>
  );
}

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type RefObject,
} from "react";
import { bytes, percent } from "../lib/api";
import { resourceCeiling } from "../lib/resourceHistory";
export type ChartPoint = { timestamp: number; value: number | null };
export type Series = {
  id: string;
  label: string;
  color: string;
  points: ChartPoint[];
  gap: number;
  dash?: string;
  total?: boolean;
  error?: boolean;
  description?: string;
};
export function segments(
  points: ChartPoint[],
  gap: number,
  tolerance = 2.5,
): ChartPoint[][] {
  const result: ChartPoint[][] = [];
  let line: ChartPoint[] = [];
  let previous: number | null = null;
  for (const p of points) {
    if (
      p.value == null ||
      !Number.isFinite(p.value) ||
      (previous != null && p.timestamp - previous > gap * tolerance)
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
  capacity,
}: {
  id: string;
  plot: RefObject<HTMLDivElement | null>;
  timestamp: number;
  anchorX: number;
  anchorY: number;
  keyboard: boolean;
  rows: TooltipRow[];
  format: (value: number) => string;
  capacity: number;
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
  const bucket = rows[0]?.series.gap ?? 60;
  const timeOptions: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
    ...(bucket < 60 ? { second: "2-digit" } : {}),
    hour12: false,
  };
  const until = new Date((timestamp + bucket) * 1000);
  const crossesDay =
    new Date(timestamp * 1000).toDateString() !== until.toDateString();
  const maximum = Math.max(1, ...rows.map((row) => row.point?.value ?? 0));
  return (
    <div
      ref={ref}
      id={id}
      className="chart-tooltip st-chart-tooltip"
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
            {new Date(timestamp * 1000).toLocaleString([], {
              month: "short",
              day: "numeric",
              ...timeOptions,
            })}
          </time>
          –
          {until.toLocaleString([], {
            ...(crossesDay ? { month: "short", day: "numeric" } : {}),
            ...timeOptions,
          })}
        </strong>
        <span>Bucket averages</span>
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
      <div className="tooltip-note">
        {capacity ? `${bytes(capacity)} total capacity · ` : ""}— = no sample ·
        Escape dismisses
      </div>
    </div>
  );
}

export function Chart({
  series,
  metric,
  scale,
  capacity,
  start,
  end,
  loading,
  viewKey,
}: {
  series: Series[];
  metric: "memory_bytes" | "cpu_percent";
  scale: "usage" | "capacity";
  capacity: number;
  start: number;
  end: number;
  loading: boolean;
  viewKey: string;
}) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [size, setSize] = useState({ width: 900, height: 600 });
  const root = useRef<HTMLDivElement>(null),
    plot = useRef<HTMLDivElement>(null);
  const tooltipId = useId();
  useEffect(() => {
    const element = plot.current!;
    const observer = new ResizeObserver(() =>
      setSize({
        width: Math.max(250, element.clientWidth),
        height: element.clientHeight || 600,
      }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => setCursor(null), [viewKey]);
  const shown = useMemo(
    () => series.filter((series) => !hidden.has(series.id) && !series.error),
    [series, hidden],
  );
  const points = useMemo(
    () => shown.flatMap((series) => series.points),
    [shown],
  );
  const times = useMemo(
    () =>
      [
        ...new Set(
          points
            .filter(
              (point) =>
                Number.isFinite(point.timestamp) &&
                point.value != null &&
                Number.isFinite(point.value),
            )
            .map((point) => point.timestamp),
        ),
      ].sort((a, b) => a - b),
    [points],
  );
  const memory = metric === "memory_bytes",
    format = memory ? bytes : percent;
  const highest = points.reduce(
    (maximum, point) =>
      Number.isFinite(point.value) ? Math.max(maximum, point.value!) : maximum,
    0,
  );
  const ceiling = resourceCeiling(memory, scale, capacity, highest);
  const { width, height } = size;
  const left = 52,
    right = 10,
    top = 25,
    bottom = 25;
  const graphW = width - left - right,
    graphH = height - top - bottom;
  const x = (timestamp: number) =>
    left +
    Math.max(0, Math.min(1, (timestamp - start) / Math.max(1, end - start))) *
      graphW;
  const y = (value: number) => top + graphH - (value / ceiling) * graphH;
  const axisValue = (value: number) =>
    memory
      ? ceiling >= 1024 ** 3
        ? `${(value / 1024 ** 3).toFixed(1)}G`
        : `${(value / 1024 ** 2).toFixed(0)}M`
      : `${value.toFixed(ceiling < 5 ? 1 : 0)}%`;
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
    if (!times.length) return;
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(
      0,
      Math.min(1, (event.clientX - box.left - left) / graphW),
    );
    setCursor({
      timestamp: nearestTime(times, start + ratio * (end - start)),
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
  const failed = series.filter((series) => series.error).length;
  const empty = loading
    ? "Loading history…"
    : series.length && failed === series.length
      ? "History unavailable. Retrying…"
      : !shown.length && series.length
        ? "No series selected. Toggle a legend item to show it."
        : "No samples in this range.";
  const ticks = width < 450 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
  const label = `${memory ? "Memory" : "CPU"} history.${memory ? ` Total capacity ${bytes(capacity)}.` : ""} ${shown.length} visible series: ${shown.map((series) => series.label).join(", ")}. Arrow keys inspect samples; Escape dismisses.`;
  return (
    <div ref={root} className="st-chart">
      <div
        ref={plot}
        className="chart st-chart-plot"
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
      >
        {times.length ? (
          <svg
            viewBox={`0 0 ${width} ${height}`}
            role="group"
            aria-roledescription="interactive chart"
            aria-label={label}
            aria-describedby={open ? tooltipId : undefined}
            tabIndex={0}
            onFocus={() =>
              setCursor(
                (current) =>
                  current ?? {
                    timestamp: times.at(-1)!,
                    y: 0,
                    input: "keyboard",
                  },
              )
            }
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
            {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
              <g key={ratio}>
                <line
                  className="chart-grid"
                  x1={left}
                  x2={width - right}
                  y1={y(ceiling * ratio)}
                  y2={y(ceiling * ratio)}
                />
                <text x={left - 8} y={y(ceiling * ratio) + 3} textAnchor="end">
                  {axisValue(ceiling * ratio)}
                </text>
              </g>
            ))}
            {memory && capacity > 0 && (
              <g className="chart-capacity">
                {capacity <= ceiling && (
                  <line
                    x1={left}
                    x2={width - right}
                    y1={y(capacity)}
                    y2={y(capacity)}
                  />
                )}
                <text
                  x={width - right}
                  y={capacity <= ceiling ? y(capacity) - 9 : top - 9}
                  textAnchor="end"
                >
                  {bytes(capacity)} total capacity
                  {capacity > ceiling ? " · zoom to usage" : ""}
                </text>
              </g>
            )}
            {[...shown]
              .sort((a, b) => Number(!!a.total) - Number(!!b.total))
              .map((series) => (
                <g key={series.id} data-series={series.id}>
                  <title>{series.label}</title>
                  {segments(series.points, series.gap, 1.5).map(
                    (segment, index) => (
                      <g key={index}>
                        <path
                          d={segment
                            .map(
                              (point, i) =>
                                `${i ? "L" : "M"}${x(point.timestamp).toFixed(1)},${y(point.value!).toFixed(1)}`,
                            )
                            .join(" ")}
                          fill="none"
                          stroke={series.color}
                          strokeWidth={series.total ? 2 : 1.6}
                          strokeDasharray={series.dash}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        {segment.length === 1 && (
                          <circle
                            cx={x(segment[0]!.timestamp)}
                            cy={y(segment[0]!.value!)}
                            r={2.5}
                            fill={series.color}
                          />
                        )}
                      </g>
                    ),
                  )}
                </g>
              ))}
            {ticks.map((ratio) => (
              <text
                key={ratio}
                x={left + graphW * ratio}
                y={height - 4}
                textAnchor={
                  ratio === 0 ? "start" : ratio === 1 ? "end" : "middle"
                }
              >
                {ratio === 1
                  ? "Now"
                  : new Date(
                      (start + (end - start) * ratio) * 1000,
                    ).toLocaleString(
                      [],
                      end - start > 86400
                        ? { month: "short", day: "numeric" }
                        : { hour: "2-digit", minute: "2-digit", hour12: false },
                    )}
              </text>
            ))}
            {selected != null && (
              <g aria-hidden="true">
                <line
                  x1={x(selected)}
                  x2={x(selected)}
                  y1={top}
                  y2={top + graphH}
                  className="chart-crosshair"
                />
                {rows.map(
                  ({ series, point }) =>
                    point && (
                      <circle
                        key={series.id}
                        cx={x(selected)}
                        cy={y(point.value!)}
                        r={3}
                        fill={series.color}
                        stroke="#0c121a"
                        strokeWidth={1.5}
                      />
                    ),
                )}
              </g>
            )}
          </svg>
        ) : (
          <div className="chart-placeholder" role="status">
            {empty}
          </div>
        )}
        {selected != null && cursor && (
          <ChartTooltip
            id={tooltipId}
            plot={plot}
            timestamp={selected}
            anchorX={x(selected) / width}
            anchorY={cursor.y}
            keyboard={cursor.input === "keyboard"}
            rows={rows}
            format={format}
            capacity={memory ? capacity : 0}
          />
        )}
      </div>
      <div className="chart-legend" role="group" aria-label="Chart series">
        {series.map((series) => (
          <button
            key={series.id}
            className="legend-item"
            data-series-toggle={series.id}
            aria-label={series.label}
            aria-pressed={!hidden.has(series.id)}
            disabled={series.error}
            title={`${series.label} · latest bucket average · click to ${hidden.has(series.id) ? "show" : "hide"}${series.description ? ` · ${series.description}` : ""}`}
            onClick={() => toggle(series.id)}
          >
            <span
              className={`legend-swatch${series.dash ? " dashed" : ""}`}
              style={{ "--series-color": series.color } as CSSProperties}
            />
            <span className="legend-name">{series.label}</span>
            <span className="legend-value">
              {series.error
                ? "unavailable"
                : !series.points.length
                  ? "no samples"
                  : series.points.at(-1)?.value == null
                    ? "—"
                    : format(series.points.at(-1)!.value!)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

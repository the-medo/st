import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import {
  airChartScales,
  airGroups,
  airMetrics,
  airNumber,
  airPercentage,
  airPointStatus,
  finite,
  type AirData,
  type Group,
  type Metric,
  type Scale,
} from "./model";

export const seriesStyle = (metric: Metric) =>
  ({ "--series-color": airMetrics[metric].color }) as CSSProperties;

export function AirChart({
  group,
  data,
  cursor,
  onInspect,
}: {
  group: Group;
  data: AirData | null;
  cursor: number | null;
  onInspect: (timestamp: number) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 220, height: 340 });
  useEffect(() => {
    const element = root.current!;
    const observer = new ResizeObserver(() =>
      setSize({
        width: Math.max(220, element.clientWidth),
        height: element.clientHeight || 340,
      }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const definition = airGroups[group];
  const points =
    data?.points.filter((point) =>
      definition.metrics.some((key) => finite(point[key])),
    ) ?? [];
  const axes = airChartScales(group, data?.points ?? []);
  const { width, height } = size;
  const left = 48,
    right = width - (axes.length > 2 ? 105 : 46),
    top = 32,
    bottom = height - 32;
  const end = data?.now ?? 0,
    start = end - (data?.hours ?? 6) * 3600;
  const x = (time: number) =>
    left + ((time - start) / (end - start)) * (right - left);
  const y = (value: number, axis: Scale) =>
    bottom -
    ((value - axis.minimum) / (axis.maximum - axis.minimum)) * (bottom - top);
  const selected =
    cursor == null
      ? undefined
      : points.find((point) => point.timestamp === cursor);
  const index = selected ? points.indexOf(selected) : points.length - 1;
  const inspect = (event: PointerEvent<HTMLDivElement>) => {
    if (!points.length) return;
    const position =
      event.clientX - event.currentTarget.getBoundingClientRect().left;
    const time = start + ((position - left) / (right - left)) * (end - start);
    const nearest = points.reduce((a, b) =>
      Math.abs(a.timestamp - time) <= Math.abs(b.timestamp - time) ? a : b,
    );
    onInspect(nearest.timestamp);
  };
  const references: [Metric, number, string][] =
    group === "air"
      ? [
          ["co2", 1500, "CO₂ 1,500"],
          ["pm25", 15, "PM2.5 15 · 24h"],
          ["pm10", 45, "PM10 45 · 24h"],
        ]
      : [];
  const timeTicks = width < 350 ? 2 : 3;
  const label = !data
    ? `${definition.label} history loading`
    : !points.length
      ? `${definition.label}: no readings in the selected range`
      : `${definition.label} history over ${data.hours} hours. ${definition.metrics.map((key) => airMetrics[key].label).join(", ")}. Separate scales: ${axes.map((axis) => axis.label).join(", ")}. Arrow keys inspect all readings. Solid lines: bucket means; dashed: peaks. Gaps indicate missing data.`;
  return (
    <>
      <div
        id={`air-legend-${group}`}
        className="air-series-legends"
        aria-label={`${definition.label} series`}
      >
        {data &&
          definition.metrics.map((key) => {
            const metric = airMetrics[key];
            const available = points.some((point) => finite(point[key]));
            const values = points
              .map((point) => point[`${key}_peak`] ?? point[key])
              .filter(finite);
            return (
              <span
                key={key}
                className="air-series-legend"
                data-air-series={key}
                title={
                  available
                    ? `Peak ${airNumber(Math.max(...values), key)} ${metric.unit}`
                    : "No readings"
                }
                style={seriesStyle(key)}
              >
                <i className="air-swatch" aria-hidden="true" />
                <strong>{metric.label}</strong>
                {!available && <small>unavailable</small>}
              </span>
            );
          })}
      </div>
      <div
        id={`air-chart-${group}`}
        ref={root}
        className="chart air-chart"
        tabIndex={0}
        role="img"
        aria-label={label}
        aria-describedby={selected ? `air-reading-${group}` : undefined}
        onPointerMove={inspect}
        onPointerDown={inspect}
        onKeyDown={(event) => {
          if (
            !points.length ||
            !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
          )
            return;
          event.preventDefault();
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? points.length - 1
                : index + (event.key === "ArrowLeft" ? -1 : 1);
          onInspect(
            points[Math.max(0, Math.min(points.length - 1, next))]!.timestamp,
          );
        }}
      >
        {!points.length ? (
          <div className="chart-placeholder">
            {data
              ? "No readings for this section in this range yet."
              : "Waiting for sensor history…"}
          </div>
        ) : (
          <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
            {Array.from({ length: 5 }, (_, i) => {
              const line = bottom - ((bottom - top) * i) / 4;
              return (
                <g key={i}>
                  <line
                    className="chart-grid"
                    x1={left}
                    x2={right}
                    y1={line}
                    y2={line}
                  />
                  {axes.map((axis, index) => (
                    <text
                      key={axis.id}
                      x={index === 0 ? left - 8 : right + 8 + (index - 1) * 58}
                      y={line + 3}
                      textAnchor={index === 0 ? "end" : "start"}
                      style={{ fill: axis.color }}
                    >
                      {airNumber(
                        axis.minimum + ((axis.maximum - axis.minimum) * i) / 4,
                        axis.metrics[0],
                      )}
                    </text>
                  ))}
                </g>
              );
            })}
            {axes.map((axis, index) => (
              <text
                key={axis.id}
                x={index === 0 ? left : index === 1 ? right : width - 8}
                y={15}
                textAnchor={index === 0 ? "start" : "end"}
                style={{ fill: axis.color }}
              >
                {width < 350 ? axis.compactLabel || axis.label : axis.label}
              </text>
            ))}
            {Array.from({ length: timeTicks + 1 }, (_, i) => {
              const time = start + ((end - start) * i) / timeTicks;
              return (
                <text
                  key={i}
                  x={x(time)}
                  y={height - 8}
                  textAnchor={
                    i === 0 ? "start" : i === timeTicks ? "end" : "middle"
                  }
                >
                  {new Date(time * 1000).toLocaleString(
                    undefined,
                    data!.hours > 24
                      ? { month: "short", day: "numeric" }
                      : { hour: "2-digit", minute: "2-digit" },
                  )}
                </text>
              );
            })}
            {references.map(([key, value, label]) => {
              const line = y(
                value,
                axes.find((axis) => axis.metrics.includes(key))!,
              );
              const color = airMetrics[key].color;
              return (
                <g key={key} data-reference={key}>
                  <line
                    x1={left}
                    x2={right}
                    y1={line}
                    y2={line}
                    stroke={color}
                    strokeDasharray="5 5"
                    opacity=".28"
                  />
                  <text
                    x={left + 5}
                    y={line - 4}
                    style={{ fill: color, opacity: 0.7 }}
                  >
                    {label}
                  </text>
                </g>
              );
            })}
            {definition.metrics.map((key) => {
              const metric = airMetrics[key],
                axis = axes.find((axis) => axis.metrics.includes(key));
              if (!axis) return null;
              let previous: number | null = null,
                path = "",
                peakPath = "";
              const valid: { timestamp: number; value: number }[] = [];
              // Keep missing buckets and longer gaps disconnected, including peak traces.
              for (const point of data!.points) {
                const value = point[key];
                if (!finite(value)) {
                  previous = null;
                  continue;
                }
                const command =
                  previous != null &&
                  point.timestamp - previous <=
                    Math.max(180, data!.bucket_seconds * 1.5)
                    ? "L"
                    : "M";
                path += `${command}${x(point.timestamp).toFixed(1)},${y(value, axis).toFixed(1)} `;
                const peak = point[`${key}_peak`];
                peakPath += `${command}${x(point.timestamp).toFixed(1)},${y(finite(peak) ? peak : value, axis).toFixed(1)} `;
                previous = point.timestamp;
                valid.push({ timestamp: point.timestamp, value });
              }
              return valid.length ? (
                <g key={key} data-series={key}>
                  <path
                    d={peakPath}
                    fill="none"
                    stroke={metric.color}
                    strokeWidth={1}
                    strokeDasharray="3 3"
                    opacity=".45"
                  />
                  <path
                    d={path}
                    fill="none"
                    stroke={metric.color}
                    strokeWidth={2}
                  />
                  {valid.map((point) => (
                    <circle
                      key={point.timestamp}
                      cx={x(point.timestamp)}
                      cy={y(point.value, axis)}
                      r={valid.length < 5 ? 3 : 1.5}
                      fill={metric.color}
                    />
                  ))}
                </g>
              ) : null;
            })}
            <line
              id={`air-cursor-${group}`}
              x1={selected ? x(selected.timestamp) : 0}
              x2={selected ? x(selected.timestamp) : 0}
              y1={top}
              y2={bottom}
              stroke="var(--ink)"
              strokeDasharray="3 3"
              visibility={selected ? "visible" : "hidden"}
            />
          </svg>
        )}
      </div>
      <div
        id={`air-reading-${group}`}
        className="air-readings"
        aria-live="polite"
        aria-atomic="true"
      >
        {selected && (
          <>
            <div className="air-reading-time">
              {new Date(selected.timestamp * 1000).toLocaleString()} ·{" "}
              {Math.round(data!.bucket_seconds / 60)} min bucket
            </div>
            {definition.metrics.map((key) => {
              const metric = airMetrics[key],
                status = airPointStatus(
                  key,
                  selected[key],
                  selected[`${key}_peak`],
                );
              const percentage = airPercentage(status);
              return (
                <span
                  key={key}
                  className="air-series-reading"
                  data-air-reading={key}
                  style={seriesStyle(key)}
                >
                  <span className="air-reading-value">
                    <i className="air-swatch" aria-hidden="true" />
                    {metric.label}{" "}
                    <strong>
                      {airNumber(selected[key], key)} {metric.unit}
                    </strong>
                    <small>
                      peak {airNumber(selected[`${key}_peak`], key)}
                    </small>
                  </span>
                  <span
                    className="air-reading-status"
                    data-tone={status.tone}
                    title={metric.note}
                  >
                    <b>{status.label}</b>
                    {status.detail && <span>{status.detail}</span>}
                  </span>
                  {percentage && (
                    <span
                      className="air-reading-percentage"
                      data-tone={percentage.tone}
                      title={percentage.title}
                    >
                      <strong>{percentage.label}%</strong> of reference
                      {percentage.peak ? " (peak)" : ""}
                    </span>
                  )}
                </span>
              );
            })}
          </>
        )}
      </div>
    </>
  );
}

import { Link } from "react-router";
import { segments, type ChartPoint } from "../components/Chart";
import { Notice } from "../components/Ui";
import { usePoll } from "../lib/api";
import type { History, Snapshot, UiConfig } from "../lib/types";

function Sparkline({ points, gap }: { points: ChartPoint[]; gap: number }) {
  const end = Date.now() / 1000;
  const start = end - 900;
  const x = (time: number) => 2 + ((time - start) / 900) * 236;
  const y = (value: number) =>
    60 - (Math.max(0, Math.min(100, value)) / 100) * 54;
  const lines = segments(
    points.filter((p) => p.timestamp >= start && p.timestamp <= end),
    gap,
  );
  return (
    <div
      className="home-sparkline"
      role="img"
      aria-label="Usage over the last 15 minutes"
    >
      {lines.length ? (
        <svg viewBox="0 0 240 64" preserveAspectRatio="none" aria-hidden="true">
          {[0, 50, 100].map((value) => (
            <path
              key={value}
              className="spark-grid"
              d={`M0 ${y(value)} H240`}
            />
          ))}
          {lines.map((line, i) => {
            const path = line
              .map((p) => `${x(p.timestamp)},${y(p.value!)}`)
              .join(" ");
            return (
              <g key={i}>
                <polygon
                  className="spark-fill"
                  points={`${x(line[0]!.timestamp)},64 ${path} ${x(line.at(-1)!.timestamp)},64`}
                />
                <polyline className="spark-line" points={path} />
              </g>
            );
          })}
        </svg>
      ) : (
        <span className="home-chart-empty">Waiting for history…</span>
      )}
    </div>
  );
}

export function Home({
  snapshot,
  config,
  error,
}: {
  snapshot: Snapshot | null;
  config: UiConfig | null;
  error: string;
}) {
  const history = usePoll<History>("/api/history?hours=0.25&entity=host");
  const stale =
    !snapshot ||
    snapshot.stale ||
    Date.now() / 1000 - snapshot.timestamp >
      Math.max(30, snapshot.interval * 3);
  return (
    <section
      className="st-home home"
      data-stale={stale || !!error}
      aria-label="Home dashboard"
    >
      <div className="home-layout">
        <aside className="home-system" aria-labelledby="home-system-title">
          <h2 className="home-section-label" id="home-system-title">
            At a glance
          </h2>
          {(["memory_bytes", "cpu_percent"] as const).map((key, i) => (
            <Link
              to="/overview"
              className={`home-stat ${i ? "home-cpu" : "home-ram"}`}
              key={key}
              aria-label={`${i ? "CPU" : "RAM"} usage · Open Overview`}
            >
              <div className="home-stat-heading">
                <h3>{i ? "CPU" : "RAM"}</h3>
                <span>{i ? "Processor" : "Memory"}</span>
              </div>
              <div className="home-stat-value">
                <span>
                  {i
                    ? (snapshot?.system.cpu_percent?.toFixed(1) ?? "—")
                    : snapshot && snapshot.system.memory_total > 0
                      ? (snapshot.system.memory_used / 1e9).toFixed(1)
                      : "—"}
                </span>
                <small>{i ? "%" : "GB"}</small>
              </div>
              <p className="home-stat-detail">
                {snapshot
                  ? i
                    ? `${snapshot.system.cores} logical cores`
                    : `of ${(snapshot.system.memory_total / 1e9).toFixed(1)} GB · ${((snapshot.system.memory_used / snapshot.system.memory_total) * 100).toFixed(1)}%`
                  : "Waiting for a sample"}
              </p>
              <Sparkline
                gap={history.data?.bucket_seconds ?? 10}
                points={
                  history.data?.points.map((p) => ({
                    timestamp: p.timestamp,
                    value:
                      key === "memory_bytes"
                        ? p.memory_bytes == null ||
                          !snapshot?.system.memory_total
                          ? null
                          : (p.memory_bytes / snapshot.system.memory_total) *
                            100
                        : p.cpu_percent,
                  })) ?? []
                }
              />
              <div className="home-stat-footer">
                <span>Last 15 min</span>
                <span>0–100%</span>
              </div>
            </Link>
          ))}
          <p className="home-metrics-status" role="status">
            {stale || error
              ? "Last known readings · reconnecting"
              : `Updated every ${snapshot?.interval ?? 5}s`}
          </p>
          <Link className="home-monitor-link" to="/overview">
            View system monitor
          </Link>
        </aside>
        <section
          className="home-services"
          aria-labelledby="home-services-title"
        >
          <div className="home-services-heading">
            <h2 className="home-section-label" id="home-services-title">
              Your services
            </h2>
            <span>A place for everything.</span>
          </div>
          {!config && <Notice>Loading services…</Notice>}
          <div className="service-grid">
            {config?.services.map((s, i) => {
              const external = s.url.startsWith("https:");
              const icon = (
                <svg viewBox="0 0 48 48" aria-hidden="true">
                  <use href={`/home-icons.svg#${s.icon}`} />
                </svg>
              );
              const body = (
                <>
                  <div className="service-card-top">
                    <span className="service-icon">{icon}</span>
                    <span className="service-category">{s.category}</span>
                  </div>
                  <span className="service-art" aria-hidden="true">
                    {icon}
                  </span>
                  <h3>{s.name}</h3>
                  <p>{s.description}</p>
                  <div className="service-card-bottom">
                    <span>
                      {s.destination ??
                        new URL(s.url, location.origin).hostname}
                    </span>
                    <span className="service-open">
                      {external ? "New tab" : "Open"}
                    </span>
                  </div>
                </>
              );
              const className = `service-card service-${s.tone}`;
              return external ? (
                <a
                  key={i}
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={className}
                >
                  {body}
                </a>
              ) : (
                <Link
                  key={i}
                  to={
                    s.url.startsWith("/planner")
                      ? s.url
                      : `/${s.url.split("#")[1] || ""}`
                  }
                  className={className}
                >
                  {body}
                </Link>
              );
            })}
          </div>
          <p className="home-footnote">
            <svg viewBox="0 0 48 48" aria-hidden="true">
              <use href="/home-icons.svg#link" />
            </svg>
            A few familiar places. One starting point.
          </p>
          {history.error && (
            <Notice retry={history.refresh}>
              History unavailable; service links remain available.
            </Notice>
          )}
        </section>
      </div>
    </section>
  );
}

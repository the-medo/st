import { ago, safeUrl, usePoll } from "../lib/api";
import { AirHistory } from "./air-quality/AirHistory";
import { AirGuide } from "./air-quality/AirGuide";
import { seriesStyle } from "./air-quality/AirChart";
import {
  airGroups,
  airLevel,
  airMetrics,
  airNumber,
  type AirData,
  type Group,
} from "./air-quality/model";

export function AirQuality() {
  const result = usePoll<AirData>(
    "/api/air-quality?hours=1&bucket=auto",
    30000,
  );
  const data = result.data,
    latest = data?.latest;
  const stale = Boolean(data?.stale || result.error);
  const status = !data
    ? result.error
      ? "Air quality unavailable. Retrying shortly…"
      : "Loading sensor readings…"
    : !data.enabled
      ? "Air quality is not configured. Add air_quality_device to the monitor’s local configuration."
      : !latest
        ? data.error ||
          "Waiting for the first reading from M5Stack. Polling every minute."
        : `${stale ? "Stale · last known reading" : "Latest reading"} · ${new Date(latest.timestamp * 1000).toLocaleString()} · ${ago(latest.timestamp)}. ${result.error ? "Dashboard connection unavailable; retrying." : data.error || "Updates every minute."}`;
  return (
    <section id="air-quality-section" aria-label="Air quality dashboard">
      <div className="air-heading">
        <div>
          <h2>Air quality</h2>
          <p>M5Stack Air Quality Kit · SEN55 + SCD40</p>
        </div>
        <div className="air-links">
          {safeUrl(data?.source_url) && (
            <a
              className="button"
              href={safeUrl(data?.source_url)!}
              target="_blank"
              rel="noopener noreferrer"
            >
              M5Stack ↗
            </a>
          )}
          {safeUrl(data?.raw_url) && (
            <a
              className="button"
              href={safeUrl(data?.raw_url)!}
              target="_blank"
              rel="noopener noreferrer"
            >
              Raw data ↗
            </a>
          )}
          <a
            className="button"
            href="https://rpishop.cz/628854/m5stack-sada-mereni-kvality-vzduchu-m5stamps3a/"
            target="_blank"
            rel="noopener noreferrer"
          >
            RPiShop ↗
          </a>
        </div>
      </div>
      <div
        id="air-status"
        className="air-status"
        role="status"
        data-stale={stale}
      >
        {status}
      </div>
      <div
        className="air-cards-scroll"
        tabIndex={0}
        role="region"
        aria-label="All nine measurements; scroll horizontally on smaller screens"
      >
        <div id="air-cards" className="air-cards">
          {data &&
            (Object.keys(airGroups) as Group[]).flatMap((group) =>
              airGroups[group].metrics.map((key) => {
                const metric = airMetrics[key],
                  value = latest?.[key],
                  daily = data.daily[key];
                const [tone, label] = airLevel(
                  key,
                  value,
                  data,
                  Boolean(result.error),
                );
                const note = daily
                  ? `${daily.complete ? "24h mean" : "Partial mean"}: ${airNumber(daily.value, key)} ${metric.unit} · ${Math.round(daily.coverage * 100)}% of day covered`
                  : key === "voc" || key === "nox"
                    ? "Relative index · not a concentration"
                    : "Latest published measurement";
                return (
                  <button
                    key={key}
                    className="air-card"
                    data-air-metric={key}
                    data-air-group={group}
                    aria-controls={`air-chart-${group}`}
                    title={`${label}. ${note}`}
                    style={seriesStyle(key)}
                    onClick={() =>
                      document
                        .getElementById(`air-chart-${group}`)
                        ?.focus({ preventScroll: true })
                    }
                  >
                    <span className="air-card-label">
                      <i className="air-swatch" aria-hidden="true" />
                      {metric.label}
                    </span>
                    <span className="air-card-value">
                      {airNumber(value, key)} <small>{metric.unit}</small>
                    </span>
                    <span className="air-level" data-tone={tone}>
                      {label}
                    </span>
                    <span className="air-card-note">{note}</span>
                  </button>
                );
              }),
            )}
        </div>
      </div>
      <div className="air-charts">
        <AirHistory group="air" />
        <AirHistory group="climate" />
      </div>
      <p id="air-history-note" className="section-note">
        {data?.started_at
          ? `History since ${new Date(data.started_at * 1000).toLocaleString()}.`
          : "History starts with the first successful reading."}{" "}
        Stored for 30 days, including while this page is closed. Repeated
        readings are counted once; gaps are left empty. Times use your browser’s
        timezone.
      </p>
      <AirGuide />
    </section>
  );
}

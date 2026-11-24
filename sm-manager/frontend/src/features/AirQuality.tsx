import { useRef, useState } from "react";
import { usePoll } from "../lib/api";
import { Panel, Notice, External } from "../components/Ui";
import { Chart } from "../components/Chart";
const definitions = {
  co2: {
    label: "CO₂",
    unit: "ppm",
    color: "#7297a6",
    note: "Ventilation reminders at 1,000 and 1,500 ppm; not a toxicity limit.",
  },
  pm25: {
    label: "PM2.5",
    unit: "µg/m³",
    color: "#78a177",
    note: "Compare a sufficiently covered 24-hour mean with the 15 µg/m³ daily reference.",
  },
  pm10: {
    label: "PM10",
    unit: "µg/m³",
    color: "#b59b66",
    note: "Compare a sufficiently covered 24-hour mean with the 45 µg/m³ daily reference.",
  },
  voc: {
    label: "VOC",
    unit: "index",
    color: "#9c86ae",
    note: "Relative index, learned baseline 100. Response bands 150 / 250 / 400; not toxicity limits.",
  },
  nox: {
    label: "NOₓ",
    unit: "index",
    color: "#b87d79",
    note: "Relative index, baseline 1. Response bands 20 / 150 / 300; not a concentration.",
  },
  temperature: {
    label: "Temperature",
    unit: "°C",
    color: "#b09586",
    note: "Enclosure and sensor electronics can affect this reading.",
  },
  humidity: {
    label: "Humidity",
    unit: "%",
    color: "#7baeb1",
    note: "Indoor humidity ideally 30–50%, below 60%. Differences are percentage points.",
  },
  pm1: {
    label: "PM1",
    unit: "µg/m³",
    color: "#99a86a",
    note: "No WHO daily guideline is applied to this size fraction.",
  },
  pm4: {
    label: "PM4.0",
    unit: "µg/m³",
    color: "#7d9e8b",
    note: "No WHO daily guideline is applied to this size fraction.",
  },
} as const;
type Key = keyof typeof definitions;
type Reading = { timestamp: number } & Partial<
  Record<Key | `${Key}_peak`, number | null>
>;
type Air = {
  enabled: boolean;
  source_url: string;
  raw_url: string;
  latest: Reading | null;
  stale: boolean;
  error: string | null;
  now: number;
  hours: number;
  bucket_seconds: number;
  poll_seconds: number;
  started_at: number | null;
  points: Reading[];
  daily: Partial<
    Record<Key, { value: number | null; coverage: number; complete: boolean }>
  >;
};
const groups: { name: string; axes: Key[][] }[] = [
  {
    name: "Air measurements",
    axes: [["co2"], ["pm1", "pm25", "pm4", "pm10"], ["voc", "nox"]],
  },
  { name: "Temperature & humidity", axes: [["temperature"], ["humidity"]] },
];
const number = (v?: number | null) =>
  v == null || !Number.isFinite(v)
    ? "—"
    : v.toLocaleString(undefined, { maximumFractionDigits: 1 });
export function AirQuality() {
  const latest = usePoll<Air>("/api/air-quality?hours=1&bucket=auto", 30000);
  return (
    <>
      <div className="st-toolbar">
        <External url={latest.data?.source_url}>M5Stack AirQ</External>
        <External url={latest.data?.raw_url}>Raw data</External>
      </div>
      {latest.error && <Notice retry={latest.refresh}>{latest.error}</Notice>}
      {latest.data && !latest.data.enabled && (
        <Notice>Air quality is not configured for this instance.</Notice>
      )}
      {latest.data?.stale && (
        <Notice>Last known readings · waiting for fresh sensor data.</Notice>
      )}
      <div className="st-air-cards">
        {Object.entries(definitions).map(([key, d]) => {
          const k = key as Key;
          const daily = latest.data?.daily[k];
          return (
            <article key={key} title={d.note}>
              <span>{d.label}</span>
              <strong>
                {number(latest.data?.latest?.[k])} <small>{d.unit}</small>
              </strong>
              <p>
                {daily
                  ? `${daily.complete ? "24h mean" : "Partial mean"}: ${number(daily.value)} ${d.unit} · ${Math.round(daily.coverage * 100)}% coverage`
                  : d.note}
              </p>
              {daily?.complete && daily.value != null && (
                <small>
                  {daily.value > (key === "pm25" ? 15 : 45)
                    ? "Daily average above reference"
                    : "Daily average below reference"}
                </small>
              )}
            </article>
          );
        })}
      </div>
      {groups.map((g) => (
        <AirGroup key={g.name} {...g} />
      ))}
      <small>
        Readings are retained for 30 days. Repeated readings count once; gaps
        remain empty. Chart peaks and short buckets are not daily exposure
        assessments.
      </small>
    </>
  );
}
function AirGroup({ name, axes }: { name: string; axes: Key[][] }) {
  const [hours, setHours] = useState(6),
    [bucket, setBucket] = useState("auto");
  const [full, setFull] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const data = usePoll<Air>(
    `/api/air-quality?hours=${hours}&bucket=${bucket}`,
    30000,
  );
  const minBucket = Math.max(60, Math.ceil((hours * 3600) / 1440));
  const fullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        setFull(false);
      } else {
        await root.current?.requestFullscreen();
        setFull(true);
      }
    } catch {
      setFull(!full);
    }
  };
  return (
    <div ref={root} className={`st-air-group ${full ? "expanded" : ""}`}>
      <Panel
        title={name}
        actions={
          <button onClick={() => void fullscreen()}>
            {full ? "Exit fullscreen" : "Fullscreen"}
          </button>
        }
      >
        <div className="st-toolbar">
          <label>
            Range
            <select
              value={hours}
              onChange={(e) => {
                setHours(Number(e.target.value));
                setBucket("auto");
              }}
            >
              {[
                [1, "1h"],
                [6, "6h"],
                [12, "12h"],
                [24, "24h"],
                [168, "Week"],
                [720, "Month"],
              ].map(([v, l]) => (
                <option value={v} key={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label>
            Bucket
            <select value={bucket} onChange={(e) => setBucket(e.target.value)}>
              <option value="auto">Auto</option>
              {[60, 300, 900, 1800, 3600, 21600, 86400]
                .filter((v) => v >= minBucket && v <= hours * 3600)
                .map((v) => (
                  <option key={v} value={v}>
                    {v < 3600 ? `${v / 60}m` : `${v / 3600}h`}
                  </option>
                ))}
            </select>
          </label>
        </div>
        {data.error && <Notice retry={data.refresh}>{data.error}</Notice>}
        {axes.map((keys, i) => (
          <div key={i} className="st-air-axis">
            <h3>
              {keys.map((k) => definitions[k].label).join(" / ")} ·{" "}
              {definitions[keys[0]!].unit}
            </h3>
            <Chart
              start={data.data ? data.data.now - hours * 3600 : undefined}
              end={data.data?.now}
              format={(v) => `${number(v)} ${definitions[keys[0]!].unit}`}
              series={keys.flatMap((k) =>
                [false, true].map((peak) => ({
                  id: k + (peak ? "-peak" : ""),
                  label: definitions[k].label + (peak ? " peak" : " mean"),
                  color: definitions[k].color,
                  dash: peak,
                  gap: data.data?.bucket_seconds ?? 60,
                  points:
                    data.data?.points.map((p) => ({
                      timestamp: p.timestamp,
                      value:
                        p[peak ? (`${k}_peak` as `${Key}_peak`) : k] ?? null,
                    })) ?? [],
                })),
              )}
            />
          </div>
        ))}
      </Panel>
    </div>
  );
}

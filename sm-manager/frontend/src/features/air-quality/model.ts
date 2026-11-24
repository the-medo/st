// Preserve the original Air Quality dashboard's metric colors, scales and comparisons.
export type Metric =
  | "co2"
  | "pm1"
  | "pm25"
  | "pm4"
  | "pm10"
  | "voc"
  | "nox"
  | "temperature"
  | "humidity";
export type Group = "air" | "climate";
export type Reading = { timestamp: number } & Partial<
  Record<Metric | `${Metric}_peak`, number | null>
>;
export type AirData = {
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
    Record<
      Metric,
      { value: number | null; coverage: number; complete: boolean }
    >
  >;
};
type Axis = {
  id: string;
  label: string;
  compactLabel?: string;
  metrics: Metric[];
  minimum: number;
  baseline: number;
  color: string;
  optional?: boolean;
};
export type Scale = Axis & { maximum: number };
export type PointStatus = {
  tone: string;
  label: string;
  detail: string;
  comparison?: {
    value: number;
    limit: number;
    reference: string;
    peak: boolean;
  };
};
export const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
export const airRanges = [1, 6, 12, 24, 168, 720];
export const airBuckets = [
  "auto",
  60,
  300,
  900,
  1800,
  3600,
  21600,
  86400,
] as const;
export type Bucket = (typeof airBuckets)[number];
export function airBucketLabel(bucket: Bucket | number) {
  if (bucket === "auto") return "Auto";
  if (bucket >= 86400) return `${bucket / 86400}d`;
  if (bucket >= 3600 && bucket % 3600 === 0) return `${bucket / 3600}h`;
  return bucket % 60 === 0 ? `${bucket / 60}m` : `${bucket}s`;
}
export function airBucketAllowed(hours: number, bucket: Bucket) {
  return (
    bucket === "auto" ||
    (airBuckets.includes(bucket) &&
      bucket >= Math.max(60, Math.ceil((hours * 3600) / 1440)) &&
      bucket <= hours * 3600)
  );
}
export function airRangeLabel(hours: number) {
  return hours === 168 ? "1 week" : hours === 720 ? "30 days" : `${hours}h`;
}
export const airMetrics = {
  co2: {
    label: "CO₂",
    unit: "ppm",
    digits: 0,
    color: "#58a6ff",
    refs: [1000, 1500, 2000],
    note: "Ventilation reminders at 1,000 / 1,500 / 2,000 ppm. Persistent readings above 1,500 ppm indicate poor ventilation.",
  },
  pm25: {
    label: "PM2.5",
    unit: "µg/m³",
    digits: 1,
    color: "#63cf8c",
    refs: [15],
    note: "15 µg/m³ is the WHO 24-hour average reference. An individual point above this line is not a daily exposure assessment.",
  },
  pm10: {
    label: "PM10",
    unit: "µg/m³",
    digits: 1,
    color: "#56d4dd",
    refs: [45],
    note: "45 µg/m³ is the WHO 24-hour average reference. An individual point above this line is not a daily exposure assessment.",
  },
  voc: {
    label: "VOC",
    unit: "index",
    digits: 0,
    color: "#d2a8ff",
    refs: [150, 250, 400],
    note: "Relative VOC index; learned baseline 100. Bands at 150 / 250 / 400 follow Sensirion’s purifier response guidance, not toxicity limits.",
  },
  nox: {
    label: "NOₓ",
    unit: "index",
    digits: 0,
    color: "#f778ba",
    refs: [20, 150, 300],
    note: "Relative NOₓ index; baseline 1. Bands at 20 / 150 / 300 follow Sensirion’s purifier response guidance, not gas concentration limits.",
  },
  temperature: {
    label: "Temperature",
    unit: "°C",
    digits: 1,
    color: "#f0b65f",
    refs: [],
    note: "Temperature from the SEN55 sensor. The enclosure and sensor electronics can affect this reading.",
  },
  humidity: {
    label: "Humidity",
    unit: "%",
    digits: 1,
    color: "#a5d6ff",
    refs: [],
    note: "EPA recommends indoor humidity below 60%, ideally 30–50%. Differences are percentage points (pp).",
  },
  pm1: {
    label: "PM1",
    unit: "µg/m³",
    digits: 1,
    color: "#b6dc7b",
    refs: [],
    note: "PM1 particle mass concentration. No WHO daily guideline is applied to this size fraction.",
  },
  pm4: {
    label: "PM4.0",
    unit: "µg/m³",
    digits: 1,
    color: "#9cd5cb",
    refs: [],
    note: "PM4.0 particle mass concentration. No WHO daily guideline is applied to this size fraction.",
  },
};
export const airGroups: Record<
  Group,
  { label: string; metrics: Metric[]; axes: Axis[] }
> = {
  air: {
    label: "Air measurements",
    metrics: ["co2", "pm1", "pm25", "pm4", "pm10", "voc", "nox"],
    axes: [
      {
        id: "co2",
        label: "CO₂ · ppm",
        metrics: ["co2"],
        minimum: 0,
        baseline: 2000,
        color: "#58a6ff",
      },
      {
        id: "particles",
        label: "PM · µg/m³",
        metrics: ["pm1", "pm25", "pm4", "pm10"],
        minimum: 0,
        baseline: 50,
        color: "#63cf8c",
      },
      {
        id: "gas",
        label: "Gas index",
        metrics: ["voc", "nox"],
        minimum: 0,
        baseline: 500,
        color: "#d2a8ff",
        optional: true,
      },
    ],
  },
  climate: {
    label: "Temperature & humidity",
    metrics: ["temperature", "humidity"],
    axes: [
      {
        id: "temperature",
        label: "Temperature · °C",
        compactLabel: "Temp · °C",
        metrics: ["temperature"],
        minimum: 0,
        baseline: 40,
        color: "#f0b65f",
      },
      {
        id: "humidity",
        label: "Humidity · %",
        compactLabel: "RH · %",
        metrics: ["humidity"],
        minimum: 0,
        baseline: 100,
        color: "#a5d6ff",
      },
    ],
  },
};
export function airNumber(
  value: number | null | undefined,
  metric: Metric = "co2",
) {
  return finite(value)
    ? value.toLocaleString(undefined, {
        maximumFractionDigits: airMetrics[metric].digits,
      })
    : "—";
}
export function airPointStatus(
  key: Metric,
  mean: number | null | undefined,
  peak: number | null | undefined,
): PointStatus {
  const metric = airMetrics[key];
  if (!finite(mean) || (["voc", "nox"].includes(key) && mean <= 0)) {
    return { tone: "neutral", label: "Unavailable", detail: "" };
  }
  // A low bucket mean must not hide a peak above the reference. Always name
  // the peak when it is the value being compared; these are historical points.
  const hasPeak = finite(peak) && peak > mean;
  const value = hasPeak ? peak! : mean,
    prefix = hasPeak ? "Peak · " : "";
  const difference = (amount: number) => {
    const precision = 10 ** -metric.digits;
    return amount < precision
      ? `<${airNumber(precision, key)}`
      : airNumber(amount, key);
  };
  function upper(
    limit: number,
    reference: string,
    inclusive = false,
    unit = metric.unit,
  ) {
    const warning = inclusive ? value >= limit : value > limit;
    const detail = warning
      ? `${prefix}${value > limit ? `+${difference(value - limit)} ${unit} above` : "At"} ${reference}`
      : `${inclusive ? "<" : "≤"}${reference}`;
    return {
      tone: warning ? "watch" : "good",
      label: warning ? "Warning" : "OK",
      detail,
      comparison: { value, limit, reference, peak: hasPeak },
    };
  }
  if (key === "co2") {
    return value > metric.refs[1]!
      ? upper(metric.refs[1]!, "1,500 ppm ventilation ref")
      : upper(metric.refs[0]!, "1,000 ppm reminder");
  }
  if (key === "pm25" || key === "pm10") {
    // WHO's daily reference is only a comparison here, never an assessment of
    // daily exposure from a short bucket or peak. Cards retain coverage checks.
    return upper(metric.refs[0]!, `${metric.refs[0]!} µg/m³ · 24h ref`);
  }
  if (key === "voc" || key === "nox")
    return upper(metric.refs[0]!, `${metric.refs[0]!} index band`, true);
  if (key === "humidity") {
    if (value >= 60) return upper(60, "60% ceiling", true, "pp");
    if (mean < 30)
      return {
        tone: "watch",
        label: "Warning",
        detail: `${difference(30 - mean)} pp below 30% ideal minimum`,
        comparison: {
          value: mean,
          limit: 30,
          reference: "30% ideal minimum",
          peak: false,
        },
      };
    return upper(60, "60% ceiling", true, "pp");
  }
  return {
    tone: "neutral",
    label: key === "temperature" ? "Context only" : "No guideline",
    detail: "",
  };
}
export function airLevel(
  key: Metric,
  value: number | null | undefined,
  data: AirData | null,
  error: boolean,
): [string, string] {
  if (!finite(value)) return ["neutral", "Unavailable"];
  if (data?.stale || error) return ["neutral", "Last known reading"];
  if (key === "co2") {
    if (value >= 2000) return ["high", "High · improve ventilation"];
    if (value > 1500) return ["watch", "Improve ventilation"];
    if (value > 1000) return ["watch", "Ventilation reminder"];
    return ["good", "Below ventilation reminder"];
  }
  if (key === "pm25" || key === "pm10") {
    const daily = data?.daily[key];
    if (!daily?.complete || !finite(daily.value))
      return ["neutral", "Collecting daily average"];
    return daily.value > airMetrics[key].refs[0]!
      ? ["watch", "Daily average above WHO reference"]
      : ["good", "Daily average below reference"];
  }
  if (key === "voc" || key === "nox") {
    const [low, middle, high] = airMetrics[key].refs;
    if (value >= high!) return ["high", "Very elevated index"];
    if (value >= middle!) return ["watch", "High index"];
    if (value >= low!) return ["watch", "Elevated index"];
    return ["good", "Low response band"];
  }
  return ["neutral", "SEN55 sensor"];
}
export function airChartScales(group: Group, points: Reading[]): Scale[] {
  return airGroups[group].axes
    .filter(
      (axis) =>
        !axis.optional ||
        points.some((point) => axis.metrics.some((key) => finite(point[key]))),
    )
    .map((axis) => {
      const values = points
        .flatMap((point) =>
          axis.metrics.flatMap((key) => [
            point[key],
            point[`${key}_peak` as const],
          ]),
        )
        .filter(finite);
      const minimum = Math.min(axis.minimum, ...values);
      const maximum = Math.max(axis.baseline, ...values);
      // Round up to readable ticks; each unit has its own clearly labeled axis.
      const step =
        10 ** Math.floor(Math.log10(Math.max(1, maximum - minimum) / 4));
      return {
        ...axis,
        minimum: Math.floor(minimum / step) * step,
        maximum: Math.ceil(maximum / step) * step,
      };
    });
}

export function airPercentage(status: PointStatus) {
  if (!status.comparison) return null;
  const { value, limit, reference, peak } = status.comparison;
  const percentage = (value / limit) * 100;
  const rounded = Math.round(percentage * 10) / 10;
  const label =
    rounded === 100 && percentage !== 100
      ? `${percentage > 100 ? ">" : "<"}100`
      : percentage > 0 && rounded === 0
        ? "<0.1"
        : percentage.toLocaleString(undefined, { maximumFractionDigits: 1 });
  return {
    label,
    tone: percentage > 100 ? "high" : status.tone,
    peak,
    title: `${peak ? "Peak" : "Mean"} ÷ ${reference} × 100`,
  };
}

/* Sensor data is fetched by the server; the browser only uses our private API. */
const airState = { data: null, error: false, charts: {}, cursors: {}, expanded: null,
  history: Object.fromEntries(["air", "climate"].map(group => [group,
    { hours: 6, bucket: "auto", data: null, request: 0, loading: false, error: false }])) };
const airRanges = [1, 6, 12, 24, 168, 720];
const airBuckets = ["auto", 60, 300, 900, 1800, 3600, 21600, 86400];
function airBucketLabel(bucket) {
  if (bucket === "auto") return "Auto";
  if (bucket >= 86400) return `${bucket / 86400}d`;
  if (bucket >= 3600 && bucket % 3600 === 0) return `${bucket / 3600}h`;
  return bucket % 60 === 0 ? `${bucket / 60}m` : `${bucket}s`;
}
function airBucketAllowed(hours, bucket) {
  return bucket === "auto" || (airBuckets.includes(bucket)
    && bucket >= Math.max(60, Math.ceil(hours * 3600 / 1440)) && bucket <= hours * 3600);
}
function renderAirBucketControls(group) {
  const history = airState.history[group];
  const bucketSelect = $("air-bucket-select-" + group);
  bucketSelect.value = String(history.bucket);
  [...$("air-bucket-" + group).querySelectorAll("[data-air-bucket]"),
    ...bucketSelect.querySelectorAll("option")].forEach(button => {
    const bucket = button.dataset.airBucket === "auto" ? "auto" : Number(button.dataset.airBucket);
    const allowed = airBucketAllowed(history.hours, bucket);
    button.disabled = !allowed;
    button.title = allowed ? bucket === "auto" ? "Choose a bucket to suit the time range" : `Average readings in ${airBucketLabel(bucket)} buckets`
      : bucket > history.hours * 3600 ? "Choose a longer time range for this bucket"
      : "Choose a shorter time range for this level of detail";
    button.classList.toggle("selected", bucket === history.bucket);
    button.setAttribute("aria-pressed", String(bucket === history.bucket));
  });
}
function airRangeLabel(hours) {
  return hours === 168 ? "1 week" : hours === 720 ? "30 days" : `${hours}h`;
}
const airMetrics = {
  co2: { label: "CO₂", unit: "ppm", digits: 0, color: "#58a6ff", refs: [1000, 1500, 2000], note: "Ventilation reminders at 1,000 / 1,500 / 2,000 ppm. Persistent readings above 1,500 ppm indicate poor ventilation." },
  pm25: { label: "PM2.5", unit: "µg/m³", digits: 1, color: "#63cf8c", refs: [15], note: "15 µg/m³ is the WHO 24-hour average reference. An individual point above this line is not a daily exposure assessment." },
  pm10: { label: "PM10", unit: "µg/m³", digits: 1, color: "#56d4dd", refs: [45], note: "45 µg/m³ is the WHO 24-hour average reference. An individual point above this line is not a daily exposure assessment." },
  voc: { label: "VOC", unit: "index", digits: 0, color: "#d2a8ff", refs: [150, 250, 400], note: "Relative VOC index; learned baseline 100. Bands at 150 / 250 / 400 follow Sensirion’s purifier response guidance, not toxicity limits." },
  nox: { label: "NOₓ", unit: "index", digits: 0, color: "#f778ba", refs: [20, 150, 300], note: "Relative NOₓ index; baseline 1. Bands at 20 / 150 / 300 follow Sensirion’s purifier response guidance, not gas concentration limits." },
  temperature: { label: "Temperature", unit: "°C", digits: 1, color: "#f0b65f", refs: [], note: "Temperature from the SEN55 sensor. The enclosure and sensor electronics can affect this reading." },
  humidity: { label: "Humidity", unit: "%", digits: 1, color: "#a5d6ff", refs: [], note: "EPA recommends indoor humidity below 60%, ideally 30–50%. Differences are percentage points (pp)." },
  pm1: { label: "PM1", unit: "µg/m³", digits: 1, color: "#b6dc7b", refs: [], note: "PM1 particle mass concentration. No WHO daily guideline is applied to this size fraction." },
  pm4: { label: "PM4.0", unit: "µg/m³", digits: 1, color: "#9cd5cb", refs: [], note: "PM4.0 particle mass concentration. No WHO daily guideline is applied to this size fraction." },
};
const airGroups = {
  air: { label: "Air measurements", metrics: ["co2", "pm1", "pm25", "pm4", "pm10", "voc", "nox"], axes: [
    { id: "co2", label: "CO₂ · ppm", metrics: ["co2"], minimum: 0, baseline: 2000, color: "#58a6ff" },
    { id: "particles", label: "PM · µg/m³", metrics: ["pm1", "pm25", "pm4", "pm10"], minimum: 0, baseline: 50, color: "#63cf8c" },
    { id: "gas", label: "Gas index", metrics: ["voc", "nox"], minimum: 0, baseline: 500, color: "#d2a8ff", optional: true },
  ] },
  climate: { label: "Temperature & humidity", metrics: ["temperature", "humidity"], axes: [
    { id: "temperature", label: "Temperature · °C", compactLabel: "Temp · °C", metrics: ["temperature"], minimum: 0, baseline: 40, color: "#f0b65f" },
    { id: "humidity", label: "Humidity · %", compactLabel: "RH · %", metrics: ["humidity"], minimum: 0, baseline: 100, color: "#a5d6ff" },
  ] },
};
function airNumber(value, metric = "co2") {
  return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: airMetrics[metric].digits }) : "—";
}
function airPointStatus(key, mean, peak) {
  const metric = airMetrics[key];
  if (!Number.isFinite(mean) || (["voc", "nox"].includes(key) && mean <= 0)) {
    return { tone: "neutral", label: "Unavailable", detail: "" };
  }
  // A low bucket mean must not hide a peak above the reference. Always name
  // the peak when it is the value being compared; these are historical points.
  const hasPeak = Number.isFinite(peak) && peak > mean;
  const value = hasPeak ? peak : mean, prefix = hasPeak ? "Peak · " : "";
  const difference = amount => {
    const precision = 10 ** -metric.digits;
    return amount < precision ? `<${airNumber(precision, key)}` : airNumber(amount, key);
  };
  function upper(limit, reference, inclusive = false, unit = metric.unit) {
    const warning = inclusive ? value >= limit : value > limit;
    const detail = warning
      ? `${prefix}${value > limit ? `+${difference(value - limit)} ${unit} above` : "At"} ${reference}`
      : `${inclusive ? "<" : "≤"}${reference}`;
    return { tone: warning ? "watch" : "good", label: warning ? "Warning" : "OK", detail,
      comparison: { value, limit, reference, peak: hasPeak } };
  }
  if (key === "co2") {
    return value > metric.refs[1] ? upper(metric.refs[1], "1,500 ppm ventilation ref")
      : upper(metric.refs[0], "1,000 ppm reminder");
  }
  if (key === "pm25" || key === "pm10") {
    // WHO's daily reference is only a comparison here, never an assessment of
    // daily exposure from a short bucket or peak. Cards retain coverage checks.
    return upper(metric.refs[0], `${metric.refs[0]} µg/m³ · 24h ref`);
  }
  if (key === "voc" || key === "nox") return upper(metric.refs[0], `${metric.refs[0]} index band`, true);
  if (key === "humidity") {
    if (value >= 60) return upper(60, "60% ceiling", true, "pp");
    if (mean < 30) return { tone: "watch", label: "Warning", detail: `${difference(30 - mean)} pp below 30% ideal minimum`,
      comparison: { value: mean, limit: 30, reference: "30% ideal minimum", peak: false } };
    return upper(60, "60% ceiling", true, "pp");
  }
  return { tone: "neutral", label: key === "temperature" ? "Context only" : "No guideline", detail: "" };
}
function airReadingPercentage(status) {
  if (!status.comparison) return "";
  const { value, limit, reference, peak } = status.comparison;
  const percentage = value / limit * 100;
  const rounded = Math.round(percentage * 10) / 10;
  // Do not round an exceedance down to an apparently exact 100%.
  const label = rounded === 100 && percentage !== 100 ? `${percentage > 100 ? ">" : "<"}100`
    : percentage > 0 && rounded === 0 ? "<0.1"
    : percentage.toLocaleString(undefined, { maximumFractionDigits: 1 });
  const tone = percentage > 100 ? "high" : status.tone;
  return `<span class="air-reading-percentage" data-tone="${tone}" title="${e(`${peak ? "Peak" : "Mean"} ÷ ${reference} × 100`)}"><strong>${e(label)}%</strong> of reference${peak ? " (peak)" : ""}</span>`;
}
function airLevel(key, value, data) {
  if (!Number.isFinite(value)) return ["neutral", "Unavailable"];
  if (data.stale || airState.error) return ["neutral", "Last known reading"];
  if (key === "co2") {
    if (value >= 2000) return ["high", "High · improve ventilation"];
    if (value > 1500) return ["watch", "Improve ventilation"];
    if (value > 1000) return ["watch", "Ventilation reminder"];
    return ["good", "Below ventilation reminder"];
  }
  if (key === "pm25" || key === "pm10") {
    const daily = data.daily[key];
    if (!daily?.complete) return ["neutral", "Collecting daily average"];
    return daily.value > airMetrics[key].refs[0] ? ["watch", "Daily average above WHO reference"] : ["good", "Daily average below reference"];
  }
  if (key === "voc" || key === "nox") {
    const [low, middle, high] = airMetrics[key].refs;
    if (value >= high) return ["high", "Very elevated index"];
    if (value >= middle) return ["watch", "High index"];
    if (value >= low) return ["watch", "Elevated index"];
    return ["good", "Low response band"];
  }
  return ["neutral", "SEN55 sensor"];
}
function renderAirQuality() {
  const data = airState.data;
  if (!data) return;
  const stale = data.stale || airState.error;
  const latest = data.latest;
  const status = $("air-status");
  status.dataset.stale = String(Boolean(stale));
  if (!data.enabled) status.textContent = "Air quality is not configured. Add air_quality_device to the monitor’s local configuration.";
  else if (!latest) status.textContent = data.error || "Waiting for the first reading from M5Stack. Polling every minute.";
  else {
    const timestamp = new Date(latest.timestamp * 1000).toLocaleString();
    status.textContent = `${stale ? "Stale · last known reading" : "Latest reading"} · ${timestamp} · ${ago(latest.timestamp)}. ${airState.error ? "Dashboard connection unavailable; retrying." : data.error || "Updates every minute."}`;
  }
  if (data.source_url && /^https:\/\/airq\.m5stack\.com\/[0-9A-F]{12}$/.test(data.source_url)) {
    for (const id of ["air-source", "air-nav-source"]) {
      $(id).href = data.source_url;
      $(id).hidden = false;
    }
  }
  if (data.raw_url && /^https:\/\/ezdata2\.m5stack\.com\/api\/v2\/[0-9A-F]{12}\/dataMacByKey\/raw$/.test(data.raw_url)) {
    $("air-raw").href = data.raw_url;
    $("air-raw").hidden = false;
  }
  $("air-cards").innerHTML = Object.entries(airGroups).flatMap(([group, definition]) => definition.metrics.map((key) => {
    const metric = airMetrics[key], value = latest?.[key];
    const [tone, label] = airLevel(key, value, data);
    const daily = data.daily[key];
    const note = daily ? `${daily.complete ? "24h mean" : "Partial mean"}: ${airNumber(daily.value, key)} ${metric.unit} · ${Math.round(daily.coverage * 100)}% of day covered` : key === "voc" || key === "nox" ? "Relative index · not a concentration" : "Latest published measurement";
    return `<button class="air-card" data-air-metric="${key}" data-air-group="${group}" aria-controls="air-chart-${group}" title="${e(label + ". " + note)}" style="--series-color:${metric.color}"><span class="air-card-label"><i class="air-swatch" aria-hidden="true"></i>${metric.label}</span><span class="air-card-value">${airNumber(value, key)} <small>${metric.unit}</small></span><span class="air-level" data-tone="${tone}">${e(label)}</span><span class="air-card-note">${e(note)}</span></button>`;
  })).join("");
  $("air-history-note").textContent = `${data.started_at ? `History since ${new Date(data.started_at * 1000).toLocaleString()}.` : "History starts with the first successful reading."} Stored for 30 days, including while this page is closed. Repeated readings are counted once; gaps are left empty. Times use your browser’s timezone.`;
  renderAirCharts();
}
function airChartScales(group, points) {
  return airGroups[group].axes.filter(axis => !axis.optional || points.some(point => axis.metrics.some(key => Number.isFinite(point[key])))).map(axis => {
    const values = points.flatMap(point => axis.metrics.flatMap(key => [point[key], point[`${key}_peak`]])).filter(Number.isFinite);
    const minimum = Math.min(axis.minimum, ...values);
    const maximum = Math.max(axis.baseline, ...values);
    // Round up to readable ticks; each unit has its own clearly labeled axis.
    const step = 10 ** Math.floor(Math.log10(Math.max(1, maximum - minimum) / 4));
    return { ...axis, minimum: Math.floor(minimum / step) * step,
      maximum: Math.ceil(maximum / step) * step };
  });
}
function renderAirCharts() {
  for (const group of Object.keys(airGroups)) renderAirChart(group);
}
function renderAirChart(group) {
  const history = airState.history[group], data = history.data;
  const definition = airGroups[group], element = $("air-chart-" + group);
  renderAirBucketControls(group);
  if (element.closest("[hidden]")) return;
  const status = $("air-load-" + group);
  status.textContent = history.loading ? `Loading ${airRangeLabel(history.hours)} history · ${airBucketLabel(history.bucket)} buckets…`
    : history.error ? `Could not load ${airRangeLabel(history.hours)} history with ${airBucketLabel(history.bucket)} buckets.${data ? ` Showing previous ${airRangeLabel(data.hours)} history (${airBucketLabel(data.bucket_seconds)} buckets).` : " Retrying shortly…"}` : "";
  status.hidden = !status.textContent;
  if (!data) {
    element.innerHTML = '<div class="chart-placeholder">Waiting for sensor history…</div>';
    return;
  }
  const points = data.points.filter(point => definition.metrics.some(key => Number.isFinite(point[key])));
  airState.charts[group] = null;
  if (airState.cursors[group] == null) $("air-reading-" + group).textContent = "";
  $("air-legend-" + group).innerHTML = definition.metrics.map(key => {
    const metric = airMetrics[key], available = points.some(point => Number.isFinite(point[key]));
    const values = points.map(point => point[`${key}_peak`] ?? point[key]).filter(Number.isFinite);
    const detail = available ? `Peak ${airNumber(Math.max(...values), key)} ${metric.unit}` : "No readings";
    return `<span class="air-series-legend" data-air-series="${key}" title="${e(detail)}" style="--series-color:${metric.color}"><i class="air-swatch" aria-hidden="true"></i><strong>${metric.label}</strong>${available ? "" : '<small>unavailable</small>'}</span>`;
  }).join("");
  if (!points.length) {
    $("air-reading-" + group).textContent = "";
    element.innerHTML = `<div class="chart-placeholder">No readings for this section in this range yet.</div>`;
    element.setAttribute("aria-label", `${definition.label}: no readings in the selected range`);
    return;
  }
  const width = Math.max(220, element.clientWidth), height = element.clientHeight || 340;
  const axes = airChartScales(group, data.points);
  const left = 48, right = width - (axes.length > 2 ? 105 : 46), top = 32, bottom = height - 32;
  const start = data.now - data.hours * 3600, end = data.now;
  const x = time => left + (time - start) / (end - start) * (right - left);
  const y = (value, axis) => bottom - (value - axis.minimum) / (axis.maximum - axis.minimum) * (bottom - top);
  let svg = "";
  for (let i = 0; i <= 4; i++) {
    const line = bottom - (bottom - top) * i / 4;
    svg += `<line class="chart-grid" x1="${left}" x2="${right}" y1="${line}" y2="${line}"/>`;
    axes.forEach((axis, index) => {
      const value = axis.minimum + (axis.maximum - axis.minimum) * i / 4;
      const position = index === 0 ? left - 8 : right + 8 + (index - 1) * 58;
      svg += `<text x="${position}" y="${line + 3}" text-anchor="${index === 0 ? "end" : "start"}" style="fill:${axis.color}">${airNumber(value, axis.metrics[0])}</text>`;
    });
  }
  axes.forEach((axis, index) => {
    const position = index === 0 ? left : index === 1 ? right : width - 8;
    const label = width < 350 ? axis.compactLabel || axis.label : axis.label;
    svg += `<text x="${position}" y="15" text-anchor="${index === 0 ? "start" : "end"}" style="fill:${axis.color}">${e(label)}</text>`;
  });
  const timeTicks = width < 350 ? 2 : 3;
  for (let i = 0; i <= timeTicks; i++) {
    const time = start + (end - start) * i / timeTicks;
    const label = new Date(time * 1000).toLocaleString(undefined, data.hours > 24 ? { month: "short", day: "numeric" } : { hour: "2-digit", minute: "2-digit" });
    svg += `<text x="${x(time)}" y="${height - 8}" text-anchor="${i === 0 ? "start" : i === timeTicks ? "end" : "middle"}">${e(label)}</text>`;
  }
  // References belong to a particular metric and use that metric's axis.
  const references = group === "air" ? [["co2", 1500, "CO₂ 1,500"], ["pm25", 15, "PM2.5 15 · 24h"], ["pm10", 45, "PM10 45 · 24h"]] : [];
  for (const [key, value, label] of references) {
    const axis = axes.find(axis => axis.metrics.includes(key));
    const line = y(value, axis), color = airMetrics[key].color;
    svg += `<line x1="${left}" x2="${right}" y1="${line}" y2="${line}" stroke="${color}" stroke-dasharray="5 5" opacity=".28"/><text x="${left + 5}" y="${line - 4}" style="fill:${color};opacity:.7">${e(label)}</text>`;
  }
  for (const key of definition.metrics) {
    const metric = airMetrics[key], axis = axes.find(axis => axis.metrics.includes(key));
    if (!axis) continue;
    let previous = null, path = "", peakPath = "";
    const valid = [];
    for (const point of data.points) {
      const value = point[key];
      if (!Number.isFinite(value)) { previous = null; continue; }
      const command = previous && point.timestamp - previous.timestamp <= Math.max(180, data.bucket_seconds * 1.5) ? "L" : "M";
      path += `${command}${x(point.timestamp).toFixed(1)},${y(value, axis).toFixed(1)} `;
      peakPath += `${command}${x(point.timestamp).toFixed(1)},${y(point[`${key}_peak`] ?? value, axis).toFixed(1)} `;
      previous = point;
      valid.push(point);
    }
    if (!valid.length) continue;
    svg += `<g data-series="${key}"><path d="${peakPath}" fill="none" stroke="${metric.color}" stroke-width="1" stroke-dasharray="3 3" opacity=".45"/><path d="${path}" fill="none" stroke="${metric.color}" stroke-width="2"/>`;
    svg += valid.map(point => `<circle cx="${x(point.timestamp)}" cy="${y(point[key], axis)}" r="${valid.length < 5 ? 3 : 1.5}" fill="${metric.color}"/>`).join("") + "</g>";
  }
  svg += `<line id="air-cursor-${group}" x1="0" x2="0" y1="${top}" y2="${bottom}" stroke="var(--ink)" stroke-dasharray="3 3" visibility="hidden"/>`;
  element.innerHTML = `<svg viewBox="0 0 ${width} ${height}" aria-hidden="true">${svg}</svg>`;
  element.setAttribute("aria-label", `${definition.label} history over ${data.hours} hours. ${definition.metrics.map(key => airMetrics[key].label).join(", ")}. Separate scales: ${axes.map(axis => axis.label).join(", ")}. Arrow keys inspect all readings. Solid lines: bucket means; dashed: peaks. Gaps indicate missing data.`);
  airState.charts[group] = { points, start, end, left, right, x };
  if (airState.cursors[group] != null) inspectAirPoint(group, airState.cursors[group]);
}
function inspectAirPoint(group, index) {
  const chart = airState.charts[group];
  if (!chart) return;
  airState.cursors[group] = Math.max(0, Math.min(chart.points.length - 1, index));
  const point = chart.points[airState.cursors[group]];
  const bucket = airState.history[group].data.bucket_seconds;
  $("air-reading-" + group).innerHTML = `<div class="air-reading-time">${e(new Date(point.timestamp * 1000).toLocaleString())} · ${Math.round(bucket / 60)} min bucket</div>` + airGroups[group].metrics.map(key => {
    const metric = airMetrics[key];
    const status = airPointStatus(key, point[key], point[`${key}_peak`]);
    return `<span class="air-series-reading" data-air-reading="${key}" style="--series-color:${metric.color}"><span class="air-reading-value"><i class="air-swatch" aria-hidden="true"></i>${metric.label} <strong>${airNumber(point[key], key)} ${e(metric.unit)}</strong><small>peak ${airNumber(point[`${key}_peak`], key)}</small></span><span class="air-reading-status" data-tone="${status.tone}" title="${e(metric.note)}"><b>${e(status.label)}</b>${status.detail ? `<span>${e(status.detail)}</span>` : ""}</span>${airReadingPercentage(status)}</span>`;
  }).join("");
  const cursor = $("air-cursor-" + group);
  cursor.setAttribute("x1", chart.x(point.timestamp));
  cursor.setAttribute("x2", chart.x(point.timestamp));
  cursor.setAttribute("visibility", "visible");
}
async function refreshAirQuality(force = false, onlyGroup = null) {
  if (document.hidden || document.body.dataset.stView === "planner") return;
  const requests = new Map();
  await Promise.all((onlyGroup ? [onlyGroup] : Object.keys(airGroups)).map(async group => {
    const history = airState.history[group];
    if (!force && history.loading) return;
    const request = ++history.request, hours = history.hours, bucket = history.bucket;
    const url = `/api/air-quality?hours=${hours}${bucket === "auto" ? "" : `&bucket=${bucket}`}`;
    history.loading = true;
    renderAirChart(group);
    try {
      // Share a response only when both the range and bucket match, preserving
      // their independent range, loading, failure, and request-order state.
      if (!requests.has(url)) requests.set(url, api(url));
      const data = await requests.get(url);
      if (request !== history.request) return;
      history.data = data;
      history.error = false;
      if (!airState.data || data.now >= airState.data.now) airState.data = data;
    } catch {
      if (request !== history.request) return;
      history.error = true;
    } finally {
      if (request === history.request) {
        history.loading = false;
        airState.error = Object.values(airState.history).every(item => item.error);
        if (airState.data) renderAirQuality();
        else {
          renderAirChart(group);
          $("air-status").dataset.stale = "true";
          $("air-status").textContent = "Air quality unavailable. Retrying shortly…";
        }
      }
    }
  }));
}
function updateAirFullscreen() {
  for (const group of Object.keys(airGroups)) {
    const panel = $("air-panel-" + group);
    const expanded = document.fullscreenElement === panel || airState.expanded?.panel === panel;
    panel.classList.toggle("is-expanded", expanded);
    const button = $("air-fullscreen-" + group);
    button.textContent = expanded ? "Exit fullscreen" : "Fullscreen";
    button.setAttribute("aria-pressed", String(expanded));
    button.setAttribute("aria-label", `${expanded ? "Exit fullscreen for" : "Show fullscreen:"} ${airGroups[group].label}`);
  }
  renderAirCharts();
}
async function toggleAirFullscreen(group) {
  const panel = $("air-panel-" + group), dialog = $("air-fullscreen-dialog");
  if (document.fullscreenElement === panel) {
    await document.exitFullscreen();
    return;
  }
  if (airState.expanded) {
    dialog.close();
    return;
  }
  if (document.fullscreenEnabled && panel.requestFullscreen) {
    try {
      await panel.requestFullscreen();
      return;
    } catch { /* Embedded browsers may disallow native fullscreen. */ }
  }
  // A modal fills the app viewport when native fullscreen is unavailable.
  // Move the existing panel so controls and the chart retain their state.
  const placeholder = document.createComment("Air chart position");
  panel.before(placeholder);
  airState.expanded = { panel, placeholder, group };
  dialog.append(panel);
  dialog.showModal();
  updateAirFullscreen();
  $("air-fullscreen-" + group).focus();
}
function initAirQuality() {
  $("air-cards").addEventListener("click", event => {
    const card = event.target.closest("[data-air-group]");
    if (card) $("air-chart-" + card.dataset.airGroup).focus({ preventScroll: true });
  });
  document.addEventListener("fullscreenchange", updateAirFullscreen);
  $("air-fullscreen-dialog").addEventListener("close", () => {
    const expanded = airState.expanded;
    if (!expanded) return;
    expanded.placeholder.replaceWith(expanded.panel);
    airState.expanded = null;
    updateAirFullscreen();
    $("air-fullscreen-" + expanded.group).focus({ preventScroll: true });
  });
  for (const group of Object.keys(airGroups)) {
    $("air-fullscreen-" + group).addEventListener("click", () => toggleAirFullscreen(group));
    function selectRange(hours) {
      if (!airRanges.includes(hours)) return;
      airState.history[group].hours = hours;
      if (!airBucketAllowed(hours, airState.history[group].bucket)) airState.history[group].bucket = "auto";
      airState.cursors[group] = null;
      $("air-range-select-" + group).value = String(hours);
      $("air-range-" + group).querySelectorAll("button").forEach(el => {
        const selected = Number(el.dataset.airHours) === hours;
        el.classList.toggle("selected", selected);
        el.setAttribute("aria-pressed", String(selected));
      });
      refreshAirQuality(true, group);
    }
    function selectBucket(value) {
      const bucket = value === "auto" ? "auto" : Number(value);
      if (!airBucketAllowed(airState.history[group].hours, bucket)) return;
      airState.history[group].bucket = bucket;
      airState.cursors[group] = null;
      refreshAirQuality(true, group);
    }
    $("air-range-" + group).addEventListener("click", event => {
      const button = event.target.closest("[data-air-hours]");
      if (button) selectRange(Number(button.dataset.airHours));
    });
    $("air-range-select-" + group).addEventListener("change", event => selectRange(Number(event.target.value)));
    $("air-bucket-" + group).addEventListener("click", event => {
      const button = event.target.closest("[data-air-bucket]");
      if (button && !button.disabled) selectBucket(button.dataset.airBucket);
    });
    $("air-bucket-select-" + group).addEventListener("change", event => selectBucket(event.target.value));
    const element = $("air-chart-" + group);
    function inspectPointer(event) {
      const chart = airState.charts[group];
      if (!chart) return;
      const position = event.clientX - element.getBoundingClientRect().left;
      const time = chart.start + (position - chart.left) / (chart.right - chart.left) * (chart.end - chart.start);
      let nearest = 0;
      chart.points.forEach((point, i) => { if (Math.abs(point.timestamp - time) < Math.abs(chart.points[nearest].timestamp - time)) nearest = i; });
      inspectAirPoint(group, nearest);
    }
    element.addEventListener("pointermove", inspectPointer);
    element.addEventListener("pointerdown", inspectPointer);
    element.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !airState.charts[group]) return;
      event.preventDefault();
      const last = airState.charts[group].points.length - 1;
      inspectAirPoint(group, event.key === "Home" ? 0 : event.key === "End" ? last : (airState.cursors[group] ?? last) + (event.key === "ArrowLeft" ? -1 : 1));
    });
    new ResizeObserver(() => renderAirChart(group)).observe(element);
  }
  setInterval(() => { if (state.view === "air-quality") refreshAirQuality(); }, 30000);
  document.addEventListener("visibilitychange", () => { if (state.view === "air-quality") refreshAirQuality(); });
  refreshAirQuality();
}

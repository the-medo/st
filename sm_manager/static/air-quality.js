/* Sensor data is fetched by the server; the browser only uses our private API. */
const airState = { data: null, hours: 24, request: 0, loading: false, error: false, charts: {}, cursors: {} };
const airMetrics = {
  co2: { label: "CO₂", unit: "ppm", digits: 0, color: "#58a6ff", refs: [1000, 1500, 2000], note: "Ventilation reminders at 1,000 / 1,500 / 2,000 ppm. Persistent readings above 1,500 ppm indicate poor ventilation." },
  pm25: { label: "PM2.5", unit: "µg/m³", digits: 1, color: "#63cf8c", refs: [15], note: "15 µg/m³ is the WHO 24-hour average reference. An individual point above this line is not a daily exposure assessment." },
  pm10: { label: "PM10", unit: "µg/m³", digits: 1, color: "#56d4dd", refs: [45], note: "45 µg/m³ is the WHO 24-hour average reference. An individual point above this line is not a daily exposure assessment." },
  voc: { label: "VOC", unit: "index", digits: 0, color: "#d2a8ff", refs: [150, 250, 400], note: "Relative VOC index; learned baseline 100. Bands at 150 / 250 / 400 follow Sensirion’s purifier response guidance, not toxicity limits." },
  nox: { label: "NOₓ", unit: "index", digits: 0, color: "#f778ba", refs: [20, 150, 300], note: "Relative NOₓ index; baseline 1. Bands at 20 / 150 / 300 follow Sensirion’s purifier response guidance, not gas concentration limits." },
  temperature: { label: "Temperature", unit: "°C", digits: 1, color: "#f0b65f", refs: [], note: "Temperature from the SEN55 sensor. The enclosure and sensor electronics can affect this reading." },
  humidity: { label: "Humidity", unit: "%", digits: 1, color: "#a5d6ff", refs: [], note: "Relative humidity from the SEN55 sensor." },
  pm1: { label: "PM1", unit: "µg/m³", digits: 1, color: "#b6dc7b", refs: [], note: "PM1 particle mass concentration. No WHO daily guideline is applied to this size fraction." },
  pm4: { label: "PM4", unit: "µg/m³", digits: 1, color: "#9cd5cb", refs: [], note: "PM4 particle mass concentration. No WHO daily guideline is applied to this size fraction." },
};
const airGroups = {
  air: { label: "Air measurements", metrics: ["co2", "pm1", "pm25", "pm10", "voc", "nox"], axes: [
    { id: "co2", label: "CO₂ · ppm", metrics: ["co2"], minimum: 0, baseline: 2000, color: "#58a6ff" },
    { id: "particles", label: "PM · µg/m³", metrics: ["pm1", "pm25", "pm10"], minimum: 0, baseline: 50, color: "#63cf8c" },
    { id: "gas", label: "Gas index", metrics: ["voc", "nox"], minimum: 0, baseline: 500, color: "#d2a8ff", optional: true },
  ] },
  climate: { label: "Temperature & humidity", metrics: ["temperature", "humidity"], axes: [
    { id: "temperature", label: "Temperature · °C", metrics: ["temperature"], minimum: 0, baseline: 40, color: "#f0b65f" },
    { id: "humidity", label: "Humidity · %", metrics: ["humidity"], minimum: 0, baseline: 100, color: "#a5d6ff" },
  ] },
};
function airNumber(value, metric = "co2") {
  return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: airMetrics[metric].digits }) : "—";
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
  const data = airState.data, definition = airGroups[group], element = $("air-chart-" + group);
  if (!data || element.closest("[hidden]")) return;
  const points = data.points.filter(point => definition.metrics.some(key => Number.isFinite(point[key])));
  airState.charts[group] = null;
  $("air-reading-" + group).textContent = "Hover, tap, or use the arrow keys to inspect all readings.";
  $("air-legend-" + group).innerHTML = definition.metrics.map(key => {
    const metric = airMetrics[key], available = points.some(point => Number.isFinite(point[key]));
    const values = points.map(point => point[`${key}_peak`] ?? point[key]).filter(Number.isFinite);
    const detail = available ? `Peak ${airNumber(Math.max(...values), key)} ${metric.unit}` : "No readings";
    return `<span class="air-series-legend" data-air-series="${key}" style="--series-color:${metric.color}"><i class="air-swatch" aria-hidden="true"></i><strong>${metric.label}</strong><span>${e(detail)}</span></span>`;
  }).join("");
  if (!points.length) {
    element.innerHTML = `<div class="chart-placeholder">No readings for this section in this range yet.</div>`;
    element.setAttribute("aria-label", `${definition.label}: no readings in the selected range`);
    return;
  }
  const width = Math.max(280, element.clientWidth), height = element.clientHeight || 340;
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
    svg += `<text x="${position}" y="15" text-anchor="${index === 0 ? "start" : "end"}" style="fill:${axis.color}">${e(axis.label)}</text>`;
  });
  for (let i = 0; i <= 3; i++) {
    const time = start + (end - start) * i / 3;
    const label = new Date(time * 1000).toLocaleString(undefined, data.hours > 24 ? { month: "short", day: "numeric" } : { hour: "2-digit", minute: "2-digit" });
    svg += `<text x="${x(time)}" y="${height - 8}" text-anchor="${i === 0 ? "start" : i === 3 ? "end" : "middle"}">${e(label)}</text>`;
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
}
function inspectAirPoint(group, index) {
  const chart = airState.charts[group];
  if (!chart) return;
  airState.cursors[group] = Math.max(0, Math.min(chart.points.length - 1, index));
  const point = chart.points[airState.cursors[group]];
  const bucket = airState.data.bucket_seconds;
  $("air-reading-" + group).innerHTML = `<div class="air-reading-time">${e(new Date(point.timestamp * 1000).toLocaleString())} · ${Math.round(bucket / 60)} min bucket</div>` + airGroups[group].metrics.map(key => {
    const metric = airMetrics[key];
    return `<span class="air-series-reading" style="--series-color:${metric.color}"><i class="air-swatch" aria-hidden="true"></i>${metric.label} <strong>${airNumber(point[key], key)} ${e(metric.unit)}</strong><small>peak ${airNumber(point[`${key}_peak`], key)}</small></span>`;
  }).join("");
  const cursor = $("air-cursor-" + group);
  cursor.setAttribute("x1", chart.x(point.timestamp));
  cursor.setAttribute("x2", chart.x(point.timestamp));
  cursor.setAttribute("visibility", "visible");
}
async function refreshAirQuality(force = false) {
  if (document.hidden || (!force && airState.loading)) return;
  const request = ++airState.request;
  airState.loading = true;
  try {
    const data = await api(`/api/air-quality?hours=${airState.hours}`);
    if (request !== airState.request) return;
    airState.data = data;
    airState.error = false;
    renderAirQuality();
  } catch {
    if (request !== airState.request) return;
    airState.error = true;
    if (airState.data) renderAirQuality();
    else {
      $("air-status").dataset.stale = "true";
      $("air-status").textContent = "Air quality unavailable. Retrying shortly…";
    }
  } finally {
    if (request === airState.request) airState.loading = false;
  }
}
function initAirQuality() {
  $("air-cards").addEventListener("click", event => {
    const card = event.target.closest("[data-air-group]");
    if (card) $("air-chart-" + card.dataset.airGroup).focus({ preventScroll: true });
  });
  $("air-range").addEventListener("click", event => {
    const button = event.target.closest("[data-air-hours]");
    if (!button) return;
    airState.hours = Number(button.dataset.airHours);
    $("air-range").querySelectorAll("button").forEach(el => {
      el.classList.toggle("selected", el === button);
      el.setAttribute("aria-pressed", String(el === button));
    });
    refreshAirQuality(true);
  });
  for (const group of Object.keys(airGroups)) {
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

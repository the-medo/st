/* Sensor data is fetched by the server; the browser only uses our private API. */
const airState = { data: null, hours: 24, metric: "co2", request: 0, loading: false, error: false, cursor: null, chart: null };
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
function airNumber(value, metric = airState.metric) {
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
  $("air-cards").innerHTML = ["co2", "pm25", "pm10", "voc", "nox", "temperature", "humidity", "pm1"].map((key) => {
    const metric = airMetrics[key], value = latest?.[key];
    const [tone, label] = airLevel(key, value, data);
    const daily = data.daily[key];
    const note = daily ? `${daily.complete ? "24h mean" : "Partial mean"}: ${airNumber(daily.value, key)} ${metric.unit} · ${Math.round(daily.coverage * 100)}% of day covered` : key === "voc" || key === "nox" ? "Relative index · not a concentration" : "Latest published measurement";
    return `<button class="air-card" data-air-metric="${key}" aria-pressed="${airState.metric === key}"><span class="air-card-label">${metric.label}</span><span class="air-card-value">${airNumber(value, key)} <small>${metric.unit}</small></span><span class="air-level" data-tone="${tone}">${e(label)}</span><span class="air-card-note">${e(note)}</span></button>`;
  }).join("");
  $("air-history-note").textContent = `${data.started_at ? `History since ${new Date(data.started_at * 1000).toLocaleString()}.` : "History starts with the first successful reading."} Stored for 30 days, including while this page is closed. Repeated readings are counted once; gaps are left empty. Times use your browser’s timezone.`;
  renderAirChart();
}
function renderAirChart() {
  const data = airState.data, element = $("air-chart"), metric = airMetrics[airState.metric];
  if (!data || element.closest("[hidden]")) return;
  $("air-reference").textContent = metric.note;
  const points = data.points.filter((point) => Number.isFinite(point[airState.metric]));
  airState.chart = null;
  $("air-chart-reading").textContent = "Hover, tap, or use the arrow keys to inspect readings.";
  $("air-chart-summary").textContent = `${metric.label} · ${metric.unit}`;
  if (!points.length) {
    element.innerHTML = `<div class="chart-placeholder">${data.points.length ? "No valid readings for this measurement in this range." : "No readings in this range yet."}</div>`;
    element.setAttribute("aria-label", `${metric.label}: no readings in the selected range`);
    return;
  }
  const width = Math.max(280, element.clientWidth), height = element.clientHeight || 340;
  const left = 48, right = width - 18, top = 22, bottom = height - 32;
  const start = data.now - data.hours * 3600, end = data.now;
  const values = points.flatMap((p) => [p[airState.metric], p[`${airState.metric}_peak`]]).filter(Number.isFinite);
  const minimum = Math.min(0, ...values), maximum = Math.max(1, ...values, ...metric.refs) * 1.14;
  const x = (time) => left + (time - start) / (end - start) * (right - left);
  const y = (value) => bottom - (value - minimum) / (maximum - minimum) * (bottom - top);
  let svg = "";
  const bands = ["#f0b65f", "#f0985f", "#ff7b72"];
  metric.refs.forEach((reference, i) => {
    const upper = metric.refs[i + 1] || maximum;
    svg += `<rect x="${left}" y="${y(upper)}" width="${right - left}" height="${y(reference) - y(upper)}" fill="${bands[i]}" opacity=".055"/><line x1="${left}" x2="${right}" y1="${y(reference)}" y2="${y(reference)}" stroke="${bands[i]}" stroke-dasharray="5 5" opacity=".65"/><text x="${right - 4}" y="${y(reference) - 5}" text-anchor="end">${reference} ${e(metric.unit)}</text>`;
  });
  for (let i = 0; i <= 4; i++) {
    const value = minimum + (maximum - minimum) * i / 4;
    svg += `<line class="chart-grid" x1="${left}" x2="${right}" y1="${y(value)}" y2="${y(value)}"/><text x="${left - 8}" y="${y(value) + 3}" text-anchor="end">${airNumber(value)}</text>`;
  }
  for (let i = 0; i <= 3; i++) {
    const time = start + (end - start) * i / 3;
    const label = new Date(time * 1000).toLocaleString(undefined, data.hours > 24 ? { month: "short", day: "numeric" } : { hour: "2-digit", minute: "2-digit" });
    svg += `<text x="${x(time)}" y="${height - 8}" text-anchor="${i === 0 ? "start" : i === 3 ? "end" : "middle"}">${e(label)}</text>`;
  }
  let previous = null, path = "", peakPath = "";
  for (const point of data.points) {
    const value = point[airState.metric];
    if (!Number.isFinite(value)) { previous = null; continue; }
    const command = previous && point.timestamp - previous.timestamp <= Math.max(180, data.bucket_seconds * 1.5) ? "L" : "M";
    path += `${command}${x(point.timestamp).toFixed(1)},${y(value).toFixed(1)} `;
    peakPath += `${command}${x(point.timestamp).toFixed(1)},${y(point[`${airState.metric}_peak`] ?? value).toFixed(1)} `;
    previous = point;
  }
  svg += `<path d="${peakPath}" fill="none" stroke="${metric.color}" stroke-width="1" stroke-dasharray="3 3" opacity=".5"/><path d="${path}" fill="none" stroke="${metric.color}" stroke-width="2"/>`;
  svg += points.map((point) => `<circle cx="${x(point.timestamp)}" cy="${y(point[airState.metric])}" r="${points.length < 5 ? 3 : 1.5}" fill="${metric.color}"/>`).join("");
  svg += `<line id="air-cursor" x1="0" x2="0" y1="${top}" y2="${bottom}" stroke="${metric.color}" stroke-dasharray="3 3" visibility="hidden"/>`;
  element.innerHTML = `<svg viewBox="0 0 ${width} ${height}" aria-hidden="true">${svg}</svg>`;
  element.setAttribute("aria-label", `${metric.label} history over ${data.hours} hours in ${metric.unit}. Arrow keys inspect readings. Solid line: bucket average; dashed: peak. Gaps indicate missing data.`);
  // Range extrema and peaks retain spikes that averaging alone would hide.
  $("air-chart-summary").textContent = `Min ${airNumber(Math.min(...points.map(p => p[airState.metric])))} · peak ${airNumber(Math.max(...values))} ${metric.unit} · solid mean / dashed peak`;
  airState.chart = { points, start, end, left, right, x };
}
function inspectAirPoint(index) {
  const chart = airState.chart;
  if (!chart) return;
  airState.cursor = Math.max(0, Math.min(chart.points.length - 1, index));
  const point = chart.points[airState.cursor], metric = airMetrics[airState.metric];
  const bucket = airState.data.bucket_seconds;
  $("air-chart-reading").textContent = `${new Date(point.timestamp * 1000).toLocaleString()} · ${metric.label} ${airNumber(point[airState.metric])} ${metric.unit} · peak ${airNumber(point[`${airState.metric}_peak`])} · ${Math.round(bucket / 60)} min bucket`;
  const cursor = $("air-cursor");
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
  function selectMetric(metric) {
    airState.metric = metric;
    airState.cursor = null;
    $("air-metric").value = metric;
    renderAirQuality();
  }
  $("air-metric").addEventListener("change", event => selectMetric(event.target.value));
  $("air-cards").addEventListener("click", event => {
    const card = event.target.closest("[data-air-metric]");
    if (card) selectMetric(card.dataset.airMetric);
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
  $("air-chart").addEventListener("pointermove", event => {
    const chart = airState.chart;
    if (!chart) return;
    const position = event.clientX - $("air-chart").getBoundingClientRect().left;
    const time = chart.start + (position - chart.left) / (chart.right - chart.left) * (chart.end - chart.start);
    let nearest = 0;
    chart.points.forEach((point, i) => { if (Math.abs(point.timestamp - time) < Math.abs(chart.points[nearest].timestamp - time)) nearest = i; });
    inspectAirPoint(nearest);
  });
  $("air-chart").addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !airState.chart) return;
    event.preventDefault();
    const last = airState.chart.points.length - 1;
    inspectAirPoint(event.key === "Home" ? 0 : event.key === "End" ? last : (airState.cursor ?? last) + (event.key === "ArrowLeft" ? -1 : 1));
  });
  new ResizeObserver(renderAirChart).observe($("air-chart"));
  setInterval(() => { if (state.view === "air-quality") refreshAirQuality(); }, 30000);
  document.addEventListener("visibilitychange", () => { if (state.view === "air-quality") refreshAirQuality(); });
  refreshAirQuality();
}

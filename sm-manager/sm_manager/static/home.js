/* The home charts use only whole-machine history, independent of monitor filters. */
const HomeDashboard = (() => {
  const get = (id) => document.getElementById(id);
  const valid = (value) => typeof value === "number" && Number.isFinite(value);
  let history = null;
  let historyError = false;
  let loading = false;
  let lastSample = null;

  function sparkline(points, metric, capacity, now, bucket = 10) {
    const start = now - 900;
    const segments = [];
    let segment = [];
    let previous = null;
    for (const point of points) {
      const value = point[metric];
      if (!valid(point.timestamp) || point.timestamp < start || point.timestamp > now) continue;
      if (!valid(value) || !valid(capacity) || capacity <= 0) {
        if (segment.length) segments.push(segment);
        segment = [];
        previous = null;
        continue;
      }
      if (previous !== null && point.timestamp - previous > bucket * 2) {
        if (segment.length) segments.push(segment);
        segment = [];
      }
      const x = 2 + (point.timestamp - start) / 900 * 236;
      const y = 60 - Math.min(100, Math.max(0, value / capacity * 100)) / 100 * 54;
      segment.push([x.toFixed(2), y.toFixed(2)]);
      previous = point.timestamp;
    }
    if (segment.length) segments.push(segment);
    if (!segments.length) return '<span class="home-chart-empty">Waiting for history</span>';
    const paths = segments.map((line) => {
      const path = line.map((point, i) => `${i ? "L" : "M"}${point.join(",")}`).join(" ");
      const first = line[0], last = line[line.length - 1];
      return `<path class="spark-fill" d="${path} L${last[0]},64 L${first[0]},64 Z"/><path class="spark-line" d="${path}"/>${line.length === 1 ? `<circle cx="${first[0]}" cy="${first[1]}" r="2" fill="currentColor"/>` : ""}`;
    }).join("");
    return `<svg viewBox="0 0 240 64" preserveAspectRatio="none" aria-hidden="true"><path class="spark-grid" d="M0 6H240M0 33H240M0 60H240"/>${paths}</svg>`;
  }

  function update(snapshot, online = true) {
    const system = snapshot?.system;
    const ram = valid(system?.memory_used) && valid(system?.memory_total) && system.memory_total > 0
      ? system.memory_used / system.memory_total * 100 : null;
    get("home-ram-value").textContent = valid(ram) ? ram.toFixed(1) : "—";
    get("home-cpu-value").textContent = valid(system?.cpu_percent) ? system.cpu_percent.toFixed(1) : "—";
    get("home-ram-detail").textContent = valid(ram)
      ? `${(system.memory_used / 1024 ** 3).toFixed(1)} / ${(system.memory_total / 1024 ** 3).toFixed(1)} GiB`
      : "Waiting for a sample";
    get("home-cpu-detail").textContent = valid(system?.cores) ? `${system.cores} logical cores` : "Waiting for a sample";
    const stale = !online || !snapshot || snapshot.stale || Date.now() / 1000 - snapshot.timestamp > Math.max(30, snapshot.interval * 3);
    get("home-section").dataset.stale = String(stale);
    get("home-metrics-status").textContent = stale
      ? snapshot ? "Last known readings · reconnecting" : online ? "Connecting to monitor…" : "Monitor unavailable · retrying"
      : historyError ? "History unavailable · retrying" : `Updated every ${snapshot.interval}s`;
  }

  async function refresh(snapshot) {
    if (!snapshot || loading || (lastSample === snapshot.timestamp && !historyError)) return;
    loading = true;
    lastSample = snapshot.timestamp;
    try {
      const response = await fetch("/api/history?hours=0.25&entity=host", { cache: "no-store", signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error("History unavailable");
      const data = await response.json();
      if (!Array.isArray(data.points)) throw new Error("Invalid history");
      history = data;
      historyError = false;
    } catch {
      historyError = true;
    } finally {
      loading = false;
    }
    for (const [name, metric, capacity] of [["ram", "memory_bytes", snapshot.system.memory_total], ["cpu", "cpu_percent", 100]]) {
      const chart = get(`home-${name}-chart`);
      chart.innerHTML = sparkline(history?.points || [], metric, capacity, Date.now() / 1000, history?.bucket_seconds || 10);
      chart.setAttribute("aria-label", `${name.toUpperCase()} usage over the last 15 minutes, scale 0 to 100 percent.${historyError ? " History unavailable; showing any previous samples." : ""}`);
    }
  }

  return { update, refresh, sparkline };
})();

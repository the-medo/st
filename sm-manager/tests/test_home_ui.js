const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

function dashboard(fetch) {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, { dataset: {}, attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } });
    return elements.get(id);
  };
  const context = { document: { getElementById: get }, AbortSignal, fetch };
  vm.runInNewContext(readFileSync(join(__dirname, "../sm_manager/static/home.js"), "utf8") + "\nthis.home = HomeDashboard", context);
  return { home: context.home, get };
}
const snapshot = () => ({ timestamp: Date.now() / 1000, interval: 10, system: { memory_used: 8 * 1024 ** 3, memory_total: 32 * 1024 ** 3, cpu_percent: 12.5, cores: 12 } });

test("missing metrics stay unknown; RAM leads with used GB and stale readings are labelled", () => {
  const { home, get } = dashboard();
  home.update(null, false);
  assert.equal(get("home-ram-value").textContent, "—");
  assert.equal(get("home-cpu-value").textContent, "—");
  assert.match(get("home-metrics-status").textContent, /unavailable/);
  const data = snapshot();
  home.update(data);
  assert.equal(get("home-ram-value").textContent, "8.6");
  assert.equal(get("home-ram-detail").textContent, "of 34.4 GB · 25.0%");
  assert.equal(get("home-cpu-value").textContent, "12.5");
  home.update({ ...data, timestamp: data.timestamp - 60 });
  assert.match(get("home-metrics-status").textContent, /Last known/);
  home.update({ ...data, system: { memory_total: 0, memory_used: 10, cpu_percent: null } });
  assert.equal(get("home-ram-value").textContent, "—");
  assert.equal(get("home-cpu-value").textContent, "—");
});

test("sparklines preserve time gaps and do not turn null samples into zero", () => {
  const { home } = dashboard();
  const chart = home.sparkline([
    { timestamp: 100, cpu_percent: 20 }, { timestamp: 110, cpu_percent: 30 },
    { timestamp: 120, cpu_percent: null }, { timestamp: 130, cpu_percent: 40 },
    { timestamp: 500, cpu_percent: 80 }, { timestamp: 2000, cpu_percent: 100 },
  ], "cpu_percent", 100, 900);
  assert.equal((chart.match(/class="spark-line"/g) || []).length, 3);
  assert.doesNotMatch(chart, /NaN|Infinity|undefined/);
  assert.match(home.sparkline([{ timestamp: 100, memory_bytes: 10 }], "memory_bytes", 0, 900), /Waiting for history/);
});

test("home fetches only host history, deduplicates samples, and recovers after failure", async () => {
  const calls = [];
  let fail = false;
  const { home, get } = dashboard(async (url) => {
    calls.push(url);
    return { ok: !fail, json: async () => ({ points: [{ timestamp: Date.now() / 1000 - 10, cpu_percent: 12, memory_bytes: 1024 }], bucket_seconds: 10 }) };
  });
  const data = snapshot();
  await home.refresh(data);
  await home.refresh(data);
  assert.deepEqual(calls, ["/api/history?hours=0.25&entity=host"]);
  fail = true;
  data.timestamp += 10;
  await home.refresh(data);
  home.update(data);
  assert.match(get("home-metrics-status").textContent, /History unavailable/);
  assert.match(get("home-cpu-chart").innerHTML, /spark-line/);
  fail = false;
  await home.refresh(data);
  home.update(data);
  assert.equal(calls.length, 3);
  assert.match(get("home-metrics-status").textContent, /Updated every/);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

function setup() {
  const elements = new Map();
  const $ = id => {
    if (!elements.has(id)) elements.set(id, {
      innerHTML: '', textContent: '', dataset: {}, hidden: false,
      clientWidth: 800, clientHeight: 340, attributes: {},
      closest: () => null, setAttribute(key, value) { this.attributes[key] = value; },
    });
    return elements.get(id);
  };
  const context = vm.createContext({ $, document: { hidden: false }, console,
    e: value => String(value), ago: () => '1m ago', api: async () => data(),
  });
  vm.runInContext(fs.readFileSync('sm_manager/static/air-quality.js', 'utf8') + '\nthis.airState = airState;', context);
  return { context, $ };
}
function data() {
  return { enabled: true, stale: false, now: 1800000000, hours: 24, bucket_seconds: 240,
    latest: { timestamp: 1799999940, co2: 900, pm1: 10, pm25: 30, pm10: 40, voc: null, nox: null, temperature: 24, humidity: 45 },
    daily: { pm25: { value: 30, coverage: .1, complete: false } },
    points: [
      { timestamp: 1799999000, co2: 800, co2_peak: 1200 },
      { timestamp: 1799999240, co2: null, co2_peak: null },
      { timestamp: 1799999940, co2: 900, co2_peak: 900 },
    ],
  };
}
test('level indicators respect missing values, staleness and daily coverage', () => {
  const { context } = setup();
  const d = data();
  const level = (key, value) => [...context.airLevel(key, value, d)];
  assert.deepEqual(level('voc', null), ['neutral', 'Unavailable']);
  assert.equal(level('co2', 900)[0], 'good');
  assert.equal(level('co2', 1501)[0], 'watch');
  assert.equal(level('co2', 2000)[0], 'high');
  assert.equal(level('pm25', 300)[0], 'neutral');
  d.daily.pm25.complete = true;
  assert.equal(level('pm25', 1)[0], 'watch'); // Daily mean, not latest value.
  d.daily.pm25.value = 10;
  assert.equal(level('pm25', 300)[0], 'good');
  assert.equal(level('voc', 400)[0], 'high');
  assert.equal(level('nox', 20)[0], 'watch');
  d.stale = true;
  assert.deepEqual(level('co2', 900), ['neutral', 'Last known reading']);
});
test('air chart shows all available series while retaining gaps and peaks', () => {
  const { context, $ } = setup();
  const d = data();
  d.points[0].pm25 = 20;
  d.points[0].pm25_peak = 35;
  d.points[2].pm25 = 30;
  context.airState.data = d;
  context.renderAirQuality();
  assert.equal(($('air-cards').innerHTML.match(/class="air-card"/g) || []).length, 8);
  assert.equal(($('air-cards').innerHTML.match(/data-air-group="air"/g) || []).length, 6);
  assert.equal(($('air-cards').innerHTML.match(/data-air-group="climate"/g) || []).length, 2);
  const paths = [...$('air-chart-air').innerHTML.matchAll(/<path d="([^"]+)"/g)].map(m => m[1]);
  assert.equal(paths.length, 4);
  for (const path of paths) {
    assert.equal((path.match(/M/g) || []).length, 2);
    assert.ok(!path.includes('L'));
  }
  assert.match($('air-chart-air').innerHTML, /data-series="co2"/);
  assert.match($('air-chart-air').innerHTML, /data-series="pm25"/);
  assert.doesNotMatch($('air-chart-air').innerHTML, /data-series="voc"/);
  assert.match($('air-chart-air').innerHTML, /<circle /);
  assert.match($('air-legend-air').innerHTML, /1,200/);
  assert.match($('air-legend-air').innerHTML, /VOC.*No readings/);
  context.inspectAirPoint('air', 99);
  assert.match($('air-reading-air').innerHTML, /CO₂ <strong>900/);
  assert.match($('air-reading-air').innerHTML, /PM2.5 <strong>30/);
  assert.match($('air-reading-air').innerHTML, /VOC <strong>—/);
  assert.equal($('air-cursor-air').attributes.visibility, 'visible');
  assert.match($('air-chart-climate').innerHTML, /No readings for this section/);
});
test('climate renders both series and uses a separate scale for each unit', () => {
  const { context, $ } = setup();
  const d = data();
  d.points.forEach(point => Object.assign(point, { temperature: -2, temperature_peak: 2, humidity: 80, humidity_peak: 90 }));
  context.airState.data = d;
  context.renderAirQuality();
  assert.match($('air-chart-climate').innerHTML, /data-series="temperature"/);
  assert.match($('air-chart-climate').innerHTML, /data-series="humidity"/);
  assert.doesNotMatch($('air-chart-climate').innerHTML, /data-series="co2"/);
  const axes = context.airChartScales('climate', d.points);
  assert.equal(axes.length, 2);
  assert.ok(axes[0].minimum <= -2);
  assert.ok(axes[1].maximum >= 100);
  context.inspectAirPoint('climate', 0);
  assert.match($('air-reading-climate').innerHTML, /Temperature <strong>-2 °C/);
  assert.match($('air-reading-climate').innerHTML, /Humidity <strong>80 %/);
  assert.equal(context.airState.cursors.climate, 0);
  assert.equal(context.airState.cursors.air, undefined);
});
test('gas indexes gain their own axis when present and never share the particle scale', () => {
  const { context } = setup();
  const d = data();
  assert.equal(context.airChartScales('air', d.points).length, 2);
  d.points[0].voc = 400;
  const axes = context.airChartScales('air', d.points);
  assert.equal(axes.length, 3);
  assert.deepEqual([...axes[1].metrics], ['pm1', 'pm25', 'pm10']);
  assert.deepEqual([...axes[2].metrics], ['voc', 'nox']);
  assert.equal(axes[2].maximum, 500);
});
test('failed refresh retains data but suppresses fresh level indicators', async () => {
  const { context, $ } = setup();
  context.airState.data = data();
  context.api = async () => { throw new Error('offline'); };
  await context.refreshAirQuality();
  assert.equal(context.airState.data.latest.co2, 900);
  assert.match($('air-status').textContent, /Stale.*Dashboard connection unavailable/);
  assert.doesNotMatch($('air-cards').innerHTML, /data-tone="good"/);
});
test('late response cannot replace a newer range request', async () => {
  const { context } = setup();
  const pending = [];
  context.api = () => new Promise(resolve => pending.push(resolve));
  const first = context.refreshAirQuality(true);
  context.airState.hours = 1;
  const second = context.refreshAirQuality(true);
  pending[1]({ ...data(), hours: 1 });
  await second;
  pending[0](data());
  await first;
  assert.equal(context.airState.data.hours, 1);
});

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
    latest: { timestamp: 1799999940, co2: 900, pm25: 30, voc: null, nox: null },
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
test('charts keep gaps, show isolated readings and preserve peaks', () => {
  const { context, $ } = setup();
  context.airState.data = data();
  context.renderAirQuality();
  const paths = [...$('air-chart').innerHTML.matchAll(/<path d="([^"]+)"/g)].map(m => m[1]);
  assert.equal(paths.length, 2);
  for (const path of paths) {
    assert.equal((path.match(/M/g) || []).length, 2);
    assert.ok(!path.includes('L'));
  }
  assert.match($('air-chart').innerHTML, /<circle /);
  assert.match($('air-chart-summary').textContent, /1,200/);
  context.inspectAirPoint(99);
  assert.match($('air-chart-reading').textContent, /CO₂ 900/);
  assert.equal($('air-cursor').attributes.visibility, 'visible');
  context.airState.metric = 'voc';
  context.renderAirChart();
  assert.match($('air-chart').innerHTML, /No valid readings/);
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

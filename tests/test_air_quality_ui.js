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
      closest: () => null, querySelectorAll: () => [], setAttribute(key, value) { this.attributes[key] = value; },
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
  return { enabled: true, stale: false, now: 1800000000, hours: 6, bucket_seconds: 240,
    latest: { timestamp: 1799999940, co2: 900, pm1: 10, pm25: 30, pm10: 40, voc: null, nox: null, temperature: 24, humidity: 45 },
    daily: { pm25: { value: 30, coverage: .1, complete: false } },
    points: [
      { timestamp: 1799999000, co2: 800, co2_peak: 1200 },
      { timestamp: 1799999240, co2: null, co2_peak: null },
      { timestamp: 1799999940, co2: 900, co2_peak: 900 },
    ],
  };
}
function seed(context, value) {
  context.airState.data = value;
  for (const history of Object.values(context.airState.history)) history.data = value;
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
test('inspection labels use ventilation references and report the actual excess', () => {
  const { context } = setup();
  const status = (mean, peak) => context.airPointStatus('co2', mean, peak);
  assert.equal(status(1000).label, 'OK');
  assert.equal(status(1001).tone, 'watch');
  assert.equal(status(1001).detail, '+1 ppm above 1,000 ppm reminder');
  assert.equal(status(1800).detail, '+300 ppm above 1,500 ppm ventilation ref');
  assert.equal(status(900, 1800).detail, 'Peak · +300 ppm above 1,500 ppm ventilation ref');
  assert.equal(status(900, 1800).label, 'Warning');
  assert.equal(status(900, 850).label, 'OK');
  assert.match(status(1000.01).detail, /\+<1 ppm/); // Never round a positive excess to zero.
});
test('particle inspection compares the selected point to a named daily reference', () => {
  const { context } = setup();
  const d = data();
  d.daily.pm25 = { complete: true, value: 10, coverage: 1 };
  seed(context, d);
  assert.equal(context.airPointStatus('pm25', 15).label, 'OK');
  assert.equal(context.airPointStatus('pm25', 17.5).detail, '+2.5 µg/m³ above 15 µg/m³ · 24h ref');
  assert.equal(context.airPointStatus('pm10', 50).detail, '+5 µg/m³ above 45 µg/m³ · 24h ref');
  assert.equal(context.airPointStatus('pm25', 10, 35).detail, 'Peak · +20 µg/m³ above 15 µg/m³ · 24h ref');
  assert.equal(context.airLevel('pm25', 35, d)[0], 'good'); // Daily card remains independent.
  d.daily.pm25.complete = false;
  assert.equal(context.airLevel('pm25', 10, d)[0], 'neutral');
});
test('gas inspection uses response bands and never treats missing or zero indexes as OK', () => {
  const { context } = setup();
  for (const [key, threshold] of [['voc', 150], ['nox', 20]]) {
    assert.equal(context.airPointStatus(key, threshold - 1).label, 'OK');
    assert.equal(context.airPointStatus(key, threshold).tone, 'watch');
    assert.equal(context.airPointStatus(key, threshold).detail, `At ${threshold} index band`);
    assert.equal(context.airPointStatus(key, threshold + 50).detail, `+50 index above ${threshold} index band`);
    for (const value of [null, undefined, NaN, Infinity, 0, -1]) {
      assert.equal(context.airPointStatus(key, value, 250).label, 'Unavailable');
    }
  }
});
test('humidity uses percentage points and unbounded measurements stay neutral', () => {
  const { context } = setup();
  assert.equal(context.airPointStatus('humidity', 30).label, 'OK');
  assert.equal(context.airPointStatus('humidity', 59.9).label, 'OK');
  assert.equal(context.airPointStatus('humidity', 60).detail, 'At 60% ceiling');
  assert.equal(context.airPointStatus('humidity', 65).detail, '+5 pp above 60% ceiling');
  assert.equal(context.airPointStatus('humidity', 45, 70).detail, 'Peak · +10 pp above 60% ceiling');
  assert.equal(context.airPointStatus('humidity', 25).detail, '5 pp below 30% ideal minimum');
  assert.equal(context.airPointStatus('humidity', 25).tone, 'watch');
  assert.equal(context.airPointStatus('temperature', 28).label, 'Context only');
  assert.equal(context.airPointStatus('pm1', 50).label, 'No guideline');
  for (const key of ['co2', 'pm1', 'pm25', 'pm10', 'temperature', 'humidity']) {
    assert.equal(context.airPointStatus(key, null).tone, 'neutral');
    assert.equal(context.airPointStatus(key, null).label, 'Unavailable');
  }
});
test('inspection percentages show the ratio to the reference, not the percentage excess', () => {
  const { context, $ } = setup();
  const d = data();
  d.points[0].pm25 = 60;
  seed(context, d);
  context.renderAirQuality();
  context.inspectAirPoint('air', 0);
  assert.match($('air-reading-air').innerHTML, /air-reading-percentage" data-tone="high"[^>]*><strong>400%<\/strong> of reference/);
  const percentage = (key, mean, peak) => context.airReadingPercentage(context.airPointStatus(key, mean, peak));
  assert.match(percentage('pm25', 15), /data-tone="good"[^>]*><strong>100%/);
  assert.match(percentage('pm25', 7.5), /data-tone="good"[^>]*><strong>50%/);
  assert.match(percentage('pm25', 0), /<strong>0%/);
  assert.match(percentage('pm25', 10, 60), /<strong>400%<\/strong> of reference \(peak\)/);
  assert.match(percentage('co2', 1800), /Mean ÷ 1,500 ppm ventilation ref × 100.*<strong>120%/);
  assert.match(percentage('voc', 300), /<strong>200%/);
  assert.match(percentage('humidity', 25), /data-tone="watch".*30% ideal minimum.*<strong>83.3%/);
  assert.match(percentage('humidity', 45), /60% ceiling.*<strong>75%/);
  assert.match(percentage('pm25', 15.001), /data-tone="high"[^>]*><strong>>100%/);
  for (const [key, mean] of [['pm1', 5], ['temperature', 28], ['pm25', null], ['voc', 0]]) {
    assert.equal(percentage(key, mean), '');
  }
});
test('inspection renders statuses for each series and keeps historical comparisons during stale periods', () => {
  const { context, $ } = setup();
  const d = data();
  d.stale = true;
  d.points[0] = { ...d.points[0], co2: 1800, co2_peak: 1800, pm1: 5, pm25: 10, pm25_peak: 35, pm10: 30, voc: 100 };
  seed(context, d);
  context.renderAirQuality();
  context.inspectAirPoint('air', 0);
  const html = $('air-reading-air').innerHTML;
  assert.equal((html.match(/class="air-reading-status"/g) || []).length, 6);
  assert.match(html, /data-tone="watch"[^>]*><b>Warning<\/b><span>\+300 ppm above/);
  assert.match(html, /Peak · \+20 µg\/m³ above 15 µg\/m³ · 24h ref/);
  assert.match(html, /data-tone="good"[^>]*><b>OK<\/b>/);
  assert.match(html, /<b>No guideline<\/b>/);
  assert.match(html, /<b>Unavailable<\/b>/);
  assert.doesNotMatch($('air-cards').innerHTML, /data-tone="good"/);
});
test('air chart shows all available series while retaining gaps and peaks', () => {
  const { context, $ } = setup();
  const d = data();
  d.points[0].pm25 = 20;
  d.points[0].pm25_peak = 35;
  d.points[2].pm25 = 30;
  seed(context, d);
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
  assert.match($('air-legend-air').innerHTML, /data-air-series="voc" title="No readings"/);
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
  seed(context, d);
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
  seed(context, data());
  context.api = async () => { throw new Error('offline'); };
  await context.refreshAirQuality();
  assert.equal(context.airState.data.latest.co2, 900);
  assert.match($('air-status').textContent, /Stale.*Dashboard connection unavailable/);
  assert.doesNotMatch($('air-cards').innerHTML, /data-tone="good"/);
});
test('late responses cannot replace the selected range or change the other chart', async () => {
  const { context } = setup();
  const pending = [];
  context.api = () => new Promise(resolve => pending.push(resolve));
  const first = context.refreshAirQuality(true, 'air');
  context.airState.history.air.hours = 1;
  const second = context.refreshAirQuality(true, 'air');
  pending[1]({ ...data(), hours: 1 });
  await second;
  pending[0](data());
  await first;
  assert.equal(context.airState.history.air.data.hours, 1);
  assert.equal(context.airState.history.climate.hours, 6);
  assert.equal(context.airState.history.climate.data, null);
});
test('both charts start at six hours and share the initial network request', async () => {
  const { context } = setup();
  const requests = [];
  context.api = async url => { requests.push(url); return data(); };
  await context.refreshAirQuality();
  assert.deepEqual(requests, ['/api/air-quality?hours=6']);
  for (const history of Object.values(context.airState.history)) {
    assert.equal(history.hours, 6);
    assert.equal(history.data.hours, 6);
  }
});
test('different ranges refresh independently and use their own bucket sizes', async () => {
  const { context, $ } = setup();
  seed(context, data());
  context.airState.history.climate.hours = 168;
  const requests = [];
  context.api = async url => {
    requests.push(url);
    const hours = Number(url.split('=')[1]);
    const d = data();
    d.points.forEach(point => { point.temperature = 20; point.humidity = 40; });
    return { ...d, hours, bucket_seconds: hours === 168 ? 3600 : 60 };
  };
  await context.refreshAirQuality();
  assert.deepEqual(requests, ['/api/air-quality?hours=6', '/api/air-quality?hours=168']);
  assert.equal(context.airState.history.air.data.hours, 6);
  assert.equal(context.airState.history.climate.data.hours, 168);
  context.inspectAirPoint('air', 0);
  context.inspectAirPoint('climate', 0);
  assert.match($('air-reading-air').innerHTML, /1 min bucket/);
  assert.match($('air-reading-climate').innerHTML, /60 min bucket/);
});
test('a failed range change labels cached history and does not disrupt the other chart', async () => {
  const { context, $ } = setup();
  seed(context, data());
  context.airState.history.air.hours = 24;
  context.api = async () => { throw new Error('offline'); };
  await context.refreshAirQuality(true, 'air');
  assert.match($('air-load-air').textContent, /Could not load 24h.*Showing previous 6h/);
  assert.equal($('air-load-air').hidden, false);
  assert.equal(context.airState.history.air.data.hours, 6);
  assert.equal(context.airState.history.climate.error, false);
  assert.equal(context.airState.history.climate.hours, 6);
});

test('bucket choices adapt to the range and stay within bounded detail', () => {
  const { context } = setup();
  assert.equal(context.airBucketAllowed(6, 'auto'), true);
  assert.equal(context.airBucketAllowed(6, 60), true);
  assert.equal(context.airBucketAllowed(6, 86400), false);
  assert.equal(context.airBucketAllowed(168, 300), false);
  assert.equal(context.airBucketAllowed(720, 900), false);
  assert.equal(context.airBucketAllowed(720, 1800), true);
  assert.equal(context.airBucketAllowed(24, 60), true);
  assert.equal(context.airBucketAllowed(6, 123), false);
});
test('same ranges with different buckets produce independent requests and readouts', async () => {
  const { context, $ } = setup();
  const requests = [];
  context.airState.history.air.bucket = 300;
  context.airState.history.climate.bucket = 3600;
  context.api = async url => {
    requests.push(url);
    const params = new URL(url, 'http://localhost').searchParams;
    const d = data();
    d.points.forEach(point => { point.temperature = 20; point.humidity = 40; });
    return { ...d, hours: Number(params.get('hours')), bucket_seconds: Number(params.get('bucket')) };
  };
  await context.refreshAirQuality();
  assert.deepEqual(requests, ['/api/air-quality?hours=6&bucket=300', '/api/air-quality?hours=6&bucket=3600']);
  assert.equal(context.airState.history.air.data.bucket_seconds, 300);
  assert.equal(context.airState.history.climate.data.bucket_seconds, 3600);
  context.inspectAirPoint('air', 0);
  context.inspectAirPoint('climate', 0);
  assert.match($('air-reading-air').innerHTML, /5 min bucket/);
  assert.match($('air-reading-climate').innerHTML, /60 min bucket/);
});
test('a late bucket response cannot replace a newer bucket selection', async () => {
  const { context } = setup();
  const pending = [];
  context.api = () => new Promise(resolve => pending.push(resolve));
  context.airState.history.air.bucket = 60;
  const first = context.refreshAirQuality(true, 'air');
  context.airState.history.air.bucket = 300;
  const second = context.refreshAirQuality(true, 'air');
  pending[1]({ ...data(), bucket_seconds: 300 });
  await second;
  pending[0]({ ...data(), bucket_seconds: 60 });
  await first;
  assert.equal(context.airState.history.air.data.bucket_seconds, 300);
  assert.equal(context.airState.history.climate.bucket, 'auto');
});
test('a failed bucket change labels the bucket of cached data', async () => {
  const { context, $ } = setup();
  seed(context, { ...data(), bucket_seconds: 60 });
  context.airState.history.air.bucket = 300;
  context.api = async () => { throw new Error('offline'); };
  await context.refreshAirQuality(true, 'air');
  assert.match($('air-load-air').textContent, /with 5m buckets.*previous 6h history \(1m buckets\)/);
});

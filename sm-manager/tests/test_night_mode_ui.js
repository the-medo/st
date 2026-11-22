const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const source = readFileSync(require('node:path').join(__dirname, '../sm_manager/static/night-mode.js'), 'utf8');
function setup(fetcher) {
  const button = { disabled: true, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, fn) { this[k] = fn; } };
  const status = {};
  const context = {};
  vm.runInNewContext(source, context);
  return { button, status, ui: context.createNightMode(button, status, fetcher) };
}
const reply = (data, ok = true) => ({ ok, json: async () => data });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('night switch follows confirmed power and sends an explicit, authenticated action', async () => {
  const calls = [];
  let complete;
  const { ui, button, status } = setup(async (url, options) => {
    calls.push(options);
    return options.method ? new Promise(resolve => { complete = resolve; }) : reply({ available: true, night_mode: true, mode: 'gaming', token: 'token' });
  });
  await ui.refresh();
  assert.equal(button.attrs['aria-checked'], 'true');
  button.click();
  assert.equal(button.disabled, true);
  assert.equal(button.attrs['aria-checked'], 'true');
  await ui.refresh(); // Cannot race a poll against an in-flight write.
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers['X-SM-Token'], 'token');
  assert.deepEqual(JSON.parse(calls[1].body), { action: 'off' });
  complete(reply({ available: true, night_mode: false, mode: 'gaming', token: 'token' }));
  await tick();
  assert.equal(button.attrs['aria-checked'], 'false');
  assert.match(status.textContent, /Faceplate on/);
  assert.equal(button.disabled, false);
});

test('unavailable and failed controls show a reason and do not pretend the screen changed', async () => {
  let state = reply({ available: false, error: 'TV connected' });
  const { ui, button, status } = setup(async () => state);
  await ui.refresh();
  assert.equal(button.disabled, true);
  assert.equal(status.textContent, 'TV connected');
  state = reply({ available: true, night_mode: false, mode: 'desktop', token: 't' });
  await ui.refresh();
  state = reply({ error: 'Session changed' }, false);
  button.click();
  await tick();
  assert.equal(button.attrs['aria-checked'], 'false');
  assert.equal(button.disabled, true);
  assert.equal(status.textContent, 'Session changed');
});

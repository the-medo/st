import assert from 'node:assert/strict';
import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { fixtureApi, ui } from './v2-fixtures';

ui.ovis = true;
const fixture = Bun.spawn(['python3', 'tests/serve_completion_fixture.py'], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' });
fixture.stdin.write(JSON.stringify(Object.fromEntries(['ui-config', 'snapshot', 'history', 'zed', 'dbs'].map(name =>
  [`/api/${name}`, fixtureApi(new URL(`http://fixture/api/${name}`), 'GET')])) ) + '\n');
fixture.stdin.end();
const port = Number(new TextDecoder().decode((await fixture.stdout.getReader().read()).value).trim());
if (!port) throw new Error('Completion fixture did not start');
const base = `http://127.0.0.1:${port}`;
const demo = await Bun.build({ entrypoints: ['integrations/ovis/app/site/demo/transport.ts'], target: 'browser', format: 'iife',
  define: { __APP_VERSION__: JSON.stringify('0.5.9'), 'import.meta.env': '{}', 'import.meta.url': JSON.stringify(base + '/fixture.js') } });
if (!demo.success) throw new Error(demo.logs.map(String).join('\n'));
const setup = `const nativeFetch=window.fetch; ${await demo.outputs[0]!.text()}
const demoFetch=window.fetch,DemoSocket=window.WebSocket,DemoEvents=window.EventSource;
window.fetch=(input,init)=>{const url=new URL(input instanceof Request?input.url:input,location.href);
 if(!url.pathname.startsWith('/agents/api/')||url.pathname.startsWith('/agents/api/medo/'))return nativeFetch(input,init);
 url.pathname=url.pathname.slice(7);return demoFetch(url.href,init);};
window.WebSocket=function(url,protocols){const u=new URL(url,location.href);if(u.pathname==='/agents/ws')u.pathname='/ws';return new DemoSocket(u.href,protocols);};Object.setPrototypeOf(window.WebSocket,DemoSocket);
window.EventSource=function(url,options){const u=new URL(url,location.href);if(u.pathname.startsWith('/agents/api/'))u.pathname=u.pathname.slice(7);return new DemoEvents(u.href,options);};Object.setPrototypeOf(window.EventSource,DemoEvents);
window.badges=[];const recordBadge=n=>{window.badges.push(n);document.documentElement.dataset.fixtureBadge=String(n);};Object.defineProperty(navigator,'setAppBadge',{value:async n=>recordBadge(n)});Object.defineProperty(navigator,'clearAppBadge',{value:async()=>recordBadge(0)});
window.fixtureHidden=false;Object.defineProperty(document,'hidden',{get:()=>window.fixtureHidden});Object.defineProperty(document,'visibilityState',{get:()=>window.fixtureHidden?'hidden':'visible'});
localStorage.setItem('ovis:project-chat-activity:v1',JSON.stringify([['00000000-0000-4000-8000-000000000001',{updated:99999999,working:true,unread:true}]]));
`;
const cache = join(homedir(), '.cache/ms-playwright');
const folder = readdirSync(cache).filter(name => name.startsWith('chromium-')).sort().at(-1);
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE ??
  (folder ? [join(cache, folder, 'chrome-linux64/chrome'), join(cache, folder, 'chrome-linux/chrome')].find(existsSync) : undefined), args: ['--no-sandbox'] });
const firstId = '00000000-0000-4000-8000-000000000001';
const secondId = '00000000-0000-4000-8000-000000000002';
const evidence = process.env.ST_COMPLETION_EVIDENCE;
const errors: string[] = [];
try {
  const makeDevice = async () => {
    const context = await browser.newContext({ viewport: { width: 1500, height: 960 } });
    await context.addInitScript({ content: setup });
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    return page;
  };
  const one = await makeDevice(), two = await makeDevice();
  const change = async (data: unknown) => {
    const response = await one.request.post(base + '/fixture', { data });
    assert(response.ok(), await response.text());
  };
  const counts = async (page: Page, n: number) => {
    await page.locator(`.st-sidebar .nav-agents[aria-description="0 working, ${n} finished and unread, 0 need attention"]`).waitFor();
    await page.locator(`html[data-fixture-badge="${n}"]`).waitFor({ state: 'attached' });
  };
  await counts(one, 0); await counts(two, 0);
  await change({ metadata: { title: 'Fixture desk mount renamed', updated: 999999 } });
  await counts(one, 0); await counts(two, 0);
  await one.evaluate(() => { Reflect.set(window, 'fixtureHidden', true); document.dispatchEvent(new Event('visibilitychange')); });
  await change({ turn: 'completed-a', ordinal: 20 });
  await counts(one, 1); await counts(two, 1);
  // Selection is not a read: hold the history request until we prove the badge stays.
  await change({ hold: true });
  await two.goto(base + '/agents?saved=' + firstId);
  await counts(two, 1);
  await two.locator('.medo-chat.is-unread').waitFor();
  if (evidence) { mkdirSync(evidence, { recursive: true }); await two.screenshot({ path: join(evidence, 'unread.png') }); }
  await change({ hold: false, receiptFailure: true });
  await two.getByText('The synthetic fixture is complete. completed-a', { exact: true }).waitFor();
  await two.locator('[data-medo-read]').waitFor();
  await counts(two, 1); // a failed server write must not pretend the read was saved
  await change({ receiptFailure: false });
  await counts(two, 0); await counts(one, 0);
  await two.locator('.medo-chat.is-unread').waitFor({ state: 'hidden' });
  if (evidence) await two.screenshot({ path: join(evidence, 'read-on-both-devices.png') });
  await one.reload(); await counts(one, 0); // new browser memory, same server receipt
  await two.goto(base);
  await change({ turn: 'completed-b', ordinal: 30 });
  await change({ thread: secondId, turn: 'completed-camera', ordinal: 20 });
  await counts(one, 2); await counts(two, 2);
  // Delayed/offline acknowledgement of the prior turn cannot clear a new answer.
  const late = await one.request.post(base + '/agents/api/medo/read-completion', { data: { threadId: firstId, completionId: 'completed-a' } });
  assert.equal((await late.json()).activity.unread, true);
  await two.goto(base + '/agents?saved=' + firstId);
  await counts(two, 1); await counts(one, 1);
  await two.goto(base + '/agents?saved=' + secondId);
  await counts(two, 0); await counts(one, 0);
  assert.deepEqual(errors, []);
  console.log('Completion badges passed: two devices, minimized updates, real persisted receipts, stale reads, loaded-answer gating, write retries, and reloads.');
} finally {
  await browser.close();
  fixture.kill();
  await fixture.exited;
}

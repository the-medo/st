import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter, once } from 'node:events';
import { chromium, type Route } from 'playwright-core';
import type { MedoCatalog } from '../shared/medo.ts';
import { chromePath } from './chrome-path.ts';

// Synthetic data only. No daemon, terminals or user history are accessed.
const root = mkdtempSync(join(tmpdir(), 'ovis-medo-sidebar-'));
const evidence = process.env['UI_EVIDENCE_DIR'];
if (evidence) mkdirSync(evidence, { recursive: true });
const build = await Bun.build({ entrypoints: ['scripts/medo-sidebar-fixture.tsx'], outdir: root, target: 'browser',
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}', __APP_VERSION__: '"test"' } });
assert.ok(build.success, String(build.logs));
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/') return new Response('<!doctype html><html lang="en"><head><title>Sidebar regression fixture</title><link rel="stylesheet" href="/medo-sidebar-fixture.css"></head><body><div id="root"></div><script type="module" src="/medo-sidebar-fixture.js"></script></body></html>', { headers: { 'content-type': 'text/html' } });
  const file = Bun.file(join(root, path.slice(1)));
  return file.size ? new Response(file) : new Response('not found', { status: 404 });
} });
const browser = await chromium.launch({ executablePath: process.env['BROWSER_EXECUTABLE'] ?? chromePath(), headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const chat = (id: string, title: string) => ({ id, title, project: 'garden', cwd: '/fixture/garden', updated: 1, archived: false, unavailable: null, folder: null });
  let catalog: MedoCatalog = { projects: [{ id: 'garden', name: 'Garden', path: '/fixture/garden', folders: [] }],
    chats: [chat('a', 'Automation work'), chat('b', 'Sidebar work')], drafts: [{ address: 'draft', project: 'garden', title: 'New conversation' }], organizationRevision: 0 };
  const opens: Route[] = [], selects: Route[] = [], polls: Route[] = [], creates: Route[] = [], moves: Route[] = [];
  const arrivals = new EventEmitter();
  const hold = (list: Route[], route: Route) => { list.push(route); arrivals.emit('request'); };
  let holdPoll = false;
  await page.route('**/api/medo/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/catalog')) {
      if (holdPoll) { hold(polls, route); return; }
      await route.fulfill({ json: catalog }); return;
    }
    if (path.endsWith('/open')) { hold(opens, route); return; }
    if (path.endsWith('/new')) { hold(creates, route); return; }
    if (path.endsWith('/organize')) { hold(moves, route); return; }
    await route.fulfill({ json: {} });
  });
  await page.route('**/fixture/select?*', (route) => { hold(selects, route); });
  await page.goto(`http://127.0.0.1:${server.port}/`);
  const row = (name: string) => page.getByRole('button', { name, exact: true });
  await row('Automation work').waitFor();
  const waitCount = async (list: Route[], count: number) => {
    while (list.length < count) await once(arrivals, 'request', { signal: AbortSignal.timeout(10000) });
    assert.equal(list.length, count);
  };

  // A late response from the first click cannot steal the second selection.
  await row('Automation work').click();
  await waitCount(opens, 1);
  if (evidence) await page.screenshot({ path: join(evidence, 'opening.png') });
  assert.equal(await row('Automation work').textContent(), 'Automation work');
  assert.equal(await row('Automation work').getAttribute('aria-busy'), 'true');
  await opens.shift()!.fulfill({ json: { address: 'a', reused: true } });
  await waitCount(selects, 1);
  await row('Sidebar work').click();
  await waitCount(opens, 1);
  await opens.shift()!.fulfill({ json: { address: 'b', reused: true } });
  await waitCount(selects, 2);
  await selects[1]!.fulfill({ json: {} });
  await page.getByTestId('selected').filter({ hasText: /^b$/ }).waitFor();
  await selects[0]!.fulfill({ json: {} });
  selects.length = 0;
  await row('Automation work').waitFor({ state: 'visible' });
  assert.equal(await page.getByTestId('selected').textContent(), 'b');

  // A stale poll cannot suppress the read required after opening a chat.
  holdPoll = true;
  await row('Refresh projects').click();
  await waitCount(polls, 1);
  await row('Automation work').click();
  await waitCount(opens, 1);
  await opens.shift()!.fulfill({ json: { address: 'a', reused: true } });
  await waitCount(selects, 1);
  await selects.shift()!.fulfill({ json: {} });
  catalog = { ...catalog, chats: catalog.chats.map((value) => value.id === 'a' ? { ...value, title: 'Updated automation work', paneId: 'a' } : value) };
  holdPoll = false;
  await polls.shift()!.fulfill({ json: { ...catalog, chats: [] } });
  await row('Updated automation work').waitFor();
  assert.equal(await page.locator('.medo-chat.is-selected').innerText(), 'Updated automation work');

  // Drafts participate in navigation, search and active/archive filtering.
  await row('Updated automation work').click();
  await waitCount(opens, 1);
  await page.locator('.medo-project-chats').getByRole('button', { name: 'New conversation', exact: true }).click();
  await waitCount(selects, 1);
  await selects.shift()!.fulfill({ json: {} });
  await opens.shift()!.fulfill({ status: 400, json: { error: { message: 'Old selection failed' } } });
  await page.getByTestId('selected').filter({ hasText: 'draft' }).waitFor();
  assert.equal(await page.locator('[role="alert"]').count(), 0);
  assert.equal(await page.locator('.medo-chat.is-selected').innerText(), 'New conversation');
  await row('Active chats').click();
  assert.equal(await page.locator('.medo-project-chats .medo-chat-open').count(), 0);
  await row('Archived').click();
  await page.getByRole('textbox', { name: 'Search conversations' }).fill('Sidebar work');
  assert.equal(await page.locator('.medo-project-chats .medo-chat-open').count(), 1);
  await page.getByRole('textbox', { name: 'Search conversations' }).fill('New conversation');
  assert.equal(await page.locator('.medo-project-chats .medo-chat-open').count(), 1);
  await page.getByRole('textbox', { name: 'Search conversations' }).fill('');

  // Double clicks cannot create multiple empty chats, and a late create cannot
  // navigate away from a subsequently chosen existing conversation.
  await row('New conversation in Garden').dblclick();
  await waitCount(creates, 1);
  await row('Sidebar work').click();
  await waitCount(opens, 1);
  await opens.shift()!.fulfill({ json: { address: 'b', reused: true } });
  await waitCount(selects, 1);
  await selects.shift()!.fulfill({ json: {} });
  await creates.shift()!.fulfill({ json: { address: 'new', reused: false } });
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[aria-label="New conversation in Garden"]')?.disabled);
  assert.equal(await page.getByTestId('selected').textContent(), 'b');
  assert.equal(selects.length, 0);

  // Project order persists through fresh catalogues; stale polls cannot undo a move.
  catalog.projects.push({ id: 'studio', name: 'Studio', path: '/fixture/studio', folders: [] }, { id: 'home', name: 'Home', path: '/fixture/home', folders: [] });
  await row('Refresh projects').click();
  await row('Actions for project Home').waitFor();
  const names = () => page.locator('.medo-project-toggle>span:last-child').allTextContents();
  const menu = page.getByRole('menu', { name: 'Project actions', exact: true });
  await row('Actions for project Garden').click();
  assert.equal(await menu.getByRole('menuitem', { name: 'Move up', exact: true }).getAttribute('aria-disabled'), 'true');
  await page.keyboard.press('Escape');
  await row('Actions for project Home').click();
  assert.equal(await menu.getByRole('menuitem', { name: 'Move down', exact: true }).getAttribute('aria-disabled'), 'true');
  await page.keyboard.press('Escape');
  holdPoll = true;
  await row('Refresh projects').click();
  await waitCount(polls, 1);
  await row('Actions for project Garden').click();
  await menu.getByRole('menuitem', { name: 'Move down', exact: true }).click();
  await waitCount(moves, 1);
  const move = moves.shift()!;
  assert.deepEqual(move.request().postDataJSON(), { change: { operation: 'move-project', projectId: 'garden', relativeTo: 'studio', direction: 'down' } });
  const stale = structuredClone(catalog);
  catalog = { ...catalog, projects: [catalog.projects[1]!, catalog.projects[0]!, catalog.projects[2]!], organizationRevision: 1 };
  await move.fulfill({ json: { ok: true, revision: 1 } });
  holdPoll = false;
  await polls.shift()!.fulfill({ json: stale });
  await page.waitForFunction(() => document.querySelector('.medo-project-toggle>span:last-child')?.textContent === 'Studio');
  assert.deepEqual(await names(), ['Studio', 'Garden', 'Home']);
  await row('Actions for project Home').click();
  await menu.getByRole('menuitem', { name: 'Move up', exact: true }).click();
  await waitCount(moves, 1);
  await moves.shift()!.fulfill({ status: 400, json: { error: { message: 'Project order could not be saved' } } });
  await page.getByRole('alert').filter({ hasText: 'Project order could not be saved' }).waitFor();
  assert.deepEqual(await names(), ['Studio', 'Garden', 'Home']);
  await page.reload();
  await row('Actions for project Studio').waitFor();
  assert.deepEqual(await names(), ['Studio', 'Garden', 'Home']);
  assert.deepEqual(errors, []);
  if (evidence) await page.screenshot({ path: join(evidence, 'sidebar.png') });
  console.log('Sidebar browser regressions passed: stable titles, last selection wins, refresh after mutation, draft filters, single creation, project reordering and persistence.');
} finally {
  await browser.close();
  await server.stop(true);
  rmSync(root, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter, once } from 'node:events';
import { chromium, type Locator, type Route } from 'playwright-core';
import type { MedoCatalog } from '../shared/medo.ts';
import { chromePath } from './chrome-path.ts';
import { medoConversation } from '../server/medo.ts';
import { buildSnapshot } from '../server/herdr-core/snapshot.ts';
import { pushPaneTitle } from '../shared/notify-policy.ts';

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
  page.on('pageerror', (error) => { errors.push(error.message); console.error(error.message); });
  const chat = (id: string, title: string) => ({ id, title, project: 'garden', cwd: '/fixture/garden', updated: 1, archived: false, unavailable: null, folder: null });
  let catalog: MedoCatalog = { projects: [{ id: 'garden', name: 'Garden', path: '/fixture/garden', folders: [] }],
    chats: [chat('a', 'Automation work'), chat('b', 'Sidebar work')], drafts: [{ address: 'draft', project: 'garden', title: 'New conversation' }], organizationRevision: 0 };
  const opens: Route[] = [], selects: Route[] = [], polls: Route[] = [], creates: Route[] = [], moves: Route[] = [];
  const arrivals = new EventEmitter();
  const hold = (list: Route[], route: Route) => { list.push(route); arrivals.emit('request'); };
  let holdPoll = false;
  await page.route('**/api/medo/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/providers')) {
      await route.fulfill({ json: { providers: [
        { id: 'codex', label: 'Codex', installed: true, usageKey: 'codex:current', error: null, models: [
          { id: 'test-codex', label: 'Codex model', isDefault: true, defaultEffort: 'medium', efforts: ['low', 'medium', 'high'] },
          { id: 'test-fast', label: 'Fast model', defaultEffort: 'low', efforts: ['low', 'medium'] },
        ] },
        { id: 'claude', label: 'Claude', installed: true, usageKey: 'claude:current', error: null,
          models: ['opus', 'sonnet', 'haiku'].map((id) => ({ id, label: id[0]!.toUpperCase() + id.slice(1), defaultEffort: '', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] })) },
      ] } }); return;
    }
    if (path.endsWith('/catalog')) {
      if (holdPoll) { hold(polls, route); return; }
      await route.fulfill({ json: catalog }); return;
    }
    if (path.endsWith('/open')) { hold(opens, route); return; }
    if (path.endsWith('/new')) { hold(creates, route); return; }
    if (path.endsWith('/organize')) { hold(moves, route); return; }
    await route.fulfill({ json: {} });
  });
  let usage = { providers: [
    { id: 'codex', key: 'codex:other-account', windows: [{ kind: 'week', scope: null, used_percent: 99 }], problem: null },
    { id: 'codex', key: 'codex:current', windows: [{ kind: 'session', scope: null, used_percent: 95 }, { kind: 'week', scope: null, used_percent: 27 }], problem: null },
    { id: 'claude', key: 'claude:current', windows: [{ kind: 'week', scope: 'Sonnet', used_percent: 10 }, { kind: 'week', scope: null, used_percent: 59 }], problem: null },
  ] };
  await page.route('**/api/usage*', (route) => route.fulfill({ json: usage }));
  await page.route('**/fixture/select?*', (route) => { hold(selects, route); });
  await page.goto(`http://127.0.0.1:${server.port}/`);
  const row = (name: string) => page.getByRole('button', { name, exact: true });
  await row('Automation work').waitFor();
  const waitCount = async (list: Route[], count: number) => {
    const signal = AbortSignal.timeout(10000);
    while (list.length < count) await once(arrivals, 'request', { signal });
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

  // New conversations wait for the provider choice and send the first message exactly once.
  await row('New conversation in Garden').click();
  const dialog = page.getByRole('dialog', { name: 'New conversation', exact: true });
  await dialog.getByRole('radio', { name: 'Codex', exact: true }).waitFor();
  assert.equal(creates.length, 0);
  await dialog.getByText('73%', { exact: true }).waitFor();
  await dialog.getByText('41%', { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('radio', { name: 'Codex', exact: true }).getAttribute('aria-checked'), 'true');
  assert.equal(await dialog.getByRole('combobox', { name: 'Project', exact: true }).inputValue(), 'garden');
  await dialog.getByRole('textbox', { name: 'Message', exact: true }).fill('Help me plan the next release.');
  if (evidence) await page.screenshot({ path: join(evidence, 'new-conversation-codex-desktop.png') });
  await dialog.getByRole('radio', { name: 'Claude', exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Model', exact: true }).selectOption('opus');
  await dialog.getByRole('combobox', { name: 'Reasoning', exact: true }).selectOption('high');
  assert.equal(await dialog.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Help me plan the next release.');
  await dialog.getByRole('radio', { name: 'Codex', exact: true }).click();
  assert.equal(await dialog.getByRole('combobox', { name: 'Model', exact: true }).inputValue(), 'test-codex');
  await dialog.getByRole('combobox', { name: 'Model', exact: true }).selectOption('test-fast');
  assert.equal(await dialog.getByRole('combobox', { name: 'Reasoning', exact: true }).inputValue(), 'low');
  assert.equal(await dialog.getByRole('combobox', { name: 'Reasoning', exact: true }).locator('option[value="high"]').count(), 0);
  await dialog.getByRole('radio', { name: 'Claude', exact: true }).click();
  assert.equal(await dialog.getByRole('combobox', { name: 'Model', exact: true }).inputValue(), 'opus');
  assert.equal(await dialog.getByRole('combobox', { name: 'Reasoning', exact: true }).inputValue(), 'high');
  if (evidence) await page.screenshot({ path: join(evidence, 'new-conversation-claude-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  if (evidence) await page.screenshot({ path: join(evidence, 'new-conversation-mobile.png') });
  assert.equal(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth && element.getBoundingClientRect().left >= 0 && element.getBoundingClientRect().right <= window.innerWidth), true);
  await page.setViewportSize({ width: 1100, height: 720 });
  await dialog.getByRole('button', { name: 'Start conversation', exact: true }).dblclick();
  await waitCount(creates, 1);
  assert.deepEqual(creates[0]!.request().postDataJSON(), { projectId: 'garden', provider: 'claude', model: 'opus', effort: 'high', prompt: 'Help me plan the next release.' });
  await creates.shift()!.fulfill({ json: { address: 'new', reused: false, first_message: { id: 'queued-1' } } });
  await waitCount(selects, 1);
  await selects.shift()!.fulfill({ json: {} });
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[aria-label="New conversation in Garden"]')?.disabled);
  assert.equal(await page.getByTestId('selected').textContent(), 'new');
  assert.equal(selects.length, 0);
  // Every new window starts on Codex, including the global button. Missing usage is never 100%.
  usage = { providers: [] };
  await page.locator('.medo-sidebar-head').getByRole('button', { name: 'New conversation', exact: true }).click();
  await dialog.getByRole('radio', { name: 'Codex', exact: true }).waitFor();
  assert.equal(await dialog.getByRole('radio', { name: 'Codex', exact: true }).getAttribute('aria-checked'), 'true');
  await dialog.getByText('Usage unavailable', { exact: true }).first().waitFor();
  assert.equal(await dialog.getByText('100%', { exact: true }).count(), 0);
  await dialog.getByRole('radio', { name: 'Codex', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await dialog.getByRole('radio', { name: 'Claude', exact: true }).getAttribute('aria-checked'), 'true');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });

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

  // Folder expansion is opt-in, scoped to the project, and survives reloads.
  catalog.projects = catalog.projects.map((project) => ({ ...project, folders: project.id === 'garden'
    ? [{ id: 'ideas', name: 'Ideas' }, { id: 'later', name: 'Later' }]
    : project.id === 'studio' ? [{ id: 'ideas', name: 'Studio ideas' }] : [] }));
  catalog.chats.push({ ...chat('folder-chat', 'Folder conversation'), folder: 'ideas' });
  await row('Refresh projects').click();
  await row('Ideas').waitFor();
  assert.equal(await row('Ideas').getAttribute('aria-expanded'), 'false');
  assert.equal(await row('Folder conversation').count(), 0);
  await row('Ideas').click();
  await row('Folder conversation').waitFor();
  await page.reload();
  await row('Folder conversation').waitFor();
  assert.equal(await row('Ideas').getAttribute('aria-expanded'), 'true');
  assert.equal(await row('Later').getAttribute('aria-expanded'), 'false');
  assert.equal(await row('Studio ideas').getAttribute('aria-expanded'), 'false');

  // Project/folder chevrons, icons/status indicators and text share columns.
  const checkAlignment = async () => {
    const columns = await page.locator('[data-st-project="garden"]').evaluate((project) => {
      const rect = (selector: string) => project.querySelector(selector)!.getBoundingClientRect();
      const center = (selector: string) => { const box = rect(selector); return box.x + box.width / 2; };
      return {
        projectChevron: center('.medo-project-toggle>svg'), folderChevron: center('.medo-folder-head>svg'),
        folderIcon: center('.medo-folder-icon'),
        indicators: [...project.querySelectorAll('.medo-chat .medo-indicator')].map((element) => { const box = element.getBoundingClientRect(); return box.x + box.width / 2; }),
        title: rect('.medo-folder-head>span').x,
        chatTitles: [...project.querySelectorAll('.medo-chat-open>span:last-child')].map((element) => element.getBoundingClientRect().x),
      };
    });
    assert.ok(Math.abs(columns.projectChevron - columns.folderChevron) < 1, JSON.stringify(columns));
    assert.ok(columns.indicators.every((x) => Math.abs(x - columns.folderIcon) < 1), JSON.stringify(columns));
    assert.ok(columns.chatTitles.every((x) => Math.abs(x - columns.title) < 1), JSON.stringify(columns));
  };
  await checkAlignment();
  if (evidence) await page.screenshot({ path: join(evidence, 'folders-desktop.png') });
  await row('Ideas').click();
  await page.reload();
  await row('Ideas').waitFor();
  assert.equal(await row('Ideas').getAttribute('aria-expanded'), 'false');

  // Searching temporarily reveals results without overwriting saved expansion.
  await page.getByRole('textbox', { name: 'Search conversations' }).fill('Folder conversation');
  await row('Folder conversation').waitFor();
  await page.getByRole('textbox', { name: 'Search conversations' }).fill('');
  assert.equal(await row('Ideas').getAttribute('aria-expanded'), 'false');
  await row('Refresh projects').click();
  assert.equal(await row('Ideas').getAttribute('aria-expanded'), 'false');

  // A failed delete leaves the folder intact; success unwraps its conversations.
  await row('Actions for folder Ideas').click();
  const folderMenu = page.getByRole('menu', { name: 'Folder actions', exact: true });
  assert.equal(await row('Ideas').getAttribute('aria-expanded'), 'false');
  await folderMenu.getByRole('menuitem', { name: 'Delete folder Keep conversations', exact: true }).click();
  await waitCount(moves, 1);
  const failedDelete = moves.shift()!;
  assert.deepEqual(failedDelete.request().postDataJSON(), { change: { operation: 'delete', projectId: 'garden', folderId: 'ideas' } });
  await failedDelete.fulfill({ status: 400, json: { error: { message: 'Folder could not be deleted' } } });
  await page.getByRole('alert').filter({ hasText: 'Folder could not be deleted' }).waitFor();
  await row('Ideas').click();
  await page.setViewportSize({ width: 600, height: 800 });
  await checkAlignment();
  await row('Actions for folder Ideas').click();
  const folderSheet = page.getByRole('dialog', { name: 'Folder actions', exact: true });
  await folderSheet.waitFor();
  await folderSheet.evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
  });
  if (evidence) await page.screenshot({ path: join(evidence, 'folders-narrow-menu.png') });
  await folderSheet.getByRole('button', { name: 'Delete folder Keep conversations', exact: true }).click();
  await waitCount(moves, 1);
  catalog.projects = catalog.projects.map((project) => project.id === 'garden' ? { ...project, folders: project.folders.filter((folder) => folder.id !== 'ideas') } : project);
  catalog.chats = catalog.chats.map((item) => item.id === 'folder-chat' ? { ...item, folder: null } : item);
  await moves.shift()!.fulfill({ json: { ok: true } });
  await row('Ideas').waitFor({ state: 'hidden' });
  await row('Folder conversation').waitFor();
  assert.equal(await row('Studio ideas').getAttribute('aria-expanded'), 'false');
  await page.reload();
  await row('Folder conversation').waitFor();
  assert.equal(await row('Ideas').count(), 0);

  // Malformed or unavailable browser storage must not break the sidebar.
  await page.evaluate(() => localStorage.setItem('ovis:project-folders:v1', '{broken'));
  await page.reload();
  await row('Later').waitFor();
  assert.equal(await row('Later').getAttribute('aria-expanded'), 'false');
  await page.addInitScript(() => {
    if (!new URL(location.href).searchParams.has('storage-blocked')) return;
    Storage.prototype.getItem = () => { throw new DOMException('Storage unavailable', 'SecurityError'); };
    Storage.prototype.setItem = () => { throw new DOMException('Storage unavailable', 'SecurityError'); };
  });
  await page.goto(`http://127.0.0.1:${server.port}/?storage-blocked`);
  await row('Later').click();
  assert.equal(await row('Later').getAttribute('aria-expanded'), 'true');
  await row('Later').click();
  assert.equal(await row('Later').getAttribute('aria-expanded'), 'false');
  await page.setViewportSize({ width: 1100, height: 720 });

  await page.goto(`http://127.0.0.1:${server.port}/`);

  // A blocked question stays visible even when selected, then clears when work resumes.
  catalog = { ...catalog, chats: [{ ...chat('a', 'Archive defaults'), paneId: 'a', status: 'blocked' }] };
  const rawReply = '<send_user_message_question_reply>' + JSON.stringify([{ question: 'Which `GET /Files` default should we use?', answer: 'Make REST active-only by default too', questionItemId: '["request_user_input_async","call",0]' }]) + '</send_user_message_question_reply>';
  const adapted = medoConversation({ thread: { id: 'fixture' }, turns: [{ id: 'turn', items: [{ id: 'reply', role: 'user', text: rawReply }] }] });
  const part = adapted.turns[0]!.parts[0]!;
  const pane = buildSnapshot([{ address: 't1', cols: 120, rows: 40, cwd: '/fixture', state: 'live', title: '00000000-0000-4000-8000-000000000001', labels: { 'medo.ovis.project': 'garden', 'ovis.tab': 'Archive defaults' } }], null, '0.1.14').panes[0]!;
  await page.addInitScript((feedback) => Reflect.set(window, '__stFeedback', feedback), { reply: part.kind === 'text' ? part.text : '', title: pushPaneTitle(pane) });
  await page.reload();
  const attention = page.locator('.medo-chat-attention');
  await attention.getByText('Needs attention', { exact: true }).waitFor();
  await row('Archive defaults').click();
  await waitCount(opens, 1);
  await opens.shift()!.fulfill({ json: { address: 'a', reused: true } });
  await waitCount(selects, 1);
  await selects.shift()!.fulfill({ json: {} });
  await page.locator('.medo-chat.is-selected .medo-chat-attention').waitFor();
  assert.equal(await page.locator('.chat-bubble blockquote code').innerText(), 'GET /Files');
  assert.equal(await page.getByText('send_user_message_question_reply', { exact: false }).count(), 0);
  await row('Preview completion').click();
  await page.locator('.droplet').getByText('Archive defaults', { exact: true }).waitFor();
  await page.locator('.droplet').evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
  });
  if (evidence) await page.screenshot({ path: join(evidence, 'conversation-feedback.png') });
  await page.setViewportSize({ width: 720, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  if (evidence) await page.screenshot({ path: join(evidence, 'conversation-feedback-narrow.png') });
  catalog.chats[0]!.status = 'working';
  await row('Refresh projects').click();
  await attention.waitFor({ state: 'hidden' });
  await page.locator('.medo-chat .medo-spinner').waitFor();
  // Completion is explicit; a single footer toggle includes done chats everywhere.
  const sharedId = '11111111-2222-3333-4444-555555555555';
  catalog = { projects: [{ id: 'garden', name: 'Garden', path: '/fixture/garden', folders: [{ id: 'ideas', name: 'Ideas' }] }, { id: 'studio', name: 'Studio', path: '/fixture/studio', folders: [] }],
    chats: [
      { ...chat(sharedId, 'Automation work'), updated: 100 },
      ...Array.from({ length: 6 }, (_, i) => chat(`active-${i}`, `Active conversation ${i + 1}`)),
      ...Array.from({ length: 6 }, (_, i) => ({ ...chat(`done-${i}`, `Completed conversation ${i + 1}`), done: true })),
      { ...chat('folder-chat', 'Finished idea'), folder: 'ideas', done: true },
      { ...chat('studio-chat', 'Finished studio plan'), project: 'studio', done: true },
    ], organizationRevision: 0 };
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.reload();
  await row('Show more (2)').waitFor();
  assert.equal(await row('Completed conversation 1').count(), 0);
  const activeBox = (await row('Active chats').boundingBox())!;
  const doneBox = (await row('Show done').boundingBox())!;
  assert.equal(activeBox.y + activeBox.height / 2, doneBox.y + doneBox.height / 2, 'Show done sits beside Active chats');
  assert.equal(await page.locator('.medo-project-scroll .medo-show-done').count(), 0);
  assert.ok(Number.parseFloat(await row('Show more (2)').evaluate((el) => getComputedStyle(el).fontSize)) < Number.parseFloat(await row('Automation work').evaluate((el) => getComputedStyle(el).fontSize)));
  await row('Automation work').hover();
  const check = row('Mark as done: Automation work');
  assert.equal(await check.evaluate((el) => getComputedStyle(el).opacity), '1');
  if (evidence) await page.screenshot({ path: join(evidence, 'conversation-actions.png') });
  // A refused save leaves the conversation active and explains the failure.
  await check.click();
  await waitCount(moves, 1);
  await moves.shift()!.fulfill({ status: 400, json: { error: { message: 'Completion could not be saved' } } });
  await page.getByRole('alert').filter({ hasText: 'Completion could not be saved' }).waitFor();
  await row('Automation work').waitFor();
  holdPoll = true;
  await row('Refresh projects').click();
  await waitCount(polls, 1);
  await check.focus();
  await page.keyboard.press('Enter');
  await waitCount(moves, 1);
  assert.equal(await check.isDisabled(), true);
  const beforeDone = structuredClone(catalog);
  const completion = moves.shift()!;
  assert.deepEqual(completion.request().postDataJSON(), { change: { operation: 'set-done', projectId: 'garden', threadId: sharedId, done: true } });
  catalog.chats[0]!.done = true;
  await completion.fulfill({ json: { ok: true } });
  holdPoll = false;
  await polls.shift()!.fulfill({ json: beforeDone });
  await row('Automation work').waitFor({ state: 'hidden' });
  assert.equal(await row('Ideas').getAttribute('aria-expanded'), 'false');
  await row('Show done').click();
  await row('Automation work').waitFor();
  await row('Finished studio plan').waitFor();
  assert.equal(await row('Finished idea').count(), 0, 'Global toggle leaves closed folders closed');
  await row('Ideas').click();
  await row('Finished idea').waitFor();
  assert.equal(await row('Mark as active: Automation work').getAttribute('aria-pressed'), 'true');
  assert.equal(await row('Completed conversation 6').count(), 0);
  await row('Show more (8)').click();
  await row('Show more (3)').click();
  await row('Completed conversation 6').waitFor();
  await row('Active conversation 6').waitFor();
  await row('Hide done').click();
  assert.equal(await row('Automation work').count(), 0);
  assert.equal(await row('Finished idea').count(), 0);
  assert.equal(await row('Finished studio plan').count(), 0);
  await row('Show done').click();
  await row('Finished idea').waitFor();
  await page.reload();
  await row('Show done').waitFor();
  assert.equal(await row('Automation work').count(), 0);
  await page.getByRole('textbox', { name: 'Search conversations' }).fill('Automation');
  await row('Show done').click();
  await row('Automation work').waitFor();
  // Copy both stable reference formats and report a denied clipboard honestly.
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { Reflect.set(window, '__copied', value); } } }));
  await row('Actions for Automation work').click();
  if (evidence) await page.screenshot({ path: join(evidence, 'conversation-menu.png') });
  await page.getByRole('menuitem', { name: 'Copy conversation link', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Conversation link copied' }).waitFor();
  assert.equal(await page.evaluate(() => Reflect.get(window, '__copied')), `http://127.0.0.1:${server.port}/?saved=${sharedId}`);
  await row('Actions for Automation work').click();
  await page.getByRole('menuitem', { name: 'Copy conversation ID', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Conversation ID copied' }).waitFor();
  assert.equal(await page.evaluate(() => Reflect.get(window, '__copied')), sharedId);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Denied'); } } });
    document.execCommand = () => false;
  });
  await row('Actions for Automation work').click();
  await page.getByRole('menuitem', { name: 'Copy conversation ID', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Could not copy' }).waitFor();
  assert.equal(await page.getByRole('status').filter({ hasText: 'copied' }).count(), 0);
  await row('Mark as active: Automation work').click();
  await waitCount(moves, 1);
  const reopen = moves.shift()!;
  assert.equal(reopen.request().postDataJSON().change.done, false);
  catalog.chats[0]!.done = false;
  await reopen.fulfill({ json: { ok: true } });
  await row('Mark as done: Automation work').waitFor();
  // Folders stay on either side of the unfiled list, with persisted menu and drag moves.
  catalog = { ...catalog, projects: [
    { id: 'garden', name: 'Garden', path: '/fixture/garden', folders: [{ id: 'first', name: 'Priority', position: 'start' }, { id: 'ideas', name: 'Ideas' }, { id: 'later', name: 'Later' }] },
    { id: 'studio', name: 'Studio', path: '/fixture/studio', folders: [{ id: 'studio-folder', name: 'Studio folder' }] },
  ], chats: [chat(sharedId, 'Automation work'), { ...chat('filed', 'Filed conversation'), folder: 'ideas' }] };
  await page.reload();
  const garden = page.locator('[data-st-project="garden"]');
  const folderRow = (id: string) => garden.locator(`[data-folder-id="${id}"] .medo-folder-row`);
  const structure = () => garden.locator('.medo-project-chats > .medo-folder, .medo-project-chats > .medo-unfiled').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-folder-id') ?? 'conversations'));
  await row('Automation work').waitFor();
  assert.deepEqual(await structure(), ['first', 'conversations', 'ideas', 'later']);
  await row('Actions for folder Later').click();
  await page.getByRole('menuitemcheckbox', { name: 'Place before conversations', exact: true }).click();
  await waitCount(moves, 1);
  const placeBefore = moves.shift()!;
  assert.deepEqual(placeBefore.request().postDataJSON().change, { operation: 'move-folder', projectId: 'garden', folderId: 'later', position: 'start' });
  assert.deepEqual(await structure(), ['first', 'conversations', 'ideas', 'later'], 'Wait for a confirmed save');
  catalog.projects[0]!.folders = [{ id: 'later', name: 'Later', position: 'start' }, { id: 'first', name: 'Priority', position: 'start' }, { id: 'ideas', name: 'Ideas' }];
  await placeBefore.fulfill({ json: { ok: true } });
  await page.waitForFunction(() => document.querySelector('[data-st-project="garden"] .medo-project-chats')?.firstElementChild?.getAttribute('data-folder-id') === 'later');
  await page.reload();
  await row('Actions for folder Later').waitFor();
  assert.deepEqual(await structure(), ['later', 'first', 'conversations', 'ideas']);
  const beginDrag = async (source: Locator) => {
    await source.scrollIntoViewIfNeeded();
    const from = (await source.boundingBox())!;
    await page.mouse.move(from.x + 65, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 80, from.y + from.height / 2 + 8, { steps: 5 });
    await page.locator('.medo-projects[data-dragging]').waitFor();
  };
  const dragOnto = async (source: Locator, target: Locator, edge: 'up' | 'down' | 'inside' = 'inside') => {
    await beginDrag(source);
    const to = (await target.boundingBox())!;
    await page.mouse.move(to.x + 65, to.y + (edge === 'up' ? 2 : edge === 'down' ? to.height - 2 : to.height / 2), { steps: 8 });
    await page.mouse.up();
  };
  await dragOnto(folderRow('later'), folderRow('first'), 'down');
  await waitCount(moves, 1);
  const reordered = moves.shift()!;
  assert.deepEqual(reordered.request().postDataJSON().change, { operation: 'move-folder', projectId: 'garden', folderId: 'later', relativeTo: 'first', direction: 'down' });
  catalog.projects[0]!.folders = [catalog.projects[0]!.folders[1]!, catalog.projects[0]!.folders[0]!, catalog.projects[0]!.folders[2]!];
  await reordered.fulfill({ json: { ok: true } });
  await page.waitForFunction(() => document.querySelector('[data-st-project="garden"] .medo-project-chats')?.firstElementChild?.getAttribute('data-folder-id') === 'first');
  // Boundary targets exist only during a folder drag; no target splits the conversation rows.
  const dragToBoundary = async (source: Locator, position: 'start' | 'end') => {
    await beginDrag(source);
    const target = garden.locator(`.medo-folder-drop-zone[data-folder-position="${position}"]`);
    await target.waitFor();
    const to = (await target.boundingBox())!;
    await page.mouse.move(to.x + 65, to.y + to.height / 2, { steps: 8 });
    await page.mouse.up();
  };
  await dragToBoundary(folderRow('first'), 'end');
  await waitCount(moves, 1);
  const failedMove = moves.shift()!;
  assert.deepEqual(failedMove.request().postDataJSON().change, { operation: 'move-folder', projectId: 'garden', folderId: 'first', position: 'end' });
  await failedMove.fulfill({ status: 400, json: { error: { message: 'Folder move could not be saved' } } });
  await page.getByRole('alert').filter({ hasText: 'Folder move could not be saved' }).waitFor();
  assert.deepEqual(await structure(), ['first', 'later', 'conversations', 'ideas']);
  await dragToBoundary(folderRow('first'), 'end');
  await waitCount(moves, 1);
  catalog.projects[0]!.folders = [{ id: 'later', name: 'Later', position: 'start' }, { id: 'ideas', name: 'Ideas' }, { id: 'first', name: 'Priority', position: 'end' }];
  await moves.shift()!.fulfill({ json: { ok: true } });
  await page.waitForFunction(() => document.querySelector('[data-st-project="garden"] .medo-project-chats')?.lastElementChild?.getAttribute('data-folder-id') === 'first');
  assert.deepEqual(await structure(), ['later', 'conversations', 'ideas', 'first']);
  // Dropping a chat onto a closed folder files it and opens the destination.
  await row('Ideas').click();
  assert.equal(await row('Filed conversation').count(), 0);
  await dragOnto(row('Automation work'), folderRow('ideas'));
  await waitCount(moves, 1);
  const filed = moves.shift()!;
  assert.deepEqual(filed.request().postDataJSON().change, { operation: 'move', projectId: 'garden', threadId: sharedId, folderId: 'ideas' });
  catalog.chats[0]!.folder = 'ideas';
  await filed.fulfill({ json: { ok: true } });
  await garden.locator('[data-folder-id="ideas"]').getByRole('button', { name: 'Automation work', exact: true }).waitFor();
  await row('Filed conversation').waitFor();
  if (evidence) await page.screenshot({ path: join(evidence, 'folder-order.png') });
  // Cross-project and same-folder drops do nothing; dropping onto the project unfiles it.
  await dragOnto(row('Automation work'), folderRow('ideas'));
  await dragOnto(row('Automation work'), page.locator('[data-folder-id="studio-folder"] .medo-folder-row'));
  await dragOnto(folderRow('later'), page.locator('[data-folder-id="studio-folder"] .medo-folder-row'));
  assert.equal(moves.length, 0);
  assert.equal(opens.length, 0, 'Dragging never opens or resumes a conversation');
  assert.equal(selects.length, 0);
  await dragOnto(row('Automation work'), garden.locator('.medo-project-head'));
  await waitCount(moves, 1);
  const unfiled = moves.shift()!;
  assert.equal(unfiled.request().postDataJSON().change.folderId, null);
  catalog.chats[0]!.folder = null;
  await unfiled.fulfill({ json: { ok: true } });
  await garden.locator('.medo-unfiled').getByRole('button', { name: 'Automation work', exact: true }).waitFor();
  await page.reload();
  await row('Actions for folder Later').waitFor();
  assert.deepEqual(await structure(), ['later', 'conversations', 'ideas', 'first']);
  await row('Actions for folder Priority').click();
  if (evidence) await page.screenshot({ path: join(evidence, 'folder-menu.png') });
  await page.getByRole('menuitem', { name: 'Move up', exact: true }).click();
  await waitCount(moves, 1);
  assert.deepEqual(moves[0]!.request().postDataJSON().change, { operation: 'move-folder', projectId: 'garden', folderId: 'first', relativeTo: 'ideas', direction: 'up' });
  catalog.projects[0]!.folders = [catalog.projects[0]!.folders[0]!, catalog.projects[0]!.folders[2]!, catalog.projects[0]!.folders[1]!];
  await moves.shift()!.fulfill({ json: { ok: true } });
  // The folder + opens the provider composer with its destination, then creates once.
  await row('Ideas').click();
  const folderPlus = row('New conversation in folder Ideas');
  await folderPlus.click();
  await dialog.waitFor();
  assert.equal(await dialog.getByRole('combobox', { name: 'Conversation folder', exact: true }).inputValue(), 'ideas');
  assert.equal(await dialog.getByRole('radio', { name: 'Codex', exact: true }).getAttribute('aria-checked'), 'true');
  await dialog.getByRole('button', { name: 'Start conversation', exact: true }).dblclick();
  await waitCount(creates, 1);
  const folderCreate = creates.shift()!;
  assert.deepEqual(folderCreate.request().postDataJSON(), { projectId: 'garden', folderId: 'ideas', provider: 'codex', model: 'test-codex', effort: 'medium' });
  catalog.drafts = [{ address: 'folder-draft', project: 'garden', folder: 'ideas', title: 'New conversation' }];
  await folderCreate.fulfill({ json: { address: 'folder-draft', reused: false } });
  await waitCount(selects, 1);
  await selects.shift()!.fulfill({ json: {} });
  await garden.locator('[data-folder-id="ideas"]').getByRole('button', { name: 'New conversation', exact: true }).waitFor();
  assert.equal(await row('Ideas').getAttribute('aria-expanded'), 'true');
  assert.equal(await garden.locator('.medo-unfiled').getByRole('button', { name: 'New conversation', exact: true }).count(), 0);
  await page.reload();
  await garden.locator('[data-folder-id="ideas"]').getByRole('button', { name: 'New conversation', exact: true }).waitFor();
  await folderPlus.hover();
  if (evidence) await page.screenshot({ path: join(evidence, 'folder-new-conversation.png') });
  // Touch devices expose the checkmark without a hover, with no horizontal overflow.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mobile = await phone.newPage();
  await mobile.route('**/api/medo/catalog', (route) => route.fulfill({ json: catalog }));
  await mobile.goto(`http://127.0.0.1:${server.port}/`);
  await mobile.getByRole('button', { name: 'Mark as done: Automation work' }).waitFor();
  assert.equal(await mobile.locator('.medo-done-action').first().evaluate((el) => getComputedStyle(el).opacity), '1');
  if (evidence) await mobile.screenshot({ path: join(evidence, 'conversation-actions-touch.png') });
  await phone.close();
  assert.deepEqual(errors, []);
  console.log('Sidebar browser regressions passed: navigation, folder expansion/alignment/deletion, project/folder ordering, native folder and conversation dragging, global done filtering, persistence/errors, pagination, copy links/IDs and touch actions.');
} finally {
  await browser.close();
  await server.stop(true);
  rmSync(root, { recursive: true, force: true });
}

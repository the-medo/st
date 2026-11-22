// Run against a private branch preview with DAVE_CHECKOUT and ST_PREVIEW_URL.
// Only the uniquely named test task/event are created and removed.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const checkout = process.env.DAVE_CHECKOUT;
const base = process.env.ST_PREVIEW_URL;
if (!checkout || !base) throw new Error('Set DAVE_CHECKOUT and ST_PREVIEW_URL');
const { chromium, expect } = await import(pathToFileURL(path.join(checkout, 'node_modules/@playwright/test/index.mjs')).href);
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Europe/Budapest' });
const page = await context.newPage();
const planner = page.frameLocator('#planner-frame');
const errors = [];
const loginRequests = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' && /Content Security Policy/i.test(message.text())) errors.push(message.text());
});
page.on('request', (request) => { if (request.url().includes('/auth/login')) loginRequests.push(request.url()); });
const name = `ST browser check ${Date.now()}`;
const row = (title) => planner.locator('[data-uid]').filter({ has: planner.getByText(title, { exact: true }) }).first();
let taskUid;
let eventId;
async function cleanup() {
  const session = await context.request.get(base + '/planner/api/st-session');
  if (!session.ok()) return;
  const { token } = await session.json();
  const headers = { 'X-ST-Planner-Token': token };
  if (taskUid) {
    const response = await context.request.get(base + '/planner/api/tasks/' + encodeURIComponent(taskUid));
    if (response.ok()) {
      const task = await response.json();
      await context.request.delete(base + '/planner/api/tasks/' + encodeURIComponent(taskUid) + '?etag=' + encodeURIComponent(task.etag), { headers });
    }
  }
  if (eventId) {
    const { id, etag, calendarId } = eventId;
    await context.request.delete(base + '/planner/api/events/' + encodeURIComponent(id) + '?etag=' + encodeURIComponent(etag) + '&calendarId=' + encodeURIComponent(calendarId), { headers });
  }
}

try {
  await page.goto(base + '/');
  await page.getByRole('link', { name: 'Tasks', exact: true }).click();
  await expect(page).toHaveURL(base + '/planner/tasks');
  await expect(planner.getByRole('button', { name: 'New task', exact: true })).toBeVisible();
  await expect(planner.getByRole('navigation', { name: 'Planner navigation' })).toBeVisible();
  await expect(page.locator('nav a[data-view="projects"]')).toBeHidden();
  await expect(planner.getByTitle('Sign out')).toHaveCount(0);
  await expect(planner.getByLabel('Username', { exact: true })).toHaveCount(0);
  // A draft survives a round trip through the console without either document
  // reloading. No new document or script should be requested on a warm switch.
  const mainOrigin = await page.evaluate(() => performance.timeOrigin);
  const frameOrigin = await planner.locator('body').evaluate(() => performance.timeOrigin);
  const scripts = [];
  page.on('request', (r) => { if (['document', 'script'].includes(r.resourceType())) scripts.push(r.url()); });
  await planner.getByRole('button', { name: 'New task', exact: true }).click();
  await planner.getByPlaceholder('Task title').fill('Unsaved draft survives navigation');
  await page.goBack();
  await expect(page.locator('nav a[data-view="projects"]')).toBeVisible();
  await page.getByRole('link', { name: 'Tasks', exact: true }).click();
  await expect(planner.getByPlaceholder('Task title')).toHaveValue('Unsaved draft survives navigation');
  assert.equal(await page.evaluate(() => performance.timeOrigin), mainOrigin);
  assert.equal(await planner.locator('body').evaluate(() => performance.timeOrigin), frameOrigin);
  assert.deepEqual(scripts, []);
  await planner.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.reload();
  await expect(planner.getByRole('button', { name: 'New task', exact: true })).toBeVisible();

  await planner.getByRole('button', { name: 'New task', exact: true }).click();
  await planner.getByPlaceholder('Task title').fill(name);
  const created = page.waitForResponse((r) => r.url().endsWith('/planner/api/tasks') && r.request().method() === 'POST');
  await planner.getByRole('button', { name: 'Create task', exact: true }).click();
  const taskResponse = await created;
  assert.equal(taskResponse.status(), 201);
  taskUid = (await taskResponse.json()).uid;
  await expect(row(name)).toBeVisible();
  // An edit through the shared API while ST is visible must appear on resume,
  // even though the planner's normal query stale time has not elapsed.
  await planner.getByRole('link', { name: 'ST home', exact: true }).click();
  const { token: updateToken } = await (await context.request.get(base + '/planner/api/st-session')).json();
  const taskUrl = base + '/planner/api/tasks/' + encodeURIComponent(taskUid);
  const task = await (await context.request.get(taskUrl)).json();
  const updated = await context.request.put(taskUrl, {
    headers: { 'X-ST-Planner-Token': updateToken },
    data: { etag: task.etag, data: { ...task.data, summary: name + ' external' } },
  });
  assert.equal(updated.status(), 200);
  await page.getByRole('link', { name: 'Tasks', exact: true }).click();
  await expect(row(name + ' external')).toBeVisible();
  await page.reload();
  await expect(row(name + ' external')).toBeVisible();
  await row(name + ' external').click();
  await planner.getByLabel('Edit task', { exact: true }).click();
  await planner.getByPlaceholder('Task title').fill(name + ' edited');
  await planner.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row(name + ' edited')).toBeVisible();
  await row(name + ' edited').getByLabel('Mark complete', { exact: true }).click();
  await expect(row(name + ' edited')).not.toBeVisible();
  await page.reload();
  await planner.getByRole('button', { name: /Show \d+ completed/ }).click();
  await row(name + ' edited').click();
  await planner.getByLabel('Delete task', { exact: true }).click();
  await planner.getByRole('button', { name: 'Delete', exact: true }).last().click();
  await expect(row(name + ' edited')).not.toBeVisible();
  taskUid = null;

  const eventsLoaded = page.waitForResponse((r) => /\/planner\/api\/calendars\/[^/]+\/events\?/.test(r.url()) && r.status() === 200);
  await planner.getByRole('link', { name: 'Calendar', exact: true }).click();
  await expect(page).toHaveURL(base + '/planner/calendar');
  await expect(planner.locator('.fc-view-harness')).toBeVisible();
  await eventsLoaded;
  await expect(planner.getByRole('button', { name: 'New calendar', exact: true })).toBeVisible();
  await expect(planner.getByRole('checkbox').first()).toBeVisible();
  await page.keyboard.press('n');
  await planner.getByPlaceholder('Event title').fill(name);
  const eventCreated = page.waitForResponse((r) => /\/planner\/api\/calendars\/[^/]+\/events$/.test(r.url()) && r.request().method() === 'POST');
  await planner.getByRole('button', { name: 'Create', exact: true }).click();
  const eventResponse = await eventCreated;
  assert.equal(eventResponse.status(), 201);
  eventId = await eventResponse.json();
  await expect(planner.locator('.fc-event-title').filter({ hasText: name }).first()).toBeVisible();
  await planner.locator('.fc-event-title').filter({ hasText: name }).first().click();
  await planner.getByTitle('Delete event', { exact: true }).click();
  await planner.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(planner.locator('.fc-event-title').filter({ hasText: name })).toHaveCount(0);
  eventId = null;

  await planner.getByRole('link', { name: 'ST home', exact: true }).click();
  await expect(page).toHaveURL(base + '/');
  await expect(page.locator('nav a[data-view="projects"]')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(base + '/planner/calendar');
  await expect(planner.locator('.fc-view-harness')).toBeVisible();
  await page.reload();
  await expect(planner.locator('.fc-view-harness')).toBeVisible();

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await mobile.newPage();
  const mobilePlanner = phone.frameLocator('#planner-frame');
  await phone.goto(base + '/planner/tasks');
  await expect(mobilePlanner.getByRole('button', { name: 'New task', exact: true })).toBeVisible();
  await expect(mobilePlanner.getByRole('banner').getByRole('link', { name: 'ST home', exact: true })).toBeInViewport();
  await mobilePlanner.getByRole('button', { name: 'Open menu', exact: true }).click();
  await expect(mobilePlanner.getByRole('link', { name: 'ST home', exact: true }).first()).toBeInViewport();
  await mobilePlanner.getByRole('link', { name: 'ST home', exact: true }).first().click();
  await expect(phone).toHaveURL(base + '/');
  await phone.getByRole('link', { name: 'Calendar', exact: true }).click();
  await expect(phone).toHaveURL(base + '/planner/calendar');
  await expect(mobilePlanner.locator('.fc-view-harness')).toBeVisible();
  if (process.env.ST_SCREENSHOTS) {
    await mkdir(process.env.ST_SCREENSHOTS, { recursive: true });
    await phone.waitForLoadState('networkidle');
    await phone.screenshot({ path: path.join(process.env.ST_SCREENSHOTS, 'st-mobile-calendar.png'), fullPage: true });
  }
  await mobilePlanner.getByRole('banner').getByRole('link', { name: 'ST home', exact: true }).click();
  await expect(phone).toHaveURL(base + '/');
  await mobile.close();

  assert.equal(loginRequests.length, 0, 'Browser must never log into DAVe');
  assert.equal((await context.cookies()).filter((c) => c.name === 'dave_session').length, 0);
  assert.deepEqual(errors, []);
  const source = await context.request.get(base + '/planner/source.tar.gz');
  assert.equal(source.status(), 200);
  assert.equal(source.headers()['content-type'], 'application/gzip');
  if (process.env.ST_SCREENSHOTS) {
    await mkdir(process.env.ST_SCREENSHOTS, { recursive: true });
    await page.goto(base + '/planner/tasks');
    await expect(planner.getByRole('button', { name: 'New task', exact: true })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: path.join(process.env.ST_SCREENSHOTS, 'st-tasks.png'), fullPage: true });
    await page.goto(base + '/planner/calendar');
    await expect(planner.locator('.fc-view-harness')).toBeVisible();
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: path.join(process.env.ST_SCREENSHOTS, 'st-calendar.png'), fullPage: true });
  }
  console.log('PASS: no-login Tasks/Calendar, task CRUD, event CRUD, shared edits on resume, persistent drafts/no warm downloads, reload/history, ST home, mobile and source download');
} catch (error) {
  if (process.env.ST_SCREENSHOTS) {
    await mkdir(process.env.ST_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.ST_SCREENSHOTS, 'st-error.png'), fullPage: true });
  }
  throw error;
} finally {
  await cleanup();
  await browser.close();
}

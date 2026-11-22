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
const errors = [];
const loginRequests = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' && /Content Security Policy/i.test(message.text())) errors.push(message.text());
});
page.on('request', (request) => { if (request.url().includes('/auth/login')) loginRequests.push(request.url()); });
const name = `ST browser check ${Date.now()}`;
const row = (title) => page.locator('[data-uid]').filter({ has: page.getByText(title, { exact: true }) }).first();
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
  await expect(page.getByRole('button', { name: 'New task', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Planner navigation' })).toBeVisible();
  await expect(page.locator('nav a[data-view="projects"]')).toHaveCount(0);
  await expect(page.getByTitle('Sign out')).toHaveCount(0);
  await expect(page.getByLabel('Username', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'New task', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await page.getByPlaceholder('Task title').fill(name);
  const created = page.waitForResponse((r) => r.url().endsWith('/planner/api/tasks') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  const taskResponse = await created;
  assert.equal(taskResponse.status(), 201);
  taskUid = (await taskResponse.json()).uid;
  await expect(row(name)).toBeVisible();
  await page.reload();
  await expect(row(name)).toBeVisible();
  await row(name).click();
  await page.getByLabel('Edit task', { exact: true }).click();
  await page.getByPlaceholder('Task title').fill(name + ' edited');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row(name + ' edited')).toBeVisible();
  await row(name + ' edited').getByLabel('Mark complete', { exact: true }).click();
  await expect(row(name + ' edited')).not.toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /Show \d+ completed/ }).click();
  await row(name + ' edited').click();
  await page.getByLabel('Delete task', { exact: true }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
  await expect(row(name + ' edited')).not.toBeVisible();
  taskUid = null;

  const eventsLoaded = page.waitForResponse((r) => /\/planner\/api\/calendars\/[^/]+\/events\?/.test(r.url()) && r.status() === 200);
  await page.getByRole('link', { name: 'Calendar', exact: true }).click();
  await expect(page).toHaveURL(base + '/planner/calendar');
  await expect(page.locator('.fc-view-harness')).toBeVisible();
  await eventsLoaded;
  await expect(page.getByRole('button', { name: 'New calendar', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox').first()).toBeVisible();
  await page.keyboard.press('n');
  await page.getByPlaceholder('Event title').fill(name);
  const eventCreated = page.waitForResponse((r) => /\/planner\/api\/calendars\/[^/]+\/events$/.test(r.url()) && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const eventResponse = await eventCreated;
  assert.equal(eventResponse.status(), 201);
  eventId = await eventResponse.json();
  await expect(page.locator('.fc-event-title').filter({ hasText: name }).first()).toBeVisible();
  await page.locator('.fc-event-title').filter({ hasText: name }).first().click();
  await page.getByTitle('Delete event', { exact: true }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('.fc-event-title').filter({ hasText: name })).toHaveCount(0);
  eventId = null;

  await page.getByRole('link', { name: 'ST home', exact: true }).click();
  await expect(page).toHaveURL(base + '/');
  await expect(page.locator('nav a[data-view="projects"]')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(base + '/planner/calendar');
  await expect(page.locator('.fc-view-harness')).toBeVisible();
  await page.reload();
  await expect(page.locator('.fc-view-harness')).toBeVisible();

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await mobile.newPage();
  await phone.goto(base + '/planner/tasks');
  await expect(phone.getByRole('button', { name: 'New task', exact: true })).toBeVisible();
  await expect(phone.getByRole('banner').getByRole('link', { name: 'ST home', exact: true })).toBeInViewport();
  await phone.getByRole('button', { name: 'Open menu', exact: true }).click();
  await expect(phone.getByRole('link', { name: 'ST home', exact: true }).first()).toBeInViewport();
  await phone.getByRole('link', { name: 'ST home', exact: true }).first().click();
  await expect(phone).toHaveURL(base + '/');
  await phone.getByRole('link', { name: 'Calendar', exact: true }).click();
  await expect(phone).toHaveURL(base + '/planner/calendar');
  await expect(phone.locator('.fc-view-harness')).toBeVisible();
  if (process.env.ST_SCREENSHOTS) {
    await mkdir(process.env.ST_SCREENSHOTS, { recursive: true });
    await phone.waitForLoadState('networkidle');
    await phone.screenshot({ path: path.join(process.env.ST_SCREENSHOTS, 'st-mobile-calendar.png'), fullPage: true });
  }
  await phone.getByRole('banner').getByRole('link', { name: 'ST home', exact: true }).click();
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
    await expect(page.getByRole('button', { name: 'New task', exact: true })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: path.join(process.env.ST_SCREENSHOTS, 'st-tasks.png'), fullPage: true });
    await page.goto(base + '/planner/calendar');
    await expect(page.locator('.fc-view-harness')).toBeVisible();
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: path.join(process.env.ST_SCREENSHOTS, 'st-calendar.png'), fullPage: true });
  }
  console.log('PASS: no-login Tasks/Calendar, task CRUD, event CRUD, reload/history, ST home, mobile and source download');
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

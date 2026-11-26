/** Synthetic UI acceptance. No live devices, Codex history or household actions. */
import { chromium } from "playwright-core";
import { existsSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { fixtureApi } from "./v2-fixtures";
const root = resolve("sm_manager/web");
const entry = resolve(`frontend/src/.assistant-preview-${process.pid}.tsx`);
writeFileSync(
  entry,
  `import React from 'react';import {createRoot} from 'react-dom/client';import {MedoAssistant} from '../../integrations/ovis/app/src/components/MedoAssistant';createRoot(document.getElementById('root')!).render(<MedoAssistant id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" disabled={false} onChange={()=>{}}/>);`,
);
let bundle: string;
try {
  const build = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  assert(build.success, JSON.stringify(build.logs));
  bundle = await build.outputs[0]!.text();
} finally {
  unlinkSync(entry);
}
const pc = {
  device: "pc",
  seen: Date.now() / 1000,
  revision: 0,
  settings: {} as Record<string, unknown>,
  report: {
    state: "idle",
    muted: false,
    queue: 0,
    revision: 0,
    inputs: ["Desk microphone", "Headset"],
    outputs: ["Speakers"],
    test_recording: null as null | object,
  },
};
const sent: any[] = [];
let conversation = {
  id: "job-1",
  thread: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  status: "completed",
  device: "room",
  events: [] as any[],
};
let failNext = false;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/assistant") {
      if (request.method === "POST") {
        assert.equal(request.headers.get("X-SM-Token"), "fixture-token");
        const body = await request.json();
        sent.push(body);
        if (body.action === "settings") {
          Object.assign(pc.settings, body.settings);
          pc.revision++;
          pc.report.revision++;
          if (typeof body.settings.muted === "boolean")
            pc.report.muted = body.settings.muted;
        }
        if (body.action === "test_recording")
          pc.report.test_recording = {
            id: body.id,
            status: "completed",
            text: "Synthetic microphone test.",
          };
        return Response.json({ ok: true });
      }
      return Response.json({
        available: true,
        worker_online: true,
        token: "fixture-token",
        now: Date.now() / 1000,
        router: { status: "classified" },
        devices: [{ ...pc, seen: Date.now() / 1000 }],
        commands: [],
        requests: [{id:"fixture",device:"room",text:"Synthetic previous request",status:"completed",thread:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",updated:Date.now()/1000}],
      });
    }
    if (url.pathname === "/api/medo/assistant") {
      if (request.method === "POST") {
        const body = await request.json();
        sent.push(body);
        if (failNext) {
          failNext = false;
          conversation = { ...conversation, id: "job-2", status: "completed" };
          return Response.json(
            { error: { message: "Reply lost; retry your message" } },
            { status: 502 },
          );
        }
        conversation = {
          ...conversation,
          status: body.action === "stop" ? "cancelled" : "running",
        };
        return Response.json({ ok: true });
      }
      return Response.json(conversation);
    }
    if (url.pathname === "/composer")
      return new Response(
        '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/composer.js"></script></body></html>',
        { headers: { "Content-Type": "text/html" } },
      );
    if (url.pathname === "/composer.js")
      return new Response(bundle, {
        headers: { "Content-Type": "text/javascript" },
      });
    if (url.pathname.startsWith("/api/"))
      return Response.json(fixtureApi(url, request.method));
    const file = Bun.file(resolve(root, "." + url.pathname));
    return new Response(
      (await file.exists()) ? file : Bun.file(join(root, "index.html")),
    );
  },
});
const cache = join(homedir(), ".cache/ms-playwright");
const folder = readdirSync(cache)
  .filter((n) => n.startsWith("chromium-"))
  .sort()
  .at(-1)!;
const executablePath =
  process.env.BROWSER_EXECUTABLE ??
  ["chrome-linux64/chrome", "chrome-linux/chrome"]
    .map((p) => join(cache, folder, p))
    .find(existsSync);
const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1360, height: 1100 },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.port}/assistant`);
  await page
    .getByRole("heading", { name: "Voice assistant", exact: true })
    .waitFor();
  assert.equal(await page.getByRole("link", {name:"Open conversation"}).getAttribute("href"), "/agents?saved=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  const windows = page
    .locator("section")
    .filter({
      has: page.getByRole("heading", { name: "Windows PC", exact: true }),
    });
  const room = page
    .locator("section")
    .filter({
      has: page.getByRole("heading", { name: "Steam Machine", exact: true }),
    });
  assert(
    await room.getByRole("button", { name: "Dictate a request" }).isDisabled(),
  );
  await page.screenshot({
    path: "/tmp/st-assistant-settings-before.png",
    fullPage: true,
  });
  console.log("audio settings");
  await windows
    .getByLabel("Microphone", { exact: true })
    .selectOption("Headset");
  await windows.getByRole("button", { name: "Save audio devices" }).click();
  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll("button")).some(
        (b) => b.textContent === "Save audio devices" && b.disabled,
      ),
  );
  assert.equal(sent.at(-1).settings.microphone, "Headset");
  console.log("microphone test");
  await windows
    .getByRole("button", { name: "Test microphone", exact: true })
    .click();
  await windows.getByText("Synthetic microphone test.").waitFor();
  assert.equal(sent.at(-1).action, "test_recording");
  console.log("mute");
  await windows.getByRole("button", { name: "Mute", exact: true }).click();
  await windows.getByRole("button", { name: "Unmute", exact: true }).waitFor();
  assert(
    await windows
      .getByRole("button", { name: "Dictate a request" })
      .isDisabled(),
  );
  await windows.getByRole("button", { name: "Unmute", exact: true }).click();
  await windows.getByRole("button", { name: "Dictate a request" }).click();
  await windows.getByRole("button", { name: "Stop", exact: true }).click();
  assert(
    sent.some((v) => v.action === "record") &&
      sent.some((v) => v.action === "stop"),
  );
  await page.screenshot({
    path: "/tmp/st-assistant-settings.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  console.log("Herdr composer");
  await page.goto(`http://127.0.0.1:${server.port}/composer`);
  await page.getByRole("button", { name: "Send follow-up" }).waitFor();
  await page
    .getByLabel("Continue this conversation")
    .fill("Move that to tomorrow.");
  failNext = true;
  await page.getByRole("button", { name: "Send follow-up" }).click();
  await page.getByRole("alert").waitFor();
  const nonce = sent.at(-1).nonce;
  await page.getByText("completed · replies stay with room").waitFor();
  await page.waitForTimeout(1600);
  await page.getByRole("button", { name: "Send follow-up" }).click();
  await page.getByRole("button", { name: "Stop request" }).waitFor();
  assert.equal(
    sent.at(-1).nonce,
    nonce,
    "Lost reply retries retain the same nonce after job changes",
  );
  conversation = {
    ...conversation,
    status: "waiting",
    events: [{ kind: "question", seq: 10, text: "Which day?" }],
  };
  await page.getByLabel("Your answer").fill("Friday");
  await page.getByRole("button", { name: "Answer", exact: true }).click();
  assert.equal(sent.at(-1).question, 10);
  assert.equal(sent.at(-1).text, "Friday");
  await page.getByRole("button", { name: "Stop request" }).click();
  assert.equal(sent.at(-1).job, "job-2");
  assert.deepEqual(errors, []);
  console.log(
    "Assistant settings, device actions, responsive layout, Herdr retry/answer/stop: passed",
  );
} finally {
  await browser.close();
  server.stop(true);
}

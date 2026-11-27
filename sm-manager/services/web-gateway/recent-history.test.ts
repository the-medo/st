import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecentHistory } from "./recent-history";
import { createGateway } from "./gateway";
import type { RecentTarget } from "../../packages/recent-conversations";

const target: RecentTarget = { machineId: "local", paneId: "w1:p1", view: "chat", title: "Garden plan", workspace: "Garden" };

test("visits persist across restarts, merge independent writers, and retain a bounded server order", () => {
  const directory = mkdtempSync(join(tmpdir(), "st-recents-"));
  const path = join(directory, "history.sqlite");
  try {
    const first = new RecentHistory(path), second = new RecentHistory(path);
    first.visit(target);
    second.visit({ ...target, paneId: "w1:p2" });
    first.visit({ ...target, threadId: "thread-1" });
    second.visit({ ...target, paneId: "new:pane", threadId: "thread-1" });
    expect(first.list().map((item) => item.paneId)).toEqual(["new:pane", "w1:p2"]);
    second.visit({ ...target, paneId: "new:pane", threadId: "thread-1", view: "terminal" });
    first.close(); second.close();
    const restarted = new RecentHistory(path);
    expect(restarted.list().map((item) => item.view)).toEqual(["terminal", "chat", "chat"]);
    for (let i = 0; i < 40; i++) restarted.visit({ ...target, paneId: `pane-${i}` });
    expect(restarted.list()).toHaveLength(30);
    expect(restarted.list()[0]?.paneId).toBe("pane-39");
    restarted.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("history API shares visits, validates targets and enforces owner/origin boundaries", async () => {
  const gateway = createGateway({ port: 0, publicOrigin: "https://st.example.test", monitorOrigin: "http://127.0.0.1:1", ovisOrigin: "http://127.0.0.1:1", ownerLogin: "owner@example.test" });
  const url = `http://127.0.0.1:${gateway.port}/api/recent-conversations`;
  const post = (body: unknown, headers = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    expect(await (await fetch(url)).json()).toEqual({ items: [] });
    await Promise.all([post(target), post({ ...target, paneId: "w1:p2" })]);
    const response = await fetch(url);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json() as { items: RecentTarget[] }).items).toHaveLength(2);
    expect((await post(target, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(target, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await fetch(url, { headers: { host: "st.example.test", "tailscale-user-login": "another@example.test" } })).status).toBe(403);
    expect((await post(target, { host: "st.example.test" })).status).toBe(403);
    expect((await fetch(url, { headers: { host: "st.example.test", "tailscale-user-login": "owner@example.test" } })).status).toBe(200);
    for (const invalid of [null, [], { items: [target] }, { ...target, view: "invalid" }, { ...target, machineId: "" }, { ...target, threadId: 12 }, { ...target, title: "x".repeat(4097) }])
      expect((await post(invalid)).status).toBe(400);
    expect((await post({ ...target, title: "x".repeat(40_000) })).status).toBe(413);
    expect((await post(target, { "content-type": "text/plain" })).status).toBe(400);
    expect((await fetch(url, { method: "DELETE" })).status).toBe(405);
    expect((await (await fetch(url)).json() as { items: RecentTarget[] }).items).toHaveLength(2);
  } finally { gateway.stop(true); }
});

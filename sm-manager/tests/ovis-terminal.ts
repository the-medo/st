/** Opt-in real PTY check. Every file, daemon socket and terminal belongs to this test. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createGateway } from "../services/web-gateway/gateway";
const hc = process.env.ST_OVIS_HC_BIN;
if (!hc) throw new Error("Set ST_OVIS_HC_BIN to the installed hc executable");
const cache = join(homedir(), ".cache/st-v2-terminal-tests");
mkdirSync(cache, { recursive: true });
const dir = mkdtempSync(join(cache, "session-"));
mkdirSync(join(dir, "run"), { mode: 0o700 });
const reserve = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response("reserved"),
});
const port = reserve.port;
reserve.stop(true);
const env = {
  ...process.env,
  HOME: dir,
  CODEX_HOME: join(dir, "codex"),
  XDG_RUNTIME_DIR: join(dir, "run"),
  XDG_CONFIG_HOME: join(dir, "config"),
  XDG_STATE_HOME: join(dir, "state"),
  HC_SESSION: `st-v2-${process.pid}`,
  HC_SOCKET: join(dir, "core.sock"),
  OVIS_STATE_DIR: join(dir, "ovis"),
  OVIS_RUNTIME: "herdr-core",
  OVIS_HC_BIN: hc,
  MEDO_PROJECTS: "0",
  PORT: String(port),
  HOST: "127.0.0.1",
  ST_OVIS_COOKIE_PREFIX: "st_terminal_fixture",
  ST_OVIS_BASE_PATH: "/ovis",
};
// The inherited environment must not redirect either side into an existing session.
for (const key of [
  "HERDR_SOCKET",
  "OVIS_HC_ENV",
  "OVIS_HC_MACHINE",
  "OVIS_HC_MACHINE_ID",
  "OVIS_TOKEN",
  "OVIS_TAILSCALE_OWNER",
])
  (env as Record<string, string | undefined>)[key] = undefined;
async function core(...args: string[]) {
  const p = Bun.spawn([hc!, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [code, out, error] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  if (code) throw new Error(error);
  return JSON.parse(out || "{}");
}
let pane: string | undefined;
let child: ReturnType<typeof Bun.spawn> | undefined,
  gateway: ReturnType<typeof createGateway> | undefined,
  ws: WebSocket | undefined;
try {
  const terminal = await core(
    "run",
    "--bg",
    "--no-parent",
    "--json",
    "--name",
    "st-v2-transport-fixture",
    "--cwd",
    dir,
    "--",
    "/usr/bin/python3",
    "-u",
    "-c",
    'import sys; print("fixture-ready");\nfor line in sys.stdin: print("echo:" + line.strip(), flush=True)',
  );
  pane = terminal.address;
  assert.match(pane!, /^t[0-9a-z]+$/);
  child = Bun.spawn([process.execPath, resolve("services/ovis/index.ts")], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const until = Date.now() + 30000;
  let ready = false;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await Bun.sleep(100);
  }
  if (!ready) throw new Error("Isolated Ovis did not become healthy");
  gateway = createGateway({
    port: 0,
    publicOrigin: "https://fixture.invalid",
    monitorOrigin: `http://127.0.0.1:${port}`,
    ovisOrigin: `http://127.0.0.1:${port}`,
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("PTY echo did not arrive through the gateway")),
      15000,
    );
    let sent = false,
      output = "";
    ws = new WebSocket(`ws://127.0.0.1:${gateway!.port}/ovis/ws`, {
      headers: { Origin: `http://127.0.0.1:${gateway!.port}` },
    });
    ws.onopen = () =>
      ws!.send(
        JSON.stringify({ type: "attach", pane_id: pane, cols: 80, rows: 24 }),
      );
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Gateway WebSocket failed"));
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data);
      if (message.type === "input-ready" && message.ready !== false && !sent) {
        sent = true;
        ws!.send(
          JSON.stringify({
            type: "input",
            pane_id: pane,
            text: "st-v2-gateway-proof\r",
          }),
        );
      }
      if (message.type === "pty-data") {
        output += message.data;
        if (output.includes("echo:st-v2-gateway-proof")) {
          clearTimeout(timer);
          resolve();
        }
      }
      if (message.type === "error") {
        clearTimeout(timer);
        reject(new Error(JSON.stringify(message)));
      }
    };
  });
  ws.close();
  gateway.stop(true);
  gateway = undefined;
  child.kill();
  await child.exited;
  child = undefined;
  const after = await core("ls", "--json");
  assert(
    after.terminals.some(
      (t: { address: string; state: string }) =>
        t.address === pane && t.state === "live",
    ),
    "Stopping the web services must preserve the terminal",
  );
  console.log(
    "Isolated Herdr PTY passed: attach, send, streamed echo, and terminal survival after web-service shutdown.",
  );
} finally {
  ws?.close();
  gateway?.stop(true);
  if (child) {
    child.kill();
    await child.exited;
  }
  try {
    if (pane) await core("kill", pane).catch(() => {});
    await core("server", "stop");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

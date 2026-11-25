/** S.T. owns deployment. This entry has no upstream updater or runtime installer. */
process.env["ST_OVIS_BASE_PATH"] = "/agents";
const { createServer } = await import(
  "../../integrations/ovis/app/server/index"
);
const { startRuntime } = await import(
  "../../integrations/ovis/app/server/herdr-core/runtime"
);
const stateDir = process.env["OVIS_STATE_DIR"];
const port = Number(process.env["PORT"]);
if (!stateDir || !Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Supply a private OVIS_STATE_DIR and unprivileged PORT");
const adapter = await startRuntime(stateDir);
const instance = createServer({
  stateDir,
  port,
  hostname: "127.0.0.1",
  tailscaleServeOnly: true,
  registerBridge: false,
});
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    instance.stop();
    adapter?.stop();
    process.exit(0);
  });
console.log(`S.T. Agents bridge listening on loopback:${instance.port}`);

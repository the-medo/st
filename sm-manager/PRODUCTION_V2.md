# Production v2 deployment

Run commands from `sm-manager`. Production runs remote `main` in its independent
runtime clone. Development worktrees and the preview never become production's
working directory. Keep all configuration and artifacts below outside Git.

## First activation

1. Run the release checks: frozen Bun install, typecheck, unit tests, build,
   console and Ovis browser acceptance, Python monitor and Ovis bridge tests,
   legacy UI tests, and the isolated real Herdr terminal check when `hc` is available.
   The browser suite requires Chromium and OpenSSL.
2. Pause `sm-manager-update.timer` before merging if the installed updater predates
   the React build support. Merge the validated branch into remote `main`.
3. Put the pinned Bun and Node executables on `PATH`. Use the updated source helper
   to stage and validate main before advancing the owned runtime:

   ```sh
   python3 scripts/updater.py update --directory /absolute/private/deployment
   ```

   Read `deployment_dir` from the saved SM Manager configuration. Never manually
   edit, reset, switch or clean the runtime checkout. Its `web/release.json` must
   identify the merged revision. This step still serves the previous UI profile.
4. Activate v2 with the existing private Herdr environment file and two unused
   loopback ports (by default the public port plus one and two):

   ```sh
   python3 scripts/manage.py install-v2 \
     --bun /absolute/path/to/bun \
     --ovis-env-file /absolute/private/ovis-service.env \
     --monitor-port 8791 --ovis-port 8792
   ```

   Optionally add `--state-source /absolute/private/preview/ovis` on first activation
   to copy saved JSON preferences. Sockets, locks, logs and Herdr runtime sessions
   are never copied. Existing production Agents state is retained on reinstall.

The installer backs up existing configuration, generated units, CLI and installed
updater under the existing private data directory. It retains the monitor's history
directory and public URL. It installs the new updater and enables its five-minute
timer. Startup or health-check failure restores the prior web configuration.

## Owned services and ingress

`sm-manager.service` is the gateway on the existing public loopback port.
`sm-manager-monitor.service` and `sm-manager-ovis.service` serve its private
upstreams. `sm-manager-prepare.service` prepares the release before any of them
start. Restart/update controls these web services together. Herdr, managed Codex,
DAVe, the existing TLS proxy, unrelated routes and preview services remain external.

The existing Tailscale HTTPS Serve route supplies verified owner identity. When
the main URL uses a custom-domain TCP/TLS proxy that cannot carry that identity,
opening ST briefly redirects through the existing Tailscale URL. A one-use code
bound to a secure nonce cookie returns to ST and creates a signed, HttpOnly owner
session lasting 30 days. API and WebSocket requests require this session. Another
tailnet user or a forged identity header on the custom domain is rejected.

Private files in the configuration directory's `v2` folder hold the session signing
secret and internal Agents credential, with mode 0600. The credential is supplied
to Agents through an environment file and injected by the authorized gateway; it
is never sent to the browser. Reinstall preserves the signing secret, so sessions
survive service restarts. Invalidate all sessions by replacing that private secret
and restarting the gateway. No Serve reset, Funnel or TLS route changes are needed.

## Verification and rollback

Verify all three service states, the update timer, `/api/health`, `/api/snapshot`,
`/api/gateway-health`, `/agents/api/health?scope=bridge`, and `web/release.json`.
Through the saved public URL, check the first owner sign-in, Overview, Air quality,
Planner and Agents bootstrap. Avoid sending messages, creating terminals or opening
live conversations for a deployment smoke test. Use synthetic data for screenshots.

Subsequent releases use `python3 scripts/manage.py update`: source, built assets and
dependencies move together, and an unhealthy release restores its predecessor.
When the installer/updater itself changes, rerun `install --auto-update` from the
updated source; it recognizes the saved v2 profile.

To undo initial v2 activation, run:

```sh
python3 scripts/manage.py rollback-v2
```

This restores the prior web configuration and units from the saved private backup,
including the installed updater. It retains history, Agents state and shared chat
data. It does not rewind source; source rollback belongs to the main-branch release
workflow. Verify the restored service and timer after rollback.

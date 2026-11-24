# SM Manager

## Scope and architecture

This is a local Linux resource monitor with optional faceplate power control. Keep it lightweight: Python
standard library backend and SQLite 30-day history. The v2 console uses React 19,
TypeScript and Vite with the pinned Bun workspace. The legacy UI remains available
during migration. All commands below run from `sm-manager`.

Build v2 with `bun install --frozen-lockfile`, `bun run typecheck`, and
`bun run build`. Use `frontend: "react"` in a private preview configuration.
Never restart production to preview branch work. Imported Ovis source lives in
`integrations/ovis`; preserve its notices, dependency patches and session safety.

- `sm_manager/discovery.py`: Git/Codex discovery and container ownership.
- `sm_manager/metrics.py`: `/proc`, Docker GET requests, and private app URLs.
- `sm_manager/collector.py`: resource attribution and cleanup briefs.
- `sm_manager/history.py`: bounded persistent samples.
- `sm_manager/server.py`: loopback API and explicit static asset allowlist.
- `sm_manager/night_mode.py`: paired faceplate control through a private session helper.
- `scripts/manage.py`: owned systemd service and optional Tailscale Serve route.
- `scripts/updater.py`: installed main-branch updater and isolated runtime clone.

## Run and verify

Use `python3 scripts/manage.py status` to inspect the existing instance. After
changes, run appropriate tests (`python3 -m unittest discover -s tests -v`) and
restart with `python3 scripts/manage.py restart`. Leave the app running.
Read the saved access profile at `~/.config/sm-manager/config.json` for the exact
private browser URL. Do not hardcode a host, username, or machine path in source.
Verify `/api/health`, `/api/snapshot`, and the browser through that URL.

With `install --auto-update`, the service runs remote `main` from the independent
`<deployment_dir>/checkout/sm-manager`, not a development worktree. It checks for updates
before startup and every five minutes. Do not edit or remove that runtime clone.
After merging this project's branch, run `python3 scripts/manage.py update` and
verify the service before cleaning up the merged development branch/worktree.
If that script is unavailable, use `systemctl --user start sm-manager-update.service`.
Changes to the updater or generated units require rerunning
`python3 scripts/manage.py install --auto-update` from the updated source.
Update tests must use temporary Git repositories and mock all service controls.

For production v2 activation and rollback, follow [PRODUCTION_V2.md](PRODUCTION_V2.md).
The gateway retains the public port; monitor and Agents use private loopback ports.
The updater controls these three web services together, never shared Herdr/Codex.
Custom-domain owner sign-in uses the existing Tailscale HTTPS identity route; keep
that route and the existing TLS proxy intact. Private signing keys, backend tokens,
environment files, configuration backups and Agents state stay outside Git.

Never bind the app to all interfaces, enable Funnel, reset Serve, overwrite
another application's route, or publish collected machine data. Runtime
configuration, screenshots of real projects, and databases stay out of Git.

## Extending cleanup

The current interface generates a plan only. A user request to clean up another
project should first read a fresh snapshot and that worktree's plan, follow the
target repository's own instructions, and verify PID start times, directories,
and container labels. Prefer its documented lifecycle tooling. Preserve volumes
and source/worktrees unless the user specifically authorizes their deletion.
Never infer destructive ownership from a container name or a stale PID alone.

Keep Docker process usage out of host-process totals. Test attribution,
PID reuse, history retention, and access boundaries when changing them. No tests
should stop live host services or touch the user's real Codex database.

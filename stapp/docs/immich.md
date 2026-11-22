# Immich with S.T.

The Steam Machine runs Immich server, machine learning, Valkey and PostgreSQL.
The NAS stores the media library; the Steam Machine SSD stores PostgreSQL and
the model cache. Tailscale Serve provides private HTTPS on a dedicated port.
Both the Steam Machine and NAS must be awake for normal operation.

## First connection from a PC

1. Install/connect Tailscale on the PC using an account with access to the
   Steam Machine. No exit node or router port forwarding is needed.
2. On the Steam Machine, run `stctl photos status`. Open its `url` in your
   PC browser. Use the full HTTPS URL, including `:2283` when using the default
   installation. Bookmark it.
3. Sign in with the initial admin account. The installer stores its email and
   generated password only in `~/.config/stapp/immich-initial-login.json` on
   the Steam Machine. Retrieve it over your existing owner SSH connection or
   open it locally; it is not the password for Tailscale or the NAS.
4. Change the password under account settings. Store the new one in your
   password manager, then delete the initial-login file on the Steam Machine.
5. Complete Immich's first-use setup if shown. Start with a few disposable
   photos using the web **Upload** control. Wait for thumbnails/indexing and
   verify you can open and download an original.

The web app supports browsing, uploads, search, albums and administration.
It does not automatically watch a Windows folder. For large folder imports,
use the [official Immich CLI](https://docs.immich.app/features/command-line-interface/)
with a separate upload key, or plan a dedicated import. S.T.'s key cannot upload.
Google Takeout archives need an importer that understands their metadata;
dragging an entire archive into the browser is not that workflow.

## Android phone

1. Install [Tailscale](https://tailscale.com/download) and connect it. In the
   phone browser, first verify the same private Immich URL opens.
2. Install the official [Immich Android app](https://get.immich.app/android).
   Use a version compatible with the server; this deployment pins **v3.4.2**.
3. Enter the same HTTPS server URL, including the port. Do not append `/api`
   in the mobile app. Sign in to your own Immich account.
4. Grant access to the photos/videos you want backed up. Open backup settings,
   select **Camera** (and any other desired albums), and enable automatic and
   background backup. Leave cellular uploading off for the first large upload.
5. Allow background activity for Immich and Tailscale in Android's battery
   settings. If uploads pause, set their battery usage to unrestricted.
6. Take a test photo and start a backup. Verify it appears in the PC browser.
   Then test with Wi-Fi off and Tailscale connected: browsing should work;
   uploads over mobile data require enabling cellular backup explicitly.

For the first big upload, keep the phone charging, on Wi-Fi, with Immich open.
Subsequent background uploads are scheduled by Android and may be delayed.

## iPhone

1. Install/connect Tailscale and verify the private URL in Safari.
2. Install the official [Immich iOS app](https://get.immich.app/ios), enter the
   same server URL and sign in with the iPhone owner's separate account.
3. Grant photo access, select the albums to back up and enable backup. Allow
   **Background App Refresh** for Immich in iOS Settings.
4. Leave Tailscale connected. Its [VPN On Demand settings](https://tailscale.com/docs/features/client/ios-vpn-on-demand)
   can automate connection on Wi-Fi/cellular networks.
5. Test one photo, verify it from a PC, then let the initial upload finish
   while charging with Immich open. Open Immich periodically afterward;
   iOS decides when background work runs.

iCloud originals may need downloading to the iPhone temporarily before Immich
uploads them. Allow enough local space and time. Another active VPN may prevent
Tailscale from connecting. See [Immich mobile backup behavior](https://docs.immich.app/features/mobile-backup/).

## Two people and shared albums

Use **Administration → Users → Create user** for the second person. Each
person signs into their own account on their phone and selects their own
backup albums. This keeps libraries separate. Create a shared album for
selected photos, or opt into partner sharing if you want broad sharing.

Tailscale access and Immich accounts are separate. If your partner uses their
own Tailscale account, share the Steam Machine with them in Tailscale and
configure access to the Immich TCP port only. Check the effective policy:
sharing a machine alone should not be treated as proof that other ports are
blocked. S.T. does not alter tailnet ACLs or send invitations. See
[device sharing](https://tailscale.com/docs/features/sharing) and
[Immich partner sharing](https://docs.immich.app/features/partner-sharing/).
Private album links also require access to this server through Tailscale.

## S.T. CLI and assistant

Run these as the Steam Machine owner, locally or through a normal owner SSH
session. They return JSON with browser links and asset IDs:

```sh
stctl photos status
stctl photos albums
stctl photos recent --limit 10
stctl photos recent --page 2
stctl photos search "IMG_1234"
stctl photos search "a dog on the beach" --semantic --limit 10
stctl photos show ASSET_UUID
stctl show home
```

Filename search works after upload; semantic search needs completed machine
learning indexing. `show` puts a JPEG preview on the shared living-room panel.
The preview remains in S.T.'s private cache and saved views, including after
the original is deleted from Immich. It is not the full-resolution original.
Locked, hidden and trashed assets are refused. Use Immich for playback of videos.

The assistant exposes `photos_status`, `photos_albums`, `photos_recent`,
`photos_search` and `photos_show`. Ask “Find my beach photos” or “Show that
photo on the living-room screen.” Paired PC/room bridges may invoke these via
an active assistant request; they cannot run unbound raw photo-tool calls.
Keep using `stctl ask` over a paired bridge, or use an owner SSH session for
direct `stctl photos` commands. Device identity remains enforced by the bridge.

S.T. uses **one explicitly configured Immich account**. It can see that
account's photos and accessible shared content, not another user's private
library. Its key has only `asset.read`, `asset.view`, `album.read`, `user.read`.
S.T. cannot delete originals, upload photos, change sharing or manage users.
Keys never appear in CLI responses, browser links or panel requests.

## Reproducing the installation

Run from `stapp/`. Docker with the Compose plugin, Python 3, Tailscale Serve,
a systemd user manager and an already-configured NAS mount are required.
The supplied compose file is based on the official **v3.4.2** release file,
with loopback-only publishing, a unique project name and systemd supervision.
PostgreSQL/Valkey images retain the upstream digests. CPU machine learning
is enabled; no GPU acceleration is assumed.

```sh
python3 deploy/immich/manage.py install --mount /absolute/path/to/mounted-media-share
python3 deploy/immich/manage.py status
# After the server becomes healthy:
python3 deploy/immich/setup-account.py --email owner@example.com --name Owner

(cd apps/kiosk && npm ci && npm run build)
scripts/cargo build --release --locked
python3 tests/photos.py
python3 tests/integration.py
scripts/install-host
stctl photos status
```

`install` creates a new `immich` directory under the selected NAS mount and
refuses to adopt an existing directory. It checks the actual filesystem and
share source at every startup. Docker bind mounts use `create_host_path: false`
and containers have no independent restart policy, so Docker cannot bypass
the NAS check on reboot. The systemd service retries failures every 30 seconds.
Enable user lingering for startup without a desktop login.

Runtime files live outside the repository:

| Location | Purpose |
| --- | --- |
| `~/.local/share/stapp-immich/` | Compose, private `.env`, runtime supervisor, local PostgreSQL |
| `~/.config/stapp/immich-deployment.json` | Actual NAS source, paths and private URL |
| `~/.config/stapp/immich.json` | API URL, browser URL, read-only key (mode 0600) |
| NAS mount's `immich/` directory | Originals, thumbnails, video derivatives and Immich DB dumps |
| `~/.local/share/stapp-immich/database-backups/` | Additional local SSD database dumps, last 14 |

For an existing Immich account, create a key with the four permissions above
and write `immich.json` with `api_url` ending in `/api`, `url` without `/api`,
and `api_key`. Use loopback HTTP or trusted HTTPS for the API endpoint.
`STAPP_PHOTOS_CONFIG` can override the config path; `STAPP_PHOTOS_SCRIPT`
overrides the installed adapter path for development/tests.

## Operation and backups

```sh
python3 ~/.local/share/stapp-immich/manage.py status
python3 ~/.local/share/stapp-immich/manage.py backup
python3 ~/.local/share/stapp-immich/manage.py stop
python3 ~/.local/share/stapp-immich/manage.py start
systemctl --user status stapp-immich stapp-immich-backup.timer
journalctl --user -u stapp-immich -n 80
```

Immich schedules database dumps into its NAS `backups/` folder (default daily
at 02:00, last 14). A separate systemd timer creates a database-only dump on
the Steam Machine SSD at 03:15 local time, with up to five minutes of jitter,
keeping the last 14. Neither dump contains photos/videos. Verify timer results
with `systemctl --user status stapp-immich-backup.service` and inspect files.

Protect **the whole NAS Immich folder plus database dumps**, and securely save
the private deployment configuration. A same-NAS snapshot or another folder
on the same disk does not protect against disk loss. This installation does
not create an independent/off-site media backup. Keep phone/cloud originals
during the trial, especially with a single NAS disk. Follow the
[official restore procedure](https://docs.immich.app/administration/backup-and-restore/)
and test recovery separately before depending on this as your only archive.

Updates are manual. Read the target release notes and matching compose file,
create a database dump and a consistent media backup, stop the supervised
service, then update the private `.env` release pin and compose images together.
Pull from the runtime directory and restart the service. Check health and
client compatibility. A previous image alone cannot roll back a migrated
database; preserve a restorable backup. `refresh-runtime` from a reviewed
source checkout updates supervisor code/units only, not images or data.

The service has only a Tailscale Serve route on its own port; no Funnel or
public DNS changes are made. Stop with the supervisor command above, never
`docker compose down -v`. Removing the source worktree does not stop or remove
the independently installed backend.

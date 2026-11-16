# STapp implementation plan

1. Store accepted jobs, their authenticated device, project, reply events and Codex thread in SQLite. Test reconnect, retry, cross-room isolation and restart recovery.
2. Add the typed client and restricted SSH bridge. Run persistent Codex threads in registered local or PC-owned folders. Deliver input requests back to the originating device.
3. Add shared voice capture and local wake/transcription on Windows and SteamOS. Keep acknowledgements local to the requesting device and queue replies during disconnects.
4. Add notes, tasks, calendar, Rohlík MCP and optional Cloudflare routing. Confirm integration outcomes before reporting success.
5. Ship a touchscreen UI with dashboards, photos and a 3D scene, an independent kiosk launcher and read-only physical-frame preview in SM Manager.
6. Install the Steam Machine service, publish a private preview, test the framed SSH protocol, real Codex and the kiosk. Track Windows, account authorization and panel acceptance separately.

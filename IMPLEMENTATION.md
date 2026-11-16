# STapp implementation plan

1. Store accepted jobs, their authenticated device, project, reply events and Codex thread in SQLite. Test reconnect, retry, cross-room isolation and restart recovery.
2. Add the typed client and restricted SSH bridge. Run persistent Codex threads in registered local or PC-owned folders. Deliver input requests back to the originating device.
3. Add shared voice capture and local wake/transcription on Windows and SteamOS. Keep acknowledgements local to the requesting device and queue replies during disconnects.
4. Add notes, tasks, calendar, Rohlík MCP and optional Cloudflare routing. Confirm integration outcomes before reporting success.
5. Ship a touchscreen UI with dashboards, photos and a 3D scene, an independent kiosk launcher and read-only physical-frame preview in SM Manager.
6. Install the Steam Machine service, publish a private preview, test the framed SSH protocol, real Codex and the kiosk. Track Windows, account authorization and panel acceptance separately.

## Device acceptance

1. Install and pair Windows. Enable the microphone, issue a command, mute it from the tray and verify startup after signing back in. Disconnect before a long task finishes and confirm that only the PC receives its result on reconnect.
2. Install the room client in the physical audio session. Verify MIC-SM and SM-SPK1 by name. Start a game on the TV and confirm that the game audio and the room reply use their selected outputs. Test both microphones in earshot if necessary.
3. On a connected panel, check touch and resolution, leave the 3D view open, switch TV inputs and alternate native Gaming Mode and Desktop Mode. Restart the Steam Machine and verify the independent screen stays powered and reconnects. Compare a physical frame with the SM Manager tab, then unplug capture and check its age indicator.
4. Authorize Rohlík, look up a product, and explicitly request a single cart addition before comparing the cart. With Cloudflare enabled, compare end-of-speech to first reply and completion against local routing.

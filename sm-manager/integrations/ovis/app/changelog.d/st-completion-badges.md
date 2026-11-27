### Added

- Show the unread completion count on ST's installed app icon on supported desktops, including while the window is minimized.

### Fixed

- Store conversation read receipts on the server so devices, the conversation list and navigation counts agree.
- Keep old conversations read after metadata edits, reconnects and restarts; only actual completed turns create unread results.
- Acknowledge the completed answer only after it is loaded and visible, and preserve newer results when an older read arrives late.

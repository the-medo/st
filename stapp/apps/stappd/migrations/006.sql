CREATE TABLE assistant_receipts(id TEXT PRIMARY KEY, request TEXT NOT NULL, result TEXT NOT NULL);
CREATE TABLE voice_devices(device TEXT PRIMARY KEY, report TEXT NOT NULL DEFAULT '{}', seen INTEGER NOT NULL DEFAULT 0, settings TEXT NOT NULL DEFAULT '{}', revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE voice_commands(id TEXT PRIMARY KEY, device TEXT NOT NULL, action TEXT NOT NULL, created INTEGER NOT NULL DEFAULT(unixepoch()), result TEXT);
PRAGMA user_version=6;

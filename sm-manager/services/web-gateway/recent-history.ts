import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { RECENT_LIMIT, recentKey, sameRecent, type RecentTarget } from "../../packages/recent-conversations";

/** One bounded MRU for this owner's S.T. instance, ordered by server acceptance. */
export class RecentHistory {
  private db: Database;
  constructor(path = ":memory:") {
    this.db = new Database(path, { create: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS recent_conversations (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        identity TEXT NOT NULL UNIQUE,
        target TEXT NOT NULL
      )`);
  }
  list(): RecentTarget[] {
    return (this.db.query("SELECT target FROM recent_conversations ORDER BY sequence DESC").all() as { target: string }[])
      .map((row) => JSON.parse(row.target) as RecentTarget);
  }
  visit(target: RecentTarget): RecentTarget[] {
    return this.db.transaction(() => {
      // A pane can acquire its durable thread identity after its first visit.
      const previous = this.list().filter((item) => sameRecent(item, target));
      const next = { ...target, threadId: target.threadId ?? previous[0]?.threadId };
      for (const item of previous)
        this.db.query("DELETE FROM recent_conversations WHERE identity = ?").run(recentKey(item));
      this.db.query("INSERT INTO recent_conversations (identity, target) VALUES (?, ?)")
        .run(recentKey(next), JSON.stringify(next));
      this.db.query("DELETE FROM recent_conversations WHERE sequence NOT IN (SELECT sequence FROM recent_conversations ORDER BY sequence DESC LIMIT ?)").run(RECENT_LIMIT);
      return this.list();
    }).immediate();
  }
  close() { this.db.close(); }
}

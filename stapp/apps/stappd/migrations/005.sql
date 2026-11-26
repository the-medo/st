ALTER TABLE events ADD COLUMN payload TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS one_routing_ack ON events(job,kind) WHERE kind IN ('routing','acknowledged');
PRAGMA user_version=5;

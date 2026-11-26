CREATE TABLE IF NOT EXISTS note_operations (
    scope TEXT NOT NULL,
    op_key TEXT NOT NULL,
    request TEXT NOT NULL,
    result TEXT NOT NULL,
    PRIMARY KEY (scope, op_key)
);
PRAGMA user_version=4;

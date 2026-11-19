CREATE TABLE IF NOT EXISTS panel_appearance (
    panel_id INTEGER PRIMARY KEY REFERENCES panel(id),
    theme TEXT NOT NULL
);
INSERT OR IGNORE INTO panel_appearance VALUES (1, 'alpenglow');

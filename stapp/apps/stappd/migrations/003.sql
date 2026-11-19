ALTER TABLE records ADD COLUMN body TEXT NOT NULL DEFAULT '';
ALTER TABLE records ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER records_added AFTER INSERT ON records BEGIN
    UPDATE panel SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER records_changed AFTER UPDATE OF title,starts,zone,done,body ON records BEGIN
    UPDATE records SET version=OLD.version+1 WHERE id=NEW.id;
    UPDATE panel SET revision=revision+1 WHERE id=1;
END;
PRAGMA user_version=3;

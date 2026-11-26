//! Local notes stay independent of the planner service, with optimistic edits
//! and durable receipts so a lost create/delete reply can be retried safely.
use crate::store::Store;
use anyhow::{ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::{json, Value};
use st_core::field;

fn row(r: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"id":r.get::<_,i64>(0)?,"kind":"note","title":r.get::<_,String>(1)?,"body":r.get::<_,String>(2)?,"version":r.get::<_,i64>(3)?}),
    )
}
fn get(db: &Connection, id: i64) -> Result<Value> {
    db.query_row(
        "SELECT id,title,body,version FROM records WHERE kind='note' AND id=?",
        [id],
        row,
    )
    .context("Unknown note")
}
impl Store {
    pub fn notes(&mut self, device: &str, request: &Value) -> Result<Value> {
        self.authorize_tool(device, request)?;
        let name = field(request, "name")?;
        let args = request["args"]
            .as_object()
            .context("Expected note arguments")?;
        if name == "list_notes" {
            let mut stmt = self.db.prepare(
                "SELECT id,title,body,version FROM records WHERE kind='note' ORDER BY id DESC",
            )?;
            let notes = stmt
                .query_map([], row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            return Ok(json!(notes));
        }
        if name == "get_note" {
            return get(
                &self.db,
                request["args"]["id"]
                    .as_i64()
                    .context("Notes use integer IDs")?,
            );
        }
        ensure!(
            args.keys()
                .all(|k| matches!(k.as_str(), "id" | "version" | "title" | "body")),
            "Unknown note field"
        );
        let tx = self.db.transaction()?;
        let key = request["key"].as_str();
        let scope = format!("{device}/{}", request["job"].as_str().unwrap_or("owner"));
        let payload = json!({"name":name,"args":args}).to_string();
        if let Some(key) = key {
            if let Some((previous, result)) = tx
                .query_row(
                    "SELECT request,result FROM note_operations WHERE scope=? AND op_key=?",
                    params![scope, key],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                )
                .optional()?
            {
                ensure!(
                    previous == payload,
                    "Operation key already used for a different note change"
                );
                return Ok(serde_json::from_str(&result)?);
            }
        }
        let id = args
            .get("id")
            .map(|id| id.as_i64().context("Notes use integer IDs"))
            .transpose()?;
        let old = id.map(|id| get(&tx, id)).transpose()?;
        if let Some(old) = &old {
            ensure!(
                request["args"]["version"].as_i64() == old["version"].as_i64(),
                "Note changed; reload before editing"
            );
        } else {
            ensure!(
                !args.contains_key("version"),
                "A version requires a note ID"
            );
        }
        let result = if name == "delete_note" {
            let id = id.context("Missing note ID")?;
            ensure!(args.len() == 2, "Delete expects only id and version");
            tx.execute("DELETE FROM records WHERE kind='note' AND id=?", [id])?;
            tx.execute("UPDATE panel SET revision=revision+1 WHERE id=1", [])?;
            json!({"id":id,"deleted":true})
        } else {
            ensure!(name == "save_note", "Unknown note operation");
            let title = args
                .get("title")
                .or_else(|| old.as_ref().and_then(|o| o.get("title")))
                .and_then(Value::as_str)
                .context("Expected note title")?
                .trim();
            let body = args
                .get("body")
                .or_else(|| old.as_ref().and_then(|o| o.get("body")))
                .map(|v| v.as_str().context("Expected note text"))
                .transpose()?
                .unwrap_or("");
            ensure!(
                !title.is_empty() && title.len() <= 4000 && body.len() <= 32_000,
                "Invalid note title or body length"
            );
            let id = if let Some(id) = id {
                tx.execute(
                    "UPDATE records SET title=?,body=? WHERE id=?",
                    params![title, body, id],
                )?;
                id
            } else {
                tx.execute(
                    "INSERT INTO records(kind,title,body,done) VALUES('note',?,?,0)",
                    params![title, body],
                )?;
                tx.last_insert_rowid()
            };
            get(&tx, id)?
        };
        if let Some(key) = key {
            tx.execute(
                "INSERT INTO note_operations(scope,op_key,request,result) VALUES(?,?,?,?)",
                params![scope, key, payload, result.to_string()],
            )?;
        }
        tx.commit()?;
        Ok(result)
    }
}

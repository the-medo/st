//! Owner UI access and authenticated endpoint synchronization. Device identity is
//! resolved here from stored jobs / the SSH bridge, never from browser input.
use crate::store::Store;
use anyhow::{bail, ensure, Context, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use st_core::field;
use uuid::Uuid;

impl Store {
    pub fn assistant(&mut self, device: &str, v: &Value) -> Result<Value> {
        let op = field(v, "op")?;
        if op == "voice_sync" {
            ensure!(
                matches!(device, "room" | "pc"),
                "Only paired voice devices may report"
            );
            let report = &v["report"];
            ensure!(
                report.is_object() && report.to_string().len() <= 64000,
                "Invalid device report"
            );
            self.db.execute("INSERT INTO voice_devices(device,report,seen) VALUES(?,?,unixepoch()) ON CONFLICT(device) DO UPDATE SET report=excluded.report,seen=excluded.seen", params![device,report.to_string()])?;
            if let Some(acks) = v["acks"].as_array() {
                ensure!(acks.len() <= 20, "Too many command receipts");
                for ack in acks {
                    ensure!(ack["result"].to_string().len() <= 4000, "Receipt too large");
                    self.db.execute("UPDATE voice_commands SET result=? WHERE id=? AND device=? AND result IS NULL",params![ack["result"].to_string(),field(ack,"id")?,device])?;
                }
            }
            let (settings, revision): (String, i64) = self.db.query_row(
                "SELECT settings,revision FROM voice_devices WHERE device=?",
                [device],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            let commands = self.db.prepare("SELECT id,action,created FROM voice_commands WHERE device=? AND result IS NULL AND created>=unixepoch()-30 ORDER BY rowid LIMIT 10")?
                .query_map([device],|r| Ok(json!({"id":r.get::<_,String>(0)?,"action":r.get::<_,String>(1)?,"created":r.get::<_,i64>(2)?})))?.collect::<rusqlite::Result<Vec<_>>>()?;
            return Ok(
                json!({"settings":serde_json::from_str::<Value>(&settings)?,"revision":revision,"commands":commands}),
            );
        }
        ensure!(
            device == "owner",
            "Assistant management requires the local owner"
        );
        if op == "assistant_threads" {
            let ids = self.db.prepare("SELECT DISTINCT thread FROM jobs WHERE project='assistant' AND thread IS NOT NULL")?
                .query_map([], |r| r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            return Ok(json!(ids));
        }
        if op == "assistant_status" {
            let devices=self.db.prepare("SELECT device,report,seen,settings,revision FROM voice_devices ORDER BY device")?
                .query_map([],|r|Ok(json!({"device":r.get::<_,String>(0)?,"report":serde_json::from_str::<Value>(&r.get::<_,String>(1)?).unwrap_or(json!({})),"seen":r.get::<_,i64>(2)?,"settings":serde_json::from_str::<Value>(&r.get::<_,String>(3)?).unwrap_or(json!({})),"revision":r.get::<_,i64>(4)?})))?.collect::<rusqlite::Result<Vec<_>>>()?;
            let jobs=self.db.prepare("SELECT id,device,prompt,status,thread,updated FROM jobs WHERE project='assistant' ORDER BY rowid DESC LIMIT 20")?
                .query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"device":r.get::<_,String>(1)?,"text":r.get::<_,String>(2)?,"status":r.get::<_,String>(3)?,"thread":r.get::<_,Option<String>>(4)?,"updated":r.get::<_,i64>(5)?})))?.collect::<rusqlite::Result<Vec<_>>>()?;
            let commands=self.db.prepare("SELECT id,device,action,created,result FROM voice_commands ORDER BY rowid DESC LIMIT 10")?
                .query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"device":r.get::<_,String>(1)?,"action":r.get::<_,String>(2)?,"created":r.get::<_,i64>(3)?,"result":r.get::<_,Option<String>>(4)?.and_then(|s|serde_json::from_str::<Value>(&s).ok())})))?.collect::<rusqlite::Result<Vec<_>>>()?;
            return Ok(json!({"devices":devices,"requests":jobs,"commands":commands}));
        }
        if matches!(op, "assistant_settings" | "assistant_command") {
            let target = field(v, "target")?;
            ensure!(matches!(target, "room" | "pc"), "Choose room or pc");
            if op == "assistant_settings" {
                let settings = v["settings"].as_object().context("Expected settings")?;
                ensure!(!settings.is_empty(), "No settings supplied");
                for (k, value) in settings {
                    match k.as_str() {
                        "microphone" | "speaker" => {
                            ensure!(
                                value.as_str().is_some_and(
                                    |s| s.len() <= 300 && !s.chars().any(char::is_control)
                                ),
                                "Invalid audio device"
                            )
                        }
                        "muted" => ensure!(value.is_boolean(), "Invalid mute setting"),
                        _ => bail!("Unknown setting"),
                    }
                }
                self.db.execute(
                    "INSERT OR IGNORE INTO voice_devices(device) VALUES(?)",
                    [target],
                )?;
                let (raw, revision): (String, i64) = self.db.query_row(
                    "SELECT settings,revision FROM voice_devices WHERE device=?",
                    [target],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?;
                ensure!(
                    v["revision"].as_i64() == Some(revision),
                    "Settings changed; refresh before saving"
                );
                let mut merged: Value = serde_json::from_str(&raw)?;
                for (k, value) in settings {
                    merged[k] = value.clone();
                }
                self.db.execute(
                    "UPDATE voice_devices SET settings=?,revision=revision+1 WHERE device=?",
                    params![merged.to_string(), target],
                )?;
                return Ok(json!({"revision":revision+1}));
            }
            let action = field(v, "action")?;
            ensure!(
                matches!(
                    action,
                    "stop" | "record" | "test_recording" | "test_speaker"
                ),
                "Unknown device action"
            );
            let id = field(v, "id")?;
            Uuid::parse_str(id)?;
            if let Some((who, original)) = self
                .db
                .query_row(
                    "SELECT device,action FROM voice_commands WHERE id=?",
                    [id],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                )
                .optional()?
            {
                ensure!(
                    who == target && original == action,
                    "Command ID already used"
                );
                return Ok(json!({"id":id}));
            }
            ensure!(self.db.query_row("SELECT EXISTS(SELECT 1 FROM voice_devices WHERE device=? AND seen>=unixepoch()-15)",[target],|r|r.get::<_,bool>(0))?,"Device is offline; reconnect before recording or controlling it");
            let tx = self.db.transaction()?;
            if action == "stop" {
                // Include Herdr-originated follow-ups that the endpoint has not
                // received yet. Retrying this command must not cancel newer work.
                tx.execute("INSERT INTO events(job,kind,body) SELECT id,'cancelled','Stopped. Any already confirmed actions remain in effect.' FROM jobs WHERE device=? AND project='assistant' AND status IN ('queued','running','waiting')",[target])?;
                tx.execute("UPDATE jobs SET status='cancelled',claim=NULL,updated=unixepoch() WHERE device=? AND project='assistant' AND status IN ('queued','running','waiting')",[target])?;
            }
            tx.execute(
                "INSERT INTO voice_commands(id,device,action) VALUES(?,?,?)",
                params![id, target, action],
            )?;
            tx.commit()?;
            return Ok(json!({"id":id}));
        }
        let thread = field(v, "thread")?;
        Uuid::parse_str(thread)?;
        let latest:Option<(String,String,String)>=self.db.query_row("SELECT id,device,status FROM jobs WHERE project='assistant' AND thread=? ORDER BY rowid DESC LIMIT 1",[thread],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        let Some((job, origin, status)) = latest else {
            ensure!(op == "assistant_thread", "Unknown assistant conversation");
            return Ok(Value::Null);
        };
        if op == "assistant_thread" {
            let mut result = self.call(&origin, &json!({"op":"status","id":job}))?;
            result["device"] = json!(origin);
            result["text"] =
                json!(self
                    .db
                    .query_row("SELECT prompt FROM jobs WHERE id=?", [&job], |r| r
                        .get::<_, String>(0))?);
            return Ok(result);
        }
        if op == "assistant_send" {
            let id = field(v, "id")?;
            Uuid::parse_str(id)?;
            let text = field(v, "text")?;
            if let Some((who, prompt, saved_thread)) = self
                .db
                .query_row(
                    "SELECT device,prompt,thread FROM jobs WHERE id=?",
                    [id],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, Option<String>>(2)?,
                        ))
                    },
                )
                .optional()?
            {
                ensure!(
                    who == origin && prompt == text && saved_thread.as_deref() == Some(thread),
                    "Request ID already used"
                );
                return Ok(json!({"id":id,"thread":thread}));
            }
            ensure!(
                !matches!(status.as_str(), "queued" | "running" | "waiting"),
                "This conversation is working or waiting for an answer"
            );
            self.call(
                &origin,
                &json!({"op":"ask","id":id,"text":text,"parent":job}),
            )?;
            return Ok(json!({"id":id,"thread":thread}));
        }
        if op == "assistant_stop" {
            ensure!(
                v["job"].as_str() == Some(&job),
                "The active request changed; refresh before stopping"
            );
            if status != "cancelled" {
                self.call(&origin, &json!({"op":"cancel","id":job}))?;
            }
            return Ok(json!({"ok":true}));
        }
        if op == "assistant_answer" {
            let id = field(v, "id")?;
            Uuid::parse_str(id)?;
            let encoded = v.to_string();
            if let Some((request, result)) = self
                .db
                .query_row(
                    "SELECT request,result FROM assistant_receipts WHERE id=?",
                    [id],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                )
                .optional()?
            {
                ensure!(request == encoded, "Answer ID already used");
                return Ok(serde_json::from_str(&result)?);
            }
            let text = field(v, "text")?;
            ensure!(text.len() <= 32000, "Answer too long");
            ensure!(
                status == "waiting" && v["job"].as_str() == Some(&job),
                "This question is no longer waiting"
            );
            let seq: i64 = self.db.query_row(
                "SELECT max(seq) FROM events WHERE job=? AND kind='question'",
                [&job],
                |r| r.get(0),
            )?;
            ensure!(
                v["question"].as_i64() == Some(seq),
                "This question changed; refresh before answering"
            );
            let tx = self.db.transaction()?;
            tx.execute("UPDATE jobs SET status='running' WHERE id=?", [&job])?;
            tx.execute(
                "INSERT OR REPLACE INTO answers VALUES(?,?)",
                params![job, text],
            )?;
            tx.execute(
                "INSERT INTO assistant_receipts VALUES(?,?,?)",
                params![id, encoded, "{\"ok\":true}"],
            )?;
            tx.commit()?;
            return Ok(json!({"ok":true}));
        }
        bail!("Unknown assistant operation")
    }
}

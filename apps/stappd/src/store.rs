use anyhow::{anyhow, bail, ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use st_core::{field, safe_name};
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub struct Store {
    pub db: Connection,
    pub root: PathBuf,
}
fn event(db: &Connection, id: &str, kind: &str, body: &str) -> Result<()> {
    db.execute(
        "INSERT INTO events(job,kind,body) VALUES(?,?,?)",
        params![id, kind, body],
    )?;
    Ok(())
}
fn rows<F>(db: &Connection, sql: &str, args: impl rusqlite::Params, map: F) -> Result<Vec<Value>>
where
    F: FnMut(&rusqlite::Row) -> rusqlite::Result<Value>,
{
    let mut stmt = db.prepare(sql)?;
    let result = stmt
        .query_map(args, map)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(result)
}
impl Store {
    pub fn open(data: &Path, root: PathBuf) -> Result<Self> {
        let db = Connection::open(data.join("stapp.sqlite"))?;
        db.execute_batch(include_str!("../migrations/001.sql"))?;
        db.execute(
            "INSERT OR IGNORE INTO projects VALUES('assistant',?,'local')",
            [data.join("assistant").to_string_lossy().as_ref()],
        )?;
        Ok(Self { db, root })
    }
    pub fn call(&mut self, device: &str, v: &Value) -> Result<Value> {
        let op = field(v, "op")?;
        match op {
            "projects"=>Ok(json!(rows(&self.db,"SELECT name,host FROM projects ORDER BY name",[],|r|Ok(json!({"name":r.get::<_,String>(0)?,"host":r.get::<_,String>(1)?})))?)),
            "register"|"create_project"=>{
                let name=field(v,"name")?;safe_name(name)?;ensure!(name!="assistant","Reserved project name");
                let host=v["host"].as_str().unwrap_or("local");ensure!(matches!(host,"local"|"pc"),"Invalid host");
                let path=if op=="register"{
                    ensure!(device=="owner","Registration needs the local owner");let raw=field(v,"path")?;
                    if host=="local"{std::fs::canonicalize(raw)?.to_string_lossy().to_string()}else{raw.to_owned()}
                }else{
                    ensure!(host=="local","Create new projects on the Steam Machine");
                    let p=self.root.join(name); std::fs::create_dir_all(&self.root)?;
                    ensure!(!self.db.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE name=?)",[name],|r|r.get::<_,bool>(0))?,"Project already registered");
                    std::fs::create_dir(&p).context("Create new project directory")?; p.to_string_lossy().into_owned()
                };
                if host=="local"{ensure!(Path::new(&path).is_dir(),"Expected a project directory")}
                if let Err(error)=self.db.execute("INSERT INTO projects VALUES(?,?,?)",params![name,path,host]){
                    if op=="create_project"{let _=std::fs::remove_dir(&path);}
                    return Err(error.into())
                }
                Ok(json!({"name":name,"path":path,"host":host}))
            }
            "ask"=>self.ask(device,v),
            "status"=>{
                let id=field(v,"id")?;
                let (status,thread,project):(String,Option<String>,String)=self.db.query_row("SELECT status,thread,project FROM jobs WHERE id=? AND device=?",params![id,device],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).context("Unknown request for this device")?;
                Ok(json!({"id":id,"status":status,"thread":thread,"project":project,"events":self.events(device,Some(id),0)?}))
            }
            "pending"=>Ok(json!(rows(&self.db,"SELECT j.id,(SELECT body FROM events e WHERE e.job=j.id AND e.kind='question' ORDER BY seq DESC LIMIT 1) FROM jobs j WHERE device=? AND status='waiting' ORDER BY j.rowid",[device],|r|Ok(json!({"id":r.get::<_,String>(0)?,"text":r.get::<_,String>(1)?})))?)),
            "inbox"=>Ok(json!(self.events(device,None,v["after"].as_i64().unwrap_or(0))?)),
            "answer"=>{
                let id=field(v,"id")?;let answer=field(v,"text")?;
                let tx=self.db.transaction()?;
                ensure!(tx.execute("UPDATE jobs SET status='running' WHERE id=? AND device=? AND status='waiting'",params![id,device])?==1,"No waiting question for this device");
                tx.execute("INSERT OR REPLACE INTO answers VALUES(?,?)",params![id,answer])?;tx.commit()?;Ok(json!(true))
            }
            "claim_job"=>{
                let host=worker_host(device)?;let tx=self.db.transaction()?;
                // Never replay a job whose worker disappeared during a tool call.
                let stale=rows(&tx,"SELECT id FROM jobs WHERE status IN ('running','waiting') AND updated<unixepoch()-180",[],|r|r.get::<_,String>(0).map(Value::String))?;
                for x in stale{let id=x.as_str().unwrap();tx.execute("UPDATE jobs SET status='interrupted',claim=NULL WHERE id=?",[id])?;event(&tx,id,"interrupted","Worker disconnected. Check any external action before continuing.")?}
                let job:Option<(String,String,String,String,Option<String>,String)>=tx.query_row("SELECT j.id,j.prompt,j.project,p.path,j.thread,j.device FROM jobs j JOIN projects p ON p.name=j.project WHERE p.host=? AND j.status='queued' AND (j.thread IS NULL OR NOT EXISTS(SELECT 1 FROM jobs b WHERE b.thread=j.thread AND b.status IN ('running','waiting'))) ORDER BY j.rowid LIMIT 1",[host],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional()?;
                let result=if let Some((id,prompt,project,path,thread,origin))=job{
                    let claim=Uuid::new_v4().to_string();tx.execute("UPDATE jobs SET status='running',claim=?,updated=unixepoch() WHERE id=?",params![claim,id])?;
                    json!({"id":id,"text":prompt,"project":project,"cwd":path,"thread":thread,"device":origin,"claim":claim})
                }else{Value::Null};tx.commit()?;Ok(result)
            }
            "worker_event"=>{
                worker_host(device)?;let id=field(v,"id")?;let claim=field(v,"claim")?;
                let kind=field(v,"kind")?;let body=v["text"].as_str().unwrap_or("");
                let tx=self.db.transaction()?;
                ensure!(tx.execute("UPDATE jobs SET updated=unixepoch() WHERE id=? AND claim=? AND status IN ('running','waiting') AND project IN(SELECT name FROM projects WHERE host=?)",params![id,claim,worker_host(device)?])?==1,"Worker lease expired");
                let mut reply=Value::Null;
                match kind{
                    "thread"=>{tx.execute("UPDATE jobs SET thread=? WHERE id=?",params![body,id])?;}
                    "question"=>{tx.execute("UPDATE jobs SET status='waiting' WHERE id=?",[id])?;event(&tx,id,kind,body)?;}
                    "poll"=>{reply=tx.query_row("SELECT answer FROM answers WHERE job=?",[id],|r|r.get::<_,String>(0)).optional()?.map(Value::String).unwrap_or(Value::Null);tx.execute("DELETE FROM answers WHERE job=?",[id])?;}
                    "completed"|"failed"=>{tx.execute("UPDATE jobs SET status=?,claim=NULL WHERE id=?",params![kind,id])?;event(&tx,id,kind,body)?;}
                    _=>bail!("Unknown worker event")
                }tx.commit()?;Ok(reply)
            }
            "tools"=>self.tool(device,v),
            _=>bail!("Unknown operation {op}")
        }
    }
    fn events(&self, device: &str, id: Option<&str>, after: i64) -> Result<Vec<Value>> {
        rows(&self.db,"SELECT seq,job,kind,body FROM events JOIN jobs ON jobs.id=events.job WHERE device=? AND (? IS NULL OR job=?) AND seq>? ORDER BY seq LIMIT 100",params![device,id,id,after],|r|Ok(json!({"seq":r.get::<_,i64>(0)?,"id":r.get::<_,String>(1)?,"kind":r.get::<_,String>(2)?,"text":r.get::<_,String>(3)?})))
    }
    fn ask(&mut self, device: &str, v: &Value) -> Result<Value> {
        let id = field(v, "id")?;
        Uuid::parse_str(id)?;
        let prompt = field(v, "text")?;
        ensure!(prompt.len() <= 32000, "Request too long");
        let tx = self.db.transaction()?;
        if v.get("wake").is_some() && prompt.to_lowercase().starts_with("answer ") {
            if let Some((who, original, job)) = tx
                .query_row(
                    "SELECT device,prompt,job FROM voice_answers WHERE id=?",
                    [id],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                        ))
                    },
                )
                .optional()?
            {
                ensure!(
                    who == device && original == prompt,
                    "Request ID already used"
                );
                return Ok(json!({"id":job,"device":device}));
            }
            let waiting = rows(
                &tx,
                "SELECT id FROM jobs WHERE device=? AND status='waiting' ORDER BY rowid",
                [device],
                |r| r.get::<_, String>(0).map(Value::String),
            )?;
            ensure!(
                waiting.len() == 1,
                "A spoken answer needs one pending question. Use stctl answer with the request ID."
            );
            let job = waiting[0].as_str().unwrap();
            let answer = prompt[7..].trim();
            ensure!(!answer.is_empty(), "Missing answer");
            tx.execute(
                "INSERT INTO voice_answers VALUES(?,?,?,?)",
                params![id, device, prompt, job],
            )?;
            tx.execute("UPDATE jobs SET status='running' WHERE id=?", [job])?;
            tx.execute(
                "INSERT OR REPLACE INTO answers VALUES(?,?)",
                params![job, answer],
            )?;
            tx.commit()?;
            return Ok(json!({"id":job,"device":device}));
        }
        let parent = v["parent"].as_str();
        let (project, thread) = if let Some(parent) = parent {
            tx.query_row("SELECT project,thread FROM jobs WHERE id=? AND device=? AND thread IS NOT NULL AND status IN ('completed','failed','interrupted')",params![parent,device],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?))).context("Previous conversation is unavailable")?
        } else {
            (
                v["project"].as_str().unwrap_or("assistant").to_owned(),
                None,
            )
        };
        ensure!(
            tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE name=?)",
                [&project],
                |r| r.get::<_, bool>(0)
            )?,
            "Unknown project"
        );
        if tx.execute("INSERT INTO jobs(id,device,prompt,project,parent,status,thread) VALUES(?,?,?,?,?,'queued',?) ON CONFLICT(id) DO NOTHING",params![id,device,prompt,project,parent,thread])?==1{
            let ack=if prompt.to_lowercase().contains("rohl"){ "I’ll check Rohlík." }else{"Got it."};
            event(&tx,id,"accepted",ack)?;
        }else{
            ensure!(tx.query_row("SELECT device=? AND prompt=? AND project=? AND parent IS ? FROM jobs WHERE id=?",params![device,prompt,project,parent,id],|r|r.get::<_,bool>(0))?,"Request ID already used");
        }
        tx.commit()?;
        Ok(json!({"id":id,"device":device}))
    }
    pub fn snapshot(&self) -> Result<Value> {
        let (view, revision, spec): (String, i64, String) = self.db.query_row(
            "SELECT view,revision,spec FROM panel JOIN views ON name=view WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        let records = rows(
            &self.db,
            "SELECT id,kind,title,starts,zone,done FROM records ORDER BY id DESC LIMIT 200",
            [],
            |r| {
                Ok(
                    json!({"id":r.get::<_,i64>(0)?,"kind":r.get::<_,String>(1)?,"title":r.get::<_,String>(2)?,"starts":r.get::<_,Option<String>>(3)?,"zone":r.get::<_,Option<String>>(4)?,"done":r.get::<_,bool>(5)?}),
                )
            },
        )?;
        let last:Option<String>=self.db.query_row("SELECT body FROM events JOIN jobs ON job=jobs.id WHERE device='room' ORDER BY seq DESC LIMIT 1",[],|r|r.get(0)).optional()?;
        Ok(
            json!({"view":view,"revision":revision,"spec":serde_json::from_str::<Value>(&spec)?,"records":records,"room_reply":last,"views":rows(&self.db,"SELECT name FROM views ORDER BY name",[],|r|r.get::<_,String>(0).map(Value::String))?}),
        )
    }
    fn tool(&mut self, device: &str, v: &Value) -> Result<Value> {
        let name = field(v, "name")?;
        let args = &v["args"];
        if name == "list_records" {
            return Ok(self.snapshot()?["records"].clone());
        }
        let tx = self.db.transaction()?;
        if let Some(job) = v["job"].as_str() {
            ensure!(tx.query_row("SELECT EXISTS(SELECT 1 FROM jobs WHERE id=? AND device=? AND claim=? AND status='running')",params![job,device,v["claim"].as_str()],|r|r.get::<_,bool>(0))?,"Unbound tool request");
            let key = field(v, "key")?;
            if let Some(cached) = tx
                .query_row(
                    "SELECT result FROM operations WHERE job=? AND op_key=?",
                    params![job, key],
                    |r| r.get::<_, String>(0),
                )
                .optional()?
            {
                return Ok(serde_json::from_str(&cached)?);
            }
        }
        let result = match name {
            "save_record" => {
                let kind = field(args, "kind")?;
                let title = field(args, "title")?;
                ensure!(
                    ["task", "event", "note"].contains(&kind) && title.len() <= 4000,
                    "Invalid record"
                );
                let starts = args["starts"].as_str();
                let zone = args["zone"].as_str();
                if kind == "event" {
                    field(args, "starts")?;
                    field(args, "zone")?;
                }
                let id = if let Some(id) = args["id"].as_i64() {
                    ensure!(tx.execute("UPDATE records SET title=?,starts=?,zone=?,done=? WHERE id=? AND kind=?",params![title,starts,zone,args["done"].as_bool().unwrap_or(false),id,kind])?==1,"Unknown record");
                    id
                } else {
                    tx.execute(
                        "INSERT INTO records(kind,title,starts,zone,done) VALUES(?,?,?,?,?)",
                        params![
                            kind,
                            title,
                            starts,
                            zone,
                            args["done"].as_bool().unwrap_or(false)
                        ],
                    )?;
                    tx.last_insert_rowid()
                };
                json!({"id":id,"title":title})
            }
            "publish_app" => {
                let title = field(args, "name")?;
                safe_name(title)?;
                ensure!(!matches!(title, "home" | "clock"), "Built-in view");
                let html = field(args, "html")?;
                ensure!(html.len() <= 1_000_000, "HTML exceeds 1 MB");
                tx.execute("INSERT INTO apps VALUES(?,?) ON CONFLICT(name) DO UPDATE SET html=excluded.html",params![title,html])?;
                let spec = json!({"kind":"app","asset":title});
                tx.execute("INSERT INTO views VALUES(?,?) ON CONFLICT(name) DO UPDATE SET spec=excluded.spec",params![title,spec.to_string()])?;
                json!({"view":title})
            }
            "save_view" => {
                let title = field(args, "name")?;
                safe_name(title)?;
                ensure!(!matches!(title, "home" | "clock"), "Built-in view");
                let spec = &args["spec"];
                match field(spec, "kind")? {
                    "dashboard" => {
                        let widgets = spec["widgets"].as_array().context("Missing widgets")?;
                        ensure!(
                            !widgets.is_empty()
                                && widgets.len() <= 6
                                && widgets.iter().all(|v| matches!(
                                    v.as_str(),
                                    Some("calendar" | "tasks" | "notes" | "clock")
                                )),
                            "Unknown widget"
                        );
                    }
                    "photo" | "app" => {
                        safe_name(field(spec, "asset")?)?;
                    }
                    _ => bail!("Unsupported view"),
                }
                tx.execute("INSERT INTO views VALUES(?,?) ON CONFLICT(name) DO UPDATE SET spec=excluded.spec",params![title,spec.to_string()])?;
                json!({"view":title})
            }
            "show_view" => {
                let name = field(args, "name")?;
                ensure!(tx.execute("UPDATE panel SET view=?,revision=revision+1 WHERE id=1 AND EXISTS(SELECT 1 FROM views WHERE name=?)",params![name,name])?==1,"Unknown view");
                json!({"view":name})
            }
            _ => return Err(anyhow!("Unknown tool")),
        };
        if let Some(job) = v["job"].as_str() {
            tx.execute(
                "INSERT INTO operations VALUES(?,?,?)",
                params![job, field(v, "key")?, result.to_string()],
            )?;
        }
        tx.commit()?;
        Ok(result)
    }
}
fn worker_host(device: &str) -> Result<&'static str> {
    match device {
        "owner" => Ok("local"),
        "pc" => Ok("pc"),
        _ => bail!("No worker for device"),
    }
}

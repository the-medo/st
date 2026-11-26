//! Typed planner commands. All writes go through STapp's existing rules service.
use anyhow::{bail, ensure, Context, Result};
use clap::{Args, Subcommand};
use serde_json::{json, Value};
use std::{io::Read, path::PathBuf};
use uuid::Uuid;

#[derive(Subcommand)]
pub enum PlannerOp {
    /// List all tasks, calendar events and local notes.
    List,
    Tasks {
        #[command(subcommand)]
        command: TaskOp,
    },
    Calendar {
        #[command(subcommand)]
        command: CalendarOp,
    },
    Notes {
        #[command(subcommand)]
        command: NoteOp,
    },
    /// Personal task projects, separate from registered coding workspaces.
    Projects {
        #[command(subcommand)]
        command: ProjectOp,
    },
}

#[derive(Args, Default)]
pub struct Filter {
    /// Match title or description, ignoring case.
    #[arg(long)]
    search: Option<String>,
    /// Task project ID (not a coding workspace).
    #[arg(long)]
    project: Option<String>,
    #[arg(long)]
    label: Option<String>,
    /// Include completed tasks (the default lists open tasks).
    #[arg(long, conflicts_with = "done")]
    all: bool,
    /// List only completed tasks.
    #[arg(long)]
    done: bool,
}
#[derive(Args, Default)]
pub struct Body {
    #[arg(long, conflicts_with = "body_file")]
    body: Option<String>,
    /// Read UTF-8 text from a file, or - for stdin.
    #[arg(long)]
    body_file: Option<PathBuf>,
}
impl Body {
    fn apply(self, args: &mut Value) -> Result<()> {
        if let Some(body) = self.body {
            args["body"] = json!(body);
        }
        if let Some(path) = self.body_file {
            let text = if path.as_os_str() == "-" {
                let mut text = String::new();
                std::io::stdin().read_to_string(&mut text)?;
                text
            } else {
                std::fs::read_to_string(path).context("Read description file")?
            };
            args["body"] = json!(text);
        }
        Ok(())
    }
}
#[derive(Args)]
pub struct Target {
    id: String,
    /// Use this previously read version. Stale edits fail without retrying.
    #[arg(long)]
    version: Option<String>,
}
#[derive(Args, Default)]
pub struct TaskFields {
    #[command(flatten)]
    body: Body,
    /// YYYY-MM-DD or ISO date/time; the backend validates the saved zone.
    #[arg(long, conflicts_with = "clear_due")]
    due: Option<String>,
    #[arg(long)]
    clear_due: bool,
    /// IANA zone, e.g. Europe/Paris. Defaults to the planner's zone on creation.
    #[arg(long)]
    zone: Option<String>,
    #[arg(long, conflicts_with = "clear_project")]
    project: Option<String>,
    #[arg(long)]
    clear_project: bool,
    #[arg(long, conflicts_with = "clear_parent")]
    parent: Option<String>,
    #[arg(long)]
    clear_parent: bool,
    /// 1 is highest, 0 is unset.
    #[arg(long, value_parser = clap::value_parser!(u8).range(0..=9))]
    priority: Option<u8>,
    /// Replace labels; repeat the flag for multiple labels.
    #[arg(long = "label", conflicts_with = "clear_labels")]
    labels: Vec<String>,
    #[arg(long)]
    clear_labels: bool,
    #[arg(long, value_parser = ["daily", "weekly", "monthly", "yearly"], conflicts_with = "clear_repeat")]
    repeat: Option<String>,
    #[arg(long, requires = "repeat", value_parser = clap::value_parser!(u32).range(1..=100))]
    interval: Option<u32>,
    /// due follows the schedule; completion counts from completion (legacy backend only).
    #[arg(long, requires = "repeat", value_parser = ["due", "completion"])]
    repeat_mode: Option<String>,
    #[arg(long, requires = "repeat", value_delimiter = ',', value_parser = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"])]
    weekdays: Vec<String>,
    #[arg(long, requires = "repeat", conflicts_with = "until", value_parser = clap::value_parser!(u32).range(1..=10000))]
    count: Option<u32>,
    #[arg(long, requires = "repeat")]
    until: Option<String>,
    #[arg(long)]
    clear_repeat: bool,
}
impl TaskFields {
    fn apply(self, args: &mut Value) -> Result<()> {
        self.body.apply(args)?;
        for (key, value, clear) in [
            ("due", self.due, self.clear_due),
            ("project_id", self.project, self.clear_project),
            ("parent_id", self.parent, self.clear_parent),
        ] {
            if let Some(value) = value {
                args[key] = json!(value);
            }
            if clear {
                args[key] = Value::Null;
            }
        }
        if let Some(zone) = self.zone {
            args["zone"] = json!(zone);
        }
        if let Some(priority) = self.priority {
            args["priority"] = json!(priority);
        }
        if !self.labels.is_empty() || self.clear_labels {
            args["labels"] = json!(self.labels);
        }
        if let Some(frequency) = self.repeat {
            let mut rule = json!({"frequency":frequency,"interval":self.interval.unwrap_or(1),"mode":self.repeat_mode.unwrap_or_else(||"due".into())});
            if !self.weekdays.is_empty() {
                rule["weekdays"] = json!(self.weekdays);
            }
            if let Some(count) = self.count {
                rule["count"] = json!(count);
            }
            if let Some(until) = self.until {
                rule["until"] = json!(until);
            }
            args["recurrence"] = rule;
        }
        if self.clear_repeat {
            args["recurrence"] = Value::Null;
        }
        Ok(())
    }
}
#[derive(Subcommand)]
pub enum TaskOp {
    List {
        #[command(flatten)]
        filter: Filter,
    },
    Get {
        id: String,
    },
    /// Include completion history from the planner's full record.
    History {
        id: String,
    },
    Add {
        title: String,
        #[command(flatten)]
        fields: TaskFields,
    },
    Edit {
        #[command(flatten)]
        target: Target,
        #[arg(long)]
        title: Option<String>,
        #[command(flatten)]
        fields: TaskFields,
    },
    /// Complete exactly one occurrence, advancing recurrence if configured.
    #[command(alias = "done")]
    Complete {
        #[command(flatten)]
        target: Target,
    },
    /// Reopen the current task; this does not undo recurrence history.
    Reopen {
        #[command(flatten)]
        target: Target,
    },
    Delete {
        #[command(flatten)]
        target: Target,
    },
}
#[derive(Args, Default)]
pub struct EventFields {
    #[command(flatten)]
    body: Body,
    /// Exclusive end for all-day events; use a date or ISO date/time.
    #[arg(long)]
    ends: Option<String>,
}
impl EventFields {
    fn apply(self, args: &mut Value) -> Result<()> {
        self.body.apply(args)?;
        if let Some(ends) = self.ends {
            args["ends"] = json!(ends);
        }
        Ok(())
    }
}
#[derive(Subcommand)]
pub enum CalendarOp {
    /// Events sorted by saved start date/time; bounds use each event's saved local date.
    List {
        #[arg(long)]
        search: Option<String>,
        #[arg(long, value_parser = date)]
        from: Option<String>,
        #[arg(long, value_parser = date)]
        to: Option<String>,
    },
    Get {
        id: String,
    },
    Add {
        title: String,
        #[arg(long)]
        starts: String,
        #[arg(long)]
        zone: String,
        #[command(flatten)]
        fields: EventFields,
    },
    Edit {
        #[command(flatten)]
        target: Target,
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        starts: Option<String>,
        #[arg(long)]
        zone: Option<String>,
        #[command(flatten)]
        fields: EventFields,
    },
    Delete {
        #[command(flatten)]
        target: Target,
    },
}
fn date(value: &str) -> std::result::Result<String, String> {
    let parts: Vec<_> = value.split('-').collect();
    let valid = || -> Option<bool> {
        if !value.bytes().all(|b| b.is_ascii_digit() || b == b'-')
            || parts.len() != 3
            || parts[0].len() != 4
            || parts[1].len() != 2
            || parts[2].len() != 2
        {
            return Some(false);
        }
        let year: u32 = parts[0].parse().ok()?;
        let month: u32 = parts[1].parse().ok()?;
        let day: u32 = parts[2].parse().ok()?;
        let leap =
            year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
        let days = match month {
            2 => {
                if leap {
                    29
                } else {
                    28
                }
            }
            4 | 6 | 9 | 11 => 30,
            1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
            _ => 0,
        };
        Some(year > 0 && day > 0 && day <= days)
    };
    if valid() == Some(true) {
        Ok(value.into())
    } else {
        Err("Expected a valid YYYY-MM-DD date".into())
    }
}
#[derive(Subcommand)]
pub enum NoteOp {
    List {
        #[arg(long)]
        search: Option<String>,
    },
    Get {
        id: i64,
    },
    Add {
        title: String,
        #[command(flatten)]
        body: Body,
    },
    Edit {
        id: i64,
        #[arg(long)]
        title: Option<String>,
        #[command(flatten)]
        body: Body,
        #[arg(long)]
        version: Option<i64>,
    },
    Delete {
        id: i64,
        #[arg(long)]
        version: Option<i64>,
    },
}
#[derive(Args, Default)]
pub struct ProjectFields {
    #[command(flatten)]
    body: Body,
    #[arg(long)]
    color: Option<String>,
    /// Whether tasks appear on every faceplate (true/false).
    #[arg(long)]
    visible: Option<bool>,
}
impl ProjectFields {
    fn apply(self, args: &mut Value) -> Result<()> {
        self.body.apply(args)?;
        if let Some(color) = self.color {
            args["color"] = json!(color);
        }
        if let Some(visible) = self.visible {
            args["visible_on_screen"] = json!(visible);
        }
        Ok(())
    }
}
#[derive(Subcommand)]
pub enum ProjectOp {
    List,
    Get {
        id: String,
    },
    Add {
        title: String,
        #[command(flatten)]
        fields: ProjectFields,
    },
    Edit {
        #[command(flatten)]
        target: Target,
        #[arg(long)]
        title: Option<String>,
        #[command(flatten)]
        fields: ProjectFields,
    },
    /// Delete an empty project; the backend refuses projects with tasks.
    Delete {
        #[command(flatten)]
        target: Target,
    },
}

pub struct Client<'a> {
    pub ssh: Option<&'a str>,
    pub device: &'a str,
}
impl Client<'_> {
    pub fn call(&self, name: &str, args: Value) -> Result<Value> {
        st_core::exchange(
            &json!({"op":"tools","name":name,"args":args,"planner": !name.ends_with("_note") && !name.ends_with("_notes")}),
            self.ssh,
            self.device,
        )
    }
    fn write(&self, name: &str, args: Value) -> Result<Value> {
        let request = json!({"op":"tools","name":name,"args":args,"planner": !name.ends_with("_note") && !name.ends_with("_notes"),"key":Uuid::new_v4().to_string()});
        st_core::exchange(&request, self.ssh, self.device).with_context(|| {
            // Keep the exact version and key after a lost response; never re-read and
            // accidentally complete another occurrence. JSON is data, not shell code.
            format!("Write was not confirmed. Do not repeat a recurring completion with a fresh version. Retry the identical request with st rpc (same connection/device):\n{}", request)
        })
    }
    fn get(&self, id: &str, kind: &str) -> Result<Value> {
        let value = self.call("get_record", json!({"id":id}))?;
        ensure!(value["kind"] == kind, "Expected a {kind} record");
        Ok(value)
    }
    fn target(&self, target: Target, kind: &str) -> Result<Value> {
        let current = self.get(&target.id, kind)?;
        let version = match target.version {
            Some(v) => json!(v),
            None => current["version"].clone(),
        };
        ensure!(!version.is_null(), "Record has no version");
        Ok(json!({"id":target.id,"version":version}))
    }
    fn records(&self, kind: &str, search: Option<&str>) -> Result<Vec<Value>> {
        let value = self.call(
            if kind == "note" {
                "list_notes"
            } else {
                "list_records"
            },
            json!({}),
        )?;
        let rows = value.as_array().context("Expected a record list")?;
        Ok(rows
            .iter()
            .filter(|r| r["kind"] == kind && matches_search(r, search))
            .cloned()
            .collect())
    }
    pub fn planner(&self, command: PlannerOp) -> Result<Value> {
        match command {
            PlannerOp::List => self.call("list_records", json!({})),
            PlannerOp::Tasks { command } => self.tasks(command),
            PlannerOp::Calendar { command } => self.calendar(command),
            PlannerOp::Notes { command } => self.notes(command),
            PlannerOp::Projects { command } => self.projects(command),
        }
    }
    pub fn tasks(&self, command: TaskOp) -> Result<Value> {
        match command {
            TaskOp::List { filter } => {
                let mut records = self.records("task", filter.search.as_deref())?;
                records.retain(|r| {
                    (filter.all || r["done"].as_bool().unwrap_or(false) == filter.done)
                        && filter
                            .project
                            .as_ref()
                            .is_none_or(|p| r["project_id"] == *p)
                        && filter.label.as_ref().is_none_or(|l| {
                            r["labels"]
                                .as_array()
                                .is_some_and(|a| a.contains(&json!(l)))
                        })
                });
                records.sort_by_key(|r| {
                    (
                        r["due"].as_str().unwrap_or("9999").to_owned(),
                        r["title"].as_str().unwrap_or("").to_owned(),
                    )
                });
                Ok(json!(records))
            }
            TaskOp::Get { id } | TaskOp::History { id } => self.get(&id, "task"),
            TaskOp::Add { title, fields } => {
                let mut args = json!({"kind":"task","title":title});
                fields.apply(&mut args)?;
                self.write("save_record", args)
            }
            TaskOp::Edit {
                target,
                title,
                fields,
            } => {
                let mut patch = json!({});
                if let Some(title) = title {
                    patch["title"] = json!(title);
                }
                fields.apply(&mut patch)?;
                ensure!(
                    !patch.as_object().unwrap().is_empty(),
                    "Supply at least one field to edit"
                );
                let mut args = self.target(target, "task")?;
                args["kind"] = json!("task");
                merge(&mut args, patch);
                self.write("save_record", args)
            }
            TaskOp::Complete { target } => {
                self.write("complete_task", self.target(target, "task")?)
            }
            TaskOp::Reopen { target } => {
                let mut args = self.target(target, "task")?;
                args["kind"] = json!("task");
                args["done"] = json!(false);
                self.write("save_record", args)
            }
            TaskOp::Delete { target } => self.write("delete_record", self.target(target, "task")?),
        }
    }
    pub fn calendar(&self, command: CalendarOp) -> Result<Value> {
        match command {
            CalendarOp::List { search, from, to } => {
                ensure!(
                    from.as_ref().zip(to.as_ref()).is_none_or(|(f, t)| f <= t),
                    "--from must not follow --to"
                );
                let mut rows = self.records("event", search.as_deref())?;
                rows.retain(|r| {
                    let start = r["starts"].as_str().unwrap_or("");
                    let end = r["ends"].as_str().unwrap_or(start);
                    // Half-open overlap, except a point event includes its start day.
                    to.as_deref()
                        .is_none_or(|t| start.get(..10).unwrap_or(start) <= t)
                        && from.as_deref().is_none_or(|f| {
                            if end == start {
                                start.get(..10).unwrap_or(start) >= f
                            } else {
                                let end_date = end.get(..10).unwrap_or(end);
                                // An exclusive midnight end does not overlap that day.
                                end_date > f
                                    || (end_date == f
                                        && end.get(11..).is_some_and(|time| {
                                            time.split(['+', '-', 'Z'])
                                                .next()
                                                .unwrap_or("")
                                                .bytes()
                                                .any(|b| b.is_ascii_digit() && b != b'0')
                                        }))
                            }
                        })
                });
                rows.sort_by_key(|r| r["starts"].as_str().unwrap_or("").to_owned());
                Ok(json!(rows))
            }
            CalendarOp::Get { id } => self.get(&id, "event"),
            CalendarOp::Add {
                title,
                starts,
                zone,
                fields,
            } => {
                let mut args = json!({"kind":"event","title":title,"starts":starts,"zone":zone});
                fields.apply(&mut args)?;
                self.write("save_record", args)
            }
            CalendarOp::Edit {
                target,
                title,
                starts,
                zone,
                fields,
            } => {
                let mut patch = json!({});
                for (key, value) in [("title", title), ("starts", starts), ("zone", zone)] {
                    if let Some(value) = value {
                        patch[key] = json!(value);
                    }
                }
                fields.apply(&mut patch)?;
                ensure!(
                    !patch.as_object().unwrap().is_empty(),
                    "Supply at least one field to edit"
                );
                let mut args = self.target(target, "event")?;
                args["kind"] = json!("event");
                merge(&mut args, patch);
                self.write("save_record", args)
            }
            CalendarOp::Delete { target } => {
                self.write("delete_record", self.target(target, "event")?)
            }
        }
    }
    pub fn projects(&self, command: ProjectOp) -> Result<Value> {
        match command {
            ProjectOp::List => self.call("list_task_projects", json!({})),
            ProjectOp::Get { id } => self.get(&id, "project"),
            ProjectOp::Add { title, fields } => {
                let mut args = json!({"title":title});
                fields.apply(&mut args)?;
                self.write("save_task_project", args)
            }
            ProjectOp::Edit {
                target,
                title,
                fields,
            } => {
                let mut patch = json!({});
                if let Some(title) = title {
                    patch["title"] = json!(title);
                }
                fields.apply(&mut patch)?;
                ensure!(
                    !patch.as_object().unwrap().is_empty(),
                    "Supply at least one field to edit"
                );
                let mut args = self.target(target, "project")?;
                merge(&mut args, patch);
                self.write("save_task_project", args)
            }
            ProjectOp::Delete { target } => {
                self.write("delete_record", self.target(target, "project")?)
            }
        }
    }
    pub fn notes(&self, command: NoteOp) -> Result<Value> {
        match command {
            NoteOp::List { search } => Ok(json!(self.records("note", search.as_deref())?)),
            NoteOp::Get { id } => self.call("get_note", json!({"id":id})),
            NoteOp::Add { title, body } => {
                let mut args = json!({"title":title});
                body.apply(&mut args)?;
                self.write("save_note", args)
            }
            NoteOp::Edit {
                id,
                title,
                body,
                version,
            } => {
                let mut args = json!({});
                if let Some(title) = title {
                    args["title"] = json!(title);
                }
                body.apply(&mut args)?;
                ensure!(
                    !args.as_object().unwrap().is_empty(),
                    "Supply at least one field to edit"
                );
                args["id"] = json!(id);
                args["version"] = match version {
                    Some(v) => json!(v),
                    None => self.call("get_note", json!({"id":id}))?["version"].clone(),
                };
                self.write("save_note", args)
            }
            NoteOp::Delete { id, version } => {
                let version = match version {
                    Some(v) => json!(v),
                    None => self.call("get_note", json!({"id":id}))?["version"].clone(),
                };
                self.write("delete_note", json!({"id":id,"version":version}))
            }
        }
    }
}
fn matches_search(record: &Value, search: Option<&str>) -> bool {
    search.is_none_or(|s| {
        ["title", "body"].iter().any(|k| {
            record[k]
                .as_str()
                .unwrap_or("")
                .to_lowercase()
                .contains(&s.to_lowercase())
        })
    })
}
fn merge(target: &mut Value, patch: Value) {
    target
        .as_object_mut()
        .unwrap()
        .extend(patch.as_object().unwrap().clone());
}

/// Read JSON from an argument or @file; @- reads stdin.
pub fn json_input(input: &str) -> Result<Value> {
    let text = if let Some(path) = input.strip_prefix('@') {
        if path == "-" {
            let mut text = String::new();
            std::io::stdin().read_to_string(&mut text)?;
            text
        } else {
            std::fs::read_to_string(path)?
        }
    } else {
        input.into()
    };
    let value: Value = serde_json::from_str(&text)?;
    if !value.is_object() {
        bail!("Expected a JSON object")
    }
    Ok(value)
}

mod planner;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use serde_json::{json, Value};
use st_core::{exchange, MAX_LINE};
use std::{
    env,
    io::{self, BufRead, Write},
    path::PathBuf,
    process::Command,
};
use uuid::Uuid;
#[derive(Parser)]
#[command(
    name = "st",
    about = "S.T. agents, planner, assistant and system console"
)]
struct Cli {
    #[arg(long, global = true, env = "STAPP_SSH")]
    ssh: Option<String>,
    #[arg(long, global = true, env = "STAPP_DEVICE", default_value = "owner")]
    device: String,
    #[command(subcommand)]
    op: Op,
}
#[derive(Subcommand)]
enum Op {
    Ask {
        text: String,
        #[arg(long)]
        project: Option<String>,
        #[arg(long)]
        parent: Option<String>,
        #[arg(long)]
        id: Option<String>,
    },
    /// Show system status, or the status of an assistant request by ID.
    Status {
        id: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Control faceplate night mode (on means screen off).
    Night {
        #[arg(value_enum, default_value_t = NightAction::Status)]
        action: NightAction,
        #[arg(long)]
        json: bool,
    },
    /// Print a read-only cleanup inventory for a worktree.
    CleanupPlan {
        worktree_id: String,
    },
    /// Access the installed system monitor's complete CLI.
    Monitor {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// Stop a queued/running request belonging to this device.
    Cancel {
        id: String,
    },
    Answer {
        id: String,
        text: String,
    },
    Inbox {
        #[arg(long, default_value_t = 0)]
        after: i64,
    },
    /// List registered coding workspaces.
    Projects,
    /// Browse and change personal planner records.
    Planner {
        #[command(subcommand)]
        command: planner::PlannerOp,
    },
    /// List, create, edit and complete planner tasks.
    Tasks {
        #[command(subcommand)]
        command: planner::TaskOp,
    },
    /// Browse and edit calendar events.
    Calendar {
        #[command(subcommand)]
        command: planner::CalendarOp,
    },
    /// Search and edit local faceplate notes.
    Notes {
        #[command(subcommand)]
        command: planner::NoteOp,
    },
    /// List unanswered assistant questions for this device.
    Pending,
    /// List recent assistant requests for this device.
    Requests {
        #[arg(long)]
        project: Option<String>,
        #[arg(long, value_parser = ["queued", "running", "waiting", "completed", "failed", "interrupted", "cancelled"])]
        status: Option<String>,
        #[arg(long, default_value_t = 20, value_parser = clap::value_parser!(u32).range(1..=200))]
        limit: u32,
    },
    /// Agents sessions, output, plans and input (run on the host).
    #[command(disable_help_flag = true)]
    Agents {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// List monitored worktrees and resources (run on the host).
    #[command(disable_help_flag = true)]
    Worktrees {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// List monitored containers (run on the host).
    #[command(disable_help_flag = true)]
    Containers {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// Browse the configured Immich library through S.T.
    Photos {
        #[command(subcommand)]
        command: PhotoOp,
    },
    Register {
        name: String,
        path: String,
        #[arg(long, default_value = "local")]
        host: String,
    },
    CreateProject {
        name: String,
    },
    Show {
        name: String,
    },
    ImportPhoto {
        name: String,
        path: PathBuf,
    },
    ImportApp {
        name: String,
        path: PathBuf,
    },
    Bridge,
    /// Send a raw request: JSON, @file, or @- for stdin.
    Rpc {
        json: String,
    },
    Mcp,
}
#[derive(Clone, clap::ValueEnum)]
enum NightAction {
    On,
    Off,
    Toggle,
    Status,
}
impl NightAction {
    fn as_str(&self) -> &'static str {
        match self {
            Self::On => "on",
            Self::Off => "off",
            Self::Toggle => "toggle",
            Self::Status => "status",
        }
    }
}

fn monitor(args: Vec<String>, ssh: Option<&str>) -> Result<()> {
    anyhow::ensure!(
        env::var_os("ST_MONITOR_DISPATCHED").is_none(),
        "Monitor launcher delegates back to st; restore the original sm launcher"
    );
    anyhow::ensure!(ssh.is_none(), "System commands need an owner SSH session: ssh HOST st night status (paired assistant bridges cannot run monitor commands)");
    let executable = env::var_os("ST_MONITOR_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let installed =
                PathBuf::from(env::var_os("HOME").unwrap_or_default()).join(".local/bin/sm");
            if installed.is_file() {
                installed
            } else {
                PathBuf::from("sm")
            }
        });
    if let (Ok(target), Ok(current)) = (
        std::fs::canonicalize(&executable),
        env::current_exe().and_then(std::fs::canonicalize),
    ) {
        anyhow::ensure!(target != current, "Monitor command points back to st; configure ST_MONITOR_BIN with the existing sm launcher");
    }
    let status = Command::new(executable)
        .args(args)
        .env("ST_MONITOR_DISPATCHED", "1")
        .status()
        .context("Start the system monitor CLI; install SM Manager on this host first")?;
    if !status.success() {
        std::process::exit(status.code().unwrap_or(1));
    }
    Ok(())
}
#[derive(Subcommand)]
enum PhotoOp {
    Status,
    Albums,
    Recent {
        #[arg(long, default_value_t = 20)]
        limit: u32,
        #[arg(long, default_value_t = 1)]
        page: u32,
    },
    Search {
        query: String,
        /// Search image content with Immich machine learning instead of filenames.
        #[arg(long)]
        semantic: bool,
        #[arg(long, default_value_t = 20)]
        limit: u32,
        #[arg(long, default_value_t = 1)]
        page: u32,
    },
    /// Show a JPEG preview on the shared living-room faceplate.
    Show {
        id: String,
    },
}
pub fn run() -> Result<()> {
    let cli = Cli::parse();
    let client = planner::Client {
        ssh: cli.ssh.as_deref(),
        device: &cli.device,
    };
    let print = |value: Value| -> Result<()> {
        println!("{}", serde_json::to_string_pretty(&value)?);
        Ok(())
    };
    let v = match cli.op {
        Op::Planner { command } => return print(client.planner(command)?),
        Op::Tasks { command } => return print(client.tasks(command)?),
        Op::Calendar { command } => return print(client.calendar(command)?),
        Op::Notes { command } => return print(client.notes(command)?),
        Op::Pending => json!({"op":"pending"}),
        Op::Requests {
            project,
            status,
            limit,
        } => json!({"op":"requests","project":project,"status":status,"limit":limit}),
        Op::Agents { args } => {
            return monitor([vec!["agents".into()], args].concat(), cli.ssh.as_deref())
        }
        Op::Worktrees { args } => {
            return monitor(
                [vec!["worktrees".into()], args].concat(),
                cli.ssh.as_deref(),
            )
        }
        Op::Containers { args } => {
            return monitor(
                [vec!["containers".into()], args].concat(),
                cli.ssh.as_deref(),
            )
        }
        Op::Ask {
            text,
            project,
            parent,
            id,
        } => {
            json!({"op":"ask","text":text,"id":id.unwrap_or_else(||Uuid::new_v4().to_string()),"project":project,"parent":parent})
        }
        Op::Status { id: Some(id), .. } => json!({"op":"status","id":id}),
        Op::Status { id: None, json } => {
            let mut args = vec!["status".into()];
            if json {
                args.push("--json".into());
            }
            return monitor(args, cli.ssh.as_deref());
        }
        Op::Night { action, json } => {
            let mut args = vec!["night".into(), action.as_str().into()];
            if json {
                args.push("--json".into());
            }
            return monitor(args, cli.ssh.as_deref());
        }
        Op::CleanupPlan { worktree_id } => {
            return monitor(vec!["cleanup-plan".into(), worktree_id], cli.ssh.as_deref())
        }
        Op::Monitor { args } => {
            return monitor(
                if args.is_empty() {
                    vec!["--help".into()]
                } else {
                    args
                },
                cli.ssh.as_deref(),
            )
        }
        Op::Cancel { id } => json!({"op":"cancel","id":id}),
        Op::Answer { id, text } => json!({"op":"answer","id":id,"text":text}),
        Op::Inbox { after } => json!({"op":"inbox","after":after}),
        Op::Projects => json!({"op":"projects"}),
        Op::Photos { command } => {
            let (name, args) = match command {
                PhotoOp::Status => ("photos_status", json!({})),
                PhotoOp::Albums => ("photos_albums", json!({})),
                PhotoOp::Recent { limit, page } => {
                    ("photos_recent", json!({"limit":limit,"page":page}))
                }
                PhotoOp::Search {
                    query,
                    semantic,
                    limit,
                    page,
                } => (
                    "photos_search",
                    json!({"query":query,"semantic":semantic,"limit":limit,"page":page}),
                ),
                PhotoOp::Show { id } => ("photos_show", json!({"id":id})),
            };
            json!({"op":"tools","name":name,"args":args})
        }
        Op::Register { name, path, host } => {
            json!({"op":"register","name":name,"path":path,"host":host})
        }
        Op::CreateProject { name } => json!({"op":"create_project","name":name}),
        Op::Show { name } => json!({"op":"tools","name":"show_view","args":{"name":name}}),
        Op::ImportPhoto { name, path } => {
            use base64::{engine::general_purpose::STANDARD, Engine};
            let data = std::fs::read(path)?;
            if data.len() > 5_000_000 {
                bail!("JPEG exceeds 5 MB")
            }
            json!({"op":"import_photo","name":name,"data":STANDARD.encode(data)})
        }
        Op::ImportApp { name, path } => {
            json!({"op":"tools","name":"publish_app","args":{"name":name,"html":std::fs::read_to_string(path)?}})
        }
        Op::Rpc { json } => planner::json_input(&json)?,
        Op::Bridge => {
            // Use a fixed server-side role even when the client supplies its own device field.
            let device = if cli.device == "owner" {
                "pc"
            } else {
                &cli.device
            };
            if !matches!(device, "pc" | "room") {
                bail!("Bridge needs a paired device")
            }
            let input = io::stdin();
            let mut input = input.lock();
            let mut output = io::stdout().lock();
            loop {
                use std::io::Read;
                let mut line = String::new();
                let n = (&mut input)
                    .take(MAX_LINE as u64 + 1)
                    .read_line(&mut line)?;
                if n == 0 {
                    break;
                }
                if n > MAX_LINE {
                    bail!("Line too large")
                }
                let result: Result<Value> = (|| {
                    let msg = serde_json::from_str(&line)?;
                    exchange(&msg, None, device)
                })();
                let response = match result {
                    Ok(v) => json!({"result":v}),
                    Err(e) => json!({"error":format!("{e:#}")}),
                };
                writeln!(output, "{response}")?;
                output.flush()?;
            }
            return Ok(());
        }
        Op::Mcp => {
            let path = env::var_os("STAPP_MCP_SCRIPT")
                .map(PathBuf::from)
                .unwrap_or(
                    env::current_exe()?
                        .parent()
                        .context("Missing executable path")?
                        .join("mcp.py"),
                );
            let result =
                Command::new(env::var("STAPP_PYTHON").unwrap_or_else(|_| "python3".into()))
                    .arg(path)
                    .status()?;
            if !result.success() {
                bail!("MCP adapter failed")
            }
            return Ok(());
        }
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&exchange(&v, cli.ssh.as_deref(), &cli.device)?)?
    );
    Ok(())
}

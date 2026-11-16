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
    Status {
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
    Projects,
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
    Rpc {
        json: String,
    },
    Mcp,
}
fn main() -> Result<()> {
    let cli = Cli::parse();
    let v = match cli.op {
        Op::Ask {
            text,
            project,
            parent,
            id,
        } => {
            json!({"op":"ask","text":text,"id":id.unwrap_or_else(||Uuid::new_v4().to_string()),"project":project,"parent":parent})
        }
        Op::Status { id } => json!({"op":"status","id":id}),
        Op::Answer { id, text } => json!({"op":"answer","id":id,"text":text}),
        Op::Inbox { after } => json!({"op":"inbox","after":after}),
        Op::Projects => json!({"op":"projects"}),
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
        Op::Rpc { json } => serde_json::from_str(&json)?,
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

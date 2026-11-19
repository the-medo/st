use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
};

#[derive(Debug)]
pub struct Failure {
    pub status: u16,
    pub message: String,
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for Failure {}

#[derive(Clone)]
pub struct Client {
    path: PathBuf,
    cache: Arc<Mutex<Option<Value>>>,
}
impl Client {
    pub fn from_env() -> Option<Self> {
        std::env::var_os("STAPP_PLANNER_SOCKET").map(|path| Self {
            path: path.into(),
            cache: Default::default(),
        })
    }
    pub async fn request(&self, action: &str, args: Value, key: Option<String>) -> Result<Value> {
        let exchange = async {
            let mut socket = UnixStream::connect(&self.path)
                .await
                .context("Planner unavailable")?;
            let mut message = serde_json::to_vec(&json!({"action":action,"args":args,"key":key}))?;
            message.push(b'\n');
            socket.write_all(&message).await?;
            let mut line = String::new();
            let n = BufReader::new(socket)
                .take(4 * 1024 * 1024 + 1)
                .read_line(&mut line)
                .await?;
            anyhow::ensure!(n <= 4 * 1024 * 1024, "Planner response too large");
            let response: Value = serde_json::from_str(&line)?;
            if let Some(message) = response["error"].as_str() {
                return Err(Failure {
                    status: response["status"].as_u64().unwrap_or(500) as u16,
                    message: message.into(),
                }
                .into());
            }
            Ok(response["result"].clone())
        };
        match tokio::time::timeout(Duration::from_secs(12), exchange).await {
            Ok(result) => result,
            Err(_) => bail!("Planner timed out; retry with the same operation key"),
        }
    }
    pub async fn display(&self) -> Value {
        match self.request("list", json!({}), None).await {
            Ok(value) => {
                *self.cache.lock().unwrap() = Some(value.clone());
                value
            }
            Err(_) => {
                let mut value = self
                    .cache
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or(json!({"records":[],"projects":[]}));
                value["status"] = json!("unavailable");
                value
            }
        }
    }
}

use anyhow::{bail, Context, Result};
use serde_json::Value;
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
};

pub async fn request(message: &Value) -> Result<Value> {
    let script = std::env::var_os("STAPP_PHOTOS_SCRIPT")
        .map(PathBuf::from)
        .unwrap_or(std::env::current_exe()?.with_file_name("photos.py"));
    let exchange = async {
        let mut child =
            Command::new(std::env::var("STAPP_PYTHON").unwrap_or_else(|_| "python3".into()))
                .arg(script)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .context("Start Immich adapter")?;
        let mut input = child.stdin.take().context("Missing adapter input")?;
        input.write_all(&serde_json::to_vec(message)?).await?;
        drop(input);
        let mut data = Vec::new();
        child
            .stdout
            .take()
            .context("Missing adapter output")?
            .take(7_000_001)
            .read_to_end(&mut data)
            .await?;
        anyhow::ensure!(data.len() <= 7_000_000, "Immich response too large");
        anyhow::ensure!(child.wait().await?.success(), "Immich adapter failed");
        let reply: Value =
            serde_json::from_slice(&data).context("Invalid Immich adapter response")?;
        if let Some(error) = reply["error"].as_str() {
            bail!("{error}");
        }
        Ok(reply["result"].clone())
    };
    tokio::time::timeout(Duration::from_secs(30), exchange)
        .await
        .context("Immich timed out")?
}

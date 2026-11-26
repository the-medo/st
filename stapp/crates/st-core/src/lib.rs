use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    env,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Command, Stdio},
};

pub const MAX_LINE: usize = 8 * 1024 * 1024;
pub fn data_dir() -> PathBuf {
    env::var_os("STAPP_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env::var_os("HOME").unwrap_or_default()).join(".local/share/stapp")
        })
}
pub fn socket_path() -> PathBuf {
    env::var_os("STAPP_SOCKET")
        .map(PathBuf::from)
        .unwrap_or_else(|| data_dir().join("control.sock"))
}
pub fn field<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .with_context(|| format!("Missing {key}"))
}
pub fn safe_name(s: &str) -> Result<()> {
    if s.is_empty()
        || s.len() > 80
        || !s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        bail!("Expected a name of up to 80 letters, digits, dashes or underscores")
    }
    Ok(())
}
/// A bounded persistent SSH bridge. Each caller owns one serialized connection.
/// Failed calls are not replayed here: only callers with stable request IDs retry.
pub struct Client {
    host: Option<String>,
    device: String,
    child: Option<std::process::Child>,
    input: Option<std::process::ChildStdin>,
    replies: Option<std::sync::mpsc::Receiver<std::io::Result<String>>>,
}
impl Client {
    pub fn new(host: Option<&str>, device: &str) -> Self {
        Self {
            host: host.map(String::from),
            device: device.into(),
            child: None,
            input: None,
            replies: None,
        }
    }
    fn disconnect(&mut self) {
        self.input.take();
        self.replies.take();
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    fn connect(&mut self) -> Result<()> {
        let host = self.host.as_ref().context("Missing SSH host")?;
        anyhow::ensure!(
            !host.is_empty() && !host.starts_with('-'),
            "Invalid SSH alias"
        );
        let mut command = Command::new("ssh");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .args([
                "-T",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=5",
                "-o",
                "ServerAliveInterval=5",
                "-o",
                "ServerAliveCountMax=2",
                host,
                "stctl",
                "bridge",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()?;
        self.input = child.stdin.take();
        let output = child.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            use std::io::Read;
            let mut reader = BufReader::new(output);
            loop {
                let mut line = String::new();
                let result = (&mut reader).take(MAX_LINE as u64 + 1).read_line(&mut line);
                let value = match result {
                    Ok(n) if n > 0 && n <= MAX_LINE => Ok(line),
                    Ok(_) => Err(std::io::Error::other("Bridge closed or response too large")),
                    Err(e) => Err(e),
                };
                let failed = value.is_err();
                if tx.send(value).is_err() || failed {
                    break;
                }
            }
        });
        self.child = Some(child);
        self.replies = Some(rx);
        Ok(())
    }
    pub fn exchange(&mut self, req: &Value) -> Result<Value> {
        let result = self.call(req);
        if result.is_err() {
            self.disconnect();
        }
        result
    }
    fn call(&mut self, req: &Value) -> Result<Value> {
        #[cfg(unix)]
        use std::io::Read;
        use std::time::Duration;
        let mut msg = req.clone();
        msg["device"] = json!(self.device);
        let mut line = serde_json::to_vec(&msg)?;
        line.push(b'\n');
        anyhow::ensure!(line.len() <= MAX_LINE, "Request too large");
        let reply: String;
        if self.host.is_some() {
            if self.child.is_none() {
                self.connect()?;
            }
            self.input.as_mut().unwrap().write_all(&line)?;
            self.input.as_mut().unwrap().flush()?;
            reply = self
                .replies
                .as_ref()
                .unwrap()
                .recv_timeout(Duration::from_secs(20))
                .context("SSH bridge response timed out")??;
        } else {
            #[cfg(unix)]
            {
                let mut stream = std::os::unix::net::UnixStream::connect(socket_path())
                    .context("Connect to STapp socket")?;
                stream.set_read_timeout(Some(Duration::from_secs(20)))?;
                stream.set_write_timeout(Some(Duration::from_secs(20)))?;
                stream.write_all(&line)?;
                let mut received = String::new();
                BufReader::new(stream)
                    .take(MAX_LINE as u64 + 1)
                    .read_line(&mut received)?;
                reply = received;
                anyhow::ensure!(reply.len() <= MAX_LINE, "Response too large");
            }
            #[cfg(not(unix))]
            bail!("Configure an SSH host for this device");
        }
        let response: Value = serde_json::from_str(&reply).context("Invalid STapp response")?;
        if let Some(e) = response["error"].as_str() {
            bail!("{e}")
        }
        Ok(response["result"].clone())
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        self.disconnect();
    }
}
pub fn exchange(req: &Value, ssh: Option<&str>, device: &str) -> Result<Value> {
    Client::new(ssh, device).exchange(req)
}

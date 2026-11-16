use std::{env, io::{BufRead,BufReader,Write}, path::PathBuf,process::{Command,Stdio}};
use anyhow::{bail,Context,Result};
use serde_json::{json,Value};

pub const MAX_LINE: usize = 8 * 1024 * 1024;
pub fn data_dir() -> PathBuf {
    env::var_os("STAPP_DATA").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(env::var_os("HOME").unwrap_or_default()).join(".local/share/stapp"))
}
pub fn socket_path() -> PathBuf {
    env::var_os("STAPP_SOCKET").map(PathBuf::from).unwrap_or_else(|| data_dir().join("control.sock"))
}
pub fn field<'a>(v:&'a Value,key:&str)->Result<&'a str>{
    v[key].as_str().filter(|s|!s.trim().is_empty()).with_context(||format!("Missing {key}"))
}
pub fn safe_name(s:&str)->Result<()> {
    if s.is_empty() || s.len()>80 || !s.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_'){bail!("Expected a name of up to 80 letters, digits, dashes or underscores")} Ok(())
}
pub fn exchange(req:&Value, ssh:Option<&str>, device:&str)->Result<Value>{
    let mut msg=req.clone();
    msg["device"]=json!(device);
    let mut line=serde_json::to_vec(&msg)?;line.push(b'\n');
    let mut reply=String::new();
    if let Some(host)=ssh {
        if host.is_empty() || host.starts_with('-'){bail!("Invalid SSH alias")}
        // Device identity is assigned by the server's forced command.
        let mut child=Command::new("ssh").args(["-T","-o","BatchMode=yes","-o","ConnectTimeout=5",host,"stctl","bridge"]).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn()?;
        child.stdin.take().unwrap().write_all(&line)?;
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut reply)?;
        if !child.wait()?.success(){bail!("SSH connection failed")}
    } else {
        #[cfg(unix)] {
            let mut stream=std::os::unix::net::UnixStream::connect(socket_path()).context("Connect to STapp socket")?;
            stream.write_all(&line)?;BufReader::new(stream).read_line(&mut reply)?;
        }
        #[cfg(not(unix))] bail!("Configure an SSH host for this device");
    }
    let response:Value=serde_json::from_str(&reply).context("Invalid STapp response")?;
    if let Some(e)=response["error"].as_str(){bail!("{e}")}
    Ok(response["result"].clone())
}

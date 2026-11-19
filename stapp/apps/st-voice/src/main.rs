#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]
use anyhow::{anyhow, bail, Context, Result};
use clap::Parser;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde_json::{json, Value};
use st_core::exchange;
use std::{
    env,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::mpsc::{sync_channel, SyncSender},
    thread,
};
#[derive(Parser)]
struct Args {
    #[arg(long, env = "STAPP_SSH")]
    ssh: Option<String>,
    #[arg(long, env = "STAPP_DEVICE", default_value = "pc")]
    device: String,
    #[arg(long, env = "STAPP_MIC")]
    mic: Option<String>,
    #[arg(long, env = "STAPP_SPEECH_PYTHON", default_value = "python")]
    python: String,
    #[arg(long, env = "STAPP_SPEECH_SCRIPT")]
    script: Option<PathBuf>,
    #[arg(long)]
    list: bool,
}
fn input<T: cpal::SizedSample + cpal::Sample>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    tx: SyncSender<Vec<u8>>,
) -> Result<cpal::Stream>
where
    f32: cpal::FromSample<T>,
{
    let channels = usize::from(config.channels);
    let rate = config.sample_rate.0;
    anyhow::ensure!(rate >= 16000, "Microphone must support at least 16 kHz");
    let (mut phase, mut count, mut sum) = (0u32, 0u32, 0f32);
    let stream = device.build_input_stream(
        config,
        move |samples: &[T], _| {
            let mut out = Vec::with_capacity(2 * samples.len() / channels);
            for frame in samples.chunks_exact(channels) {
                sum += frame.iter().map(|x| x.to_sample::<f32>()).sum::<f32>() / channels as f32;
                count += 1;
                phase += 16000;
                if phase >= rate {
                    phase -= rate;
                    let val = ((sum / count as f32).clamp(-1., 1.) * 32767.) as i16;
                    out.extend_from_slice(&val.to_le_bytes());
                    count = 0;
                    sum = 0.;
                }
            }
            if !out.is_empty() {
                let _ = tx.try_send(out);
            }
        },
        |e| {
            eprintln!("Microphone disconnected: {e}");
            std::process::exit(2)
        },
        None,
    )?;
    Ok(stream)
}
fn main() -> Result<()> {
    let opts = Args::parse();
    let host = cpal::default_host();
    if opts.list {
        for d in host.input_devices()? {
            println!("{}", d.name()?)
        }
        return Ok(());
    }
    let device = match opts.mic.as_ref() {
        Some(name) => host
            .input_devices()?
            .find(|d| d.name().ok().as_ref() == Some(name)),
        None => host.default_input_device(),
    }
    .context("Selected microphone unavailable")?;
    let cfg = device.default_input_config()?;
    let format = cfg.sample_format();
    let config = cfg.into();
    let (tx, rx) = sync_channel(100);
    let stream = match format {
        cpal::SampleFormat::F32 => input::<f32>(&device, &config, tx)?,
        cpal::SampleFormat::I16 => input::<i16>(&device, &config, tx)?,
        cpal::SampleFormat::U16 => input::<u16>(&device, &config, tx)?,
        cpal::SampleFormat::I32 => input::<i32>(&device, &config, tx)?,
        _ => bail!("Unsupported input format {format}"),
    };
    let script = opts
        .script
        .unwrap_or(env::current_exe()?.parent().unwrap().join("speech.py"));
    let mut command = Command::new(&opts.python);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut helper = command
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .context("Start speech runtime")?;
    let mut sink = helper.stdin.take().unwrap();
    thread::spawn(move || {
        for chunk in rx {
            if sink.write_all(&chunk).is_err() {
                break;
            }
        }
    });
    stream.play()?;
    let mut claim = None;
    for line in BufReader::new(helper.stdout.take().unwrap()).lines() {
        let event: Value = serde_json::from_str(&line?)?;
        if event["event"] == "wake" {
            let id = uuid::Uuid::new_v4().to_string();
            claim = match exchange(
                &json!({"op":"wake","id":id}),
                opts.ssh.as_deref(),
                &opts.device,
            ) {
                Ok(v) if v["accepted"] == true => Some(id),
                _ => None,
            };
        } else if event["event"] == "text" {
            if let (Some(id), Some(text)) = (claim.take(), event["text"].as_str()) {
                if !text.trim().is_empty() {
                    let req = json!({"op":"ask","wake":id,"id":id,"text":text});
                    if exchange(&req, opts.ssh.as_deref(), &opts.device).is_err() {
                        thread::sleep(std::time::Duration::from_millis(300));
                        if let Err(e) = exchange(&req, opts.ssh.as_deref(), &opts.device) {
                            eprintln!("Unable to submit command: {e}")
                        }
                    }
                }
            }
        }
    }
    Err(anyhow!("Speech runtime exited: {}", helper.wait()?))
}

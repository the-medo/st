#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]
mod output;
mod ui;
use anyhow::{Context, Result};
use clap::Parser;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde_json::{json, Value};
use st_audio::{Engine, Event, Resampler, Transcriber};
use st_core::{exchange, Client};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
        mpsc::{sync_channel, SyncSender},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Parser, Clone)]
struct Args {
    #[arg(long, env = "STAPP_SSH")]
    ssh: Option<String>,
    #[arg(long, env = "STAPP_DEVICE", default_value = "room")]
    device: String,
    #[arg(long, env = "STAPP_MIC")]
    mic: Option<String>,
    #[arg(long, env = "STAPP_SPEAKER")]
    speaker: Option<String>,
    #[arg(long, env = "STAPP_MODELS")]
    models: Option<PathBuf>,
    #[arg(long, env = "STAPP_CLIENT_STATE")]
    state: Option<PathBuf>,
    #[arg(long, env = "STAPP_LANGUAGE", default_value = "")]
    language: String,
    #[arg(long)]
    list: bool,
    #[arg(long)]
    record_once: bool,
    /// Run wake/VAD on a WAV fixture without a microphone or network.
    #[arg(long)]
    check_audio: Option<PathBuf>,
    #[arg(long)]
    transcribe: Option<PathBuf>,
    #[arg(long)]
    synthesize: Option<String>,
    #[arg(long)]
    output: Option<PathBuf>,
    #[arg(long)]
    control: Option<String>,
    #[arg(long)]
    config: Option<PathBuf>,
}
fn atomic_write(path: &Path, value: &str) -> Result<()> {
    let tmp = path.with_extension("new");
    std::fs::write(&tmp, value)?;
    std::fs::rename(tmp, path)?;
    Ok(())
}
fn input<T: cpal::SizedSample + cpal::Sample>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    tx: SyncSender<Vec<f32>>,
    lost: Arc<AtomicU64>,
    failed: Arc<AtomicBool>,
    suspended: Arc<AtomicU8>,
) -> Result<cpal::Stream>
where
    f32: cpal::FromSample<T>,
{
    let channels = config.channels as usize;
    Ok(device.build_input_stream(
        config,
        move |samples: &[T], _| {
            if suspended.load(Ordering::Relaxed) != 0 {
                return;
            }
            let mono = samples
                .chunks_exact(channels)
                .map(|f| f.iter().map(|x| x.to_sample::<f32>()).sum::<f32>() / channels as f32)
                .collect();
            if tx.try_send(mono).is_err() {
                lost.fetch_add(1, Ordering::Relaxed);
            }
        },
        move |_| {
            failed.store(true, Ordering::Relaxed);
        },
        None,
    )?)
}
fn deliver(args: Args, state: PathBuf, suspended: Arc<AtomicU8>, stage: Arc<AtomicU8>) {
    let mut client = Client::new(args.ssh.as_deref(), &args.device);
    let cursor = state.join("cursor");
    let mut after = std::fs::read_to_string(&cursor)
        .ok()
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);
    let mut voice = None;
    let mut used = Instant::now();
    loop {
        if state.join("quit").exists() {
            return;
        }
        if used.elapsed() > Duration::from_secs(300) {
            voice = None;
        }
        match client.exchange(&json!({"op":"inbox","after":after})) {
            Ok(events) => {
                let _ = std::fs::remove_file(state.join("delivery-error.txt"));
                for event in events.as_array().into_iter().flatten() {
                    let seq = event["seq"].as_i64().unwrap_or(after);
                    let kind = event["kind"].as_str().unwrap_or("");
                    // Routing and accepted events are metadata, not a second acknowledgement.
                    if matches!(
                        kind,
                        "acknowledged"
                            | "question"
                            | "completed"
                            | "failed"
                            | "interrupted"
                            | "cancelled"
                    ) {
                        let _ = atomic_write(&state.join("last-result.json"), &event.to_string());
                        let text = event["payload"]["speech_text"]
                            .as_str()
                            .or_else(|| event["text"].as_str())
                            .unwrap_or("");
                        // Persist before playback: at-most-once speech across restart. A crash
                        // can skip audio, while the complete durable text remains available.
                        if atomic_write(&cursor, &seq.to_string()).is_err() {
                            break;
                        }
                        after = seq;
                        if !text.is_empty() && !state.join("muted").exists() {
                            while matches!(stage.load(Ordering::Relaxed), 1 | 2)
                                && !state.join("quit").exists()
                            {
                                thread::sleep(Duration::from_millis(100));
                            }
                            let _ = std::fs::remove_file(state.join("stop-speech"));
                            suspended.fetch_or(1, Ordering::Relaxed);
                            let _ = std::fs::write(state.join("speaking"), "");
                            let result = (|| -> Result<()> {
                                if voice.is_none() {
                                    voice =
                                        Some(output::Speaker::new(args.models.as_ref().unwrap())?);
                                }
                                let speech = if text.split_whitespace().count() > 60 {
                                    "Please check the full response in your conversation."
                                } else {
                                    text
                                };
                                let audio = voice.as_ref().unwrap().synthesize(speech)?;
                                output::play(
                                    audio.samples().to_vec(),
                                    audio.sample_rate() as u32,
                                    args.speaker.as_deref(),
                                    &state.join("stop-speech"),
                                )
                            })();
                            if let Err(e) = result {
                                let _ =
                                    atomic_write(&state.join("speech-error.txt"), &e.to_string());
                            }
                            let _ = std::fs::remove_file(state.join("speaking"));
                            suspended.fetch_and(!1, Ordering::Relaxed);
                            used = Instant::now();
                        }
                    } else {
                        after = seq;
                        let _ = atomic_write(&cursor, &after.to_string());
                    }
                }
            }
            Err(e) => {
                let _ = atomic_write(&state.join("delivery-error.txt"), &e.to_string());
            }
        }
        thread::sleep(Duration::from_millis(700));
    }
}
fn submit_outbox(args: Args, state: PathBuf) {
    let mut client = Client::new(args.ssh.as_deref(), &args.device);
    loop {
        if state.join("quit").exists() {
            return;
        }
        let mut files: Vec<_> = std::fs::read_dir(state.join("outbox"))
            .into_iter()
            .flatten()
            .filter_map(|x| x.ok())
            .map(|x| x.path())
            .filter(|p| p.extension().is_some_and(|e| e == "json"))
            .collect();
        files.sort();
        for path in files {
            let request = std::fs::read_to_string(&path)
                .ok()
                .and_then(|v| serde_json::from_str::<Value>(&v).ok());
            if let Some(req) = request {
                match client.exchange(&req) {
                    Ok(result) => {
                        let _ = atomic_write(&state.join("last-request.json"), &result.to_string());
                        let _ = std::fs::remove_file(state.join("submission-error.txt"));
                        let _ = std::fs::remove_file(path);
                    }
                    Err(e) => {
                        let _ = atomic_write(&state.join("submission-error.txt"), &e.to_string());
                        if e.to_string().contains("Wake claim expired") {
                            let _ = client.exchange(&json!({"op":"wake","id":req["id"]}));
                        }
                        break;
                    }
                }
            }
        }
        thread::sleep(Duration::from_secs(2));
    }
}
fn release(claim: &mut Option<String>, client: &mut Client) {
    if let Some(id) = claim.take() {
        let _ = client.exchange(&json!({"op":"release_wake","id":id}));
    }
}
fn listen(
    args: &Args,
    state: &Path,
    stage: &AtomicU8,
    suspended: Arc<AtomicU8>,
    engine: &mut Engine,
    asr: &mut Transcriber,
) -> Result<()> {
    let mut client = Client::new(args.ssh.as_deref(), &args.device);
    let host = cpal::default_host();
    let device = match args.mic.as_ref() {
        Some(name) => host
            .input_devices()?
            .find(|d| d.name().ok().as_ref() == Some(name)),
        None => host.default_input_device(),
    }
    .context("Selected microphone unavailable")?;
    let supported = device.default_input_config()?;
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let (tx, rx) = sync_channel(100);
    let lost = Arc::new(AtomicU64::new(0));
    let failed = Arc::new(AtomicBool::new(false));
    let stream = match format {
        cpal::SampleFormat::F32 => input::<f32>(
            &device,
            &config,
            tx,
            lost.clone(),
            failed.clone(),
            suspended.clone(),
        )?,
        cpal::SampleFormat::I16 => input::<i16>(
            &device,
            &config,
            tx,
            lost.clone(),
            failed.clone(),
            suspended.clone(),
        )?,
        cpal::SampleFormat::U16 => input::<u16>(
            &device,
            &config,
            tx,
            lost.clone(),
            failed.clone(),
            suspended.clone(),
        )?,
        cpal::SampleFormat::I32 => input::<i32>(
            &device,
            &config,
            tx,
            lost.clone(),
            failed.clone(),
            suspended.clone(),
        )?,
        _ => anyhow::bail!("Unsupported microphone format"),
    };
    let mut resampler = Resampler::new(config.sample_rate.0);
    let mut claim = None;
    let mut dropped = 0;
    let mut was_suspended = false;
    stream.play()?;
    if args.record_once {
        engine.start();
        claim = Some(uuid::Uuid::new_v4().to_string());
        stage.store(1, Ordering::Relaxed);
    }
    loop {
        if state.join("quit").exists() {
            release(&mut claim, &mut client);
            return Ok(());
        }
        if failed.load(Ordering::Relaxed) {
            release(&mut claim, &mut client);
            anyhow::bail!("Microphone disconnected; reopening");
        }
        let paused = suspended.load(Ordering::Relaxed) != 0 || state.join("muted").exists();
        if paused || was_suspended {
            engine.reset();
            release(&mut claim, &mut client);
            while rx.try_recv().is_ok() {}
            was_suspended = paused;
            stage.store(0, Ordering::Relaxed);
            thread::sleep(Duration::from_millis(50));
            continue;
        }
        if state.join("stop").exists() {
            engine.reset();
            release(&mut claim, &mut client);
            let _ = std::fs::remove_file(state.join("stop"));
            stage.store(0, Ordering::Relaxed);
        }
        let count = lost.load(Ordering::Relaxed);
        if count != dropped {
            dropped = count;
            engine.reset();
            release(&mut claim, &mut client);
            while rx.try_recv().is_ok() {}
            let _ = atomic_write(
                &state.join("capture-error.txt"),
                "Audio overflow; incomplete utterance discarded",
            );
        }
        let samples = match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(v) => v,
            Err(_) => {
                asr.unload_if_idle();
                continue;
            }
        };
        let audio = resampler.push(&samples);
        match engine.push(&audio) {
            Some(Event::Wake) => {
                let id = uuid::Uuid::new_v4().to_string();
                stage.store(1, Ordering::Relaxed);
                output::earcon(args.speaker.as_deref(), false, &state.join("stop-speech"));
                match client.exchange(&json!({"op":"wake","id":id})) {
                    Ok(v) if v["accepted"] == true => claim = Some(id),
                    _ => {
                        engine.reset();
                        stage.store(0, Ordering::Relaxed);
                    }
                }
            }
            Some(Event::Dictation(audio)) | Some(Event::Limit(audio)) => {
                if let Some(id) = claim.take() {
                    output::earcon(args.speaker.as_deref(), true, &state.join("stop-speech"));
                    stage.store(2, Ordering::Relaxed);
                    suspended.fetch_or(2, Ordering::Relaxed);
                    let text = asr.transcribe(&audio);
                    suspended.fetch_and(!2, Ordering::Relaxed);
                    while rx.try_recv().is_ok() {}
                    let text = text?;
                    if !text.trim().is_empty() {
                        let mut req = json!({"op":"ask","id":id,"text":text,"voice":true});
                        if let Some(rest) = text
                            .strip_prefix("Follow up:")
                            .or_else(|| text.strip_prefix("follow up "))
                            .or_else(|| text.strip_prefix("Follow up "))
                        {
                            if let Ok(previous) =
                                std::fs::read_to_string(state.join("last-result.json"))
                            {
                                if let Ok(value) = serde_json::from_str::<Value>(&previous) {
                                    if matches!(
                                        value["kind"].as_str(),
                                        Some("completed" | "failed" | "interrupted")
                                    ) {
                                        req["parent"] = value["id"].clone();
                                        req["text"] = json!(rest.trim());
                                    }
                                }
                            }
                        }
                        if !args.record_once {
                            req["wake"] = json!(id);
                        }
                        // Keep the same UUID and payload across transport retries.
                        let outbox = state.join("outbox");
                        std::fs::create_dir_all(&outbox)?;
                        let stamp = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)?
                            .as_millis();
                        let path = outbox.join(format!("{stamp}-{id}.json"));
                        atomic_write(&path, &req.to_string())?;
                        if args.record_once {
                            // Submission thread is disabled in one-shot mode; retain on failure.
                            let result = exchange(&req, args.ssh.as_deref(), &args.device)?;
                            atomic_write(&state.join("last-request.json"), &result.to_string())?;
                            std::fs::remove_file(path)?;
                        }
                        stage.store(3, Ordering::Relaxed);
                    }
                    if args.record_once {
                        return Ok(());
                    }
                }
                stage.store(0, Ordering::Relaxed);
            }
            Some(Event::Empty) => {
                release(&mut claim, &mut client);
                stage.store(0, Ordering::Relaxed);
            }
            None => {}
        }
        asr.unload_if_idle();
    }
}
fn main() -> Result<()> {
    // JSON config keeps Windows startup independent of a shell/environment wrapper.
    let first = Args::parse();
    if let Some(path) = first.config {
        let config: Value =
            serde_json::from_str(std::fs::read_to_string(path)?.trim_start_matches('\u{feff}'))?;
        for (k, v) in config.as_object().context("Invalid client config")? {
            if k.starts_with("STAPP_") {
                std::env::set_var(k, v.as_str().context("Expected string setting")?);
            }
        }
    }
    let mut args = Args::parse();
    if args.list {
        let host = cpal::default_host();
        for d in host.input_devices()? {
            println!("input: {}", d.name()?);
        }
        for d in host.output_devices()? {
            println!("output: {}", d.name()?);
        }
        return Ok(());
    }
    let base = PathBuf::from(
        std::env::var_os(if cfg!(windows) {
            "LOCALAPPDATA"
        } else {
            "HOME"
        })
        .context("Missing home directory")?,
    );
    let models = args
        .models
        .get_or_insert_with(|| {
            if cfg!(windows) {
                base.join("STapp/models")
            } else {
                base.join(".cache/stapp/models")
            }
        })
        .clone();
    let state = args.state.clone().unwrap_or_else(|| {
        if cfg!(windows) {
            base.join("STapp/state")
        } else {
            base.join(".local/share/stapp-room")
        }
    });
    std::fs::create_dir_all(&state)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o700))?;
    }
    if let Some(command) = &args.control {
        match command.as_str() {
            "mute" | "stop" | "quit" => {
                let file = if command == "mute" { "muted" } else { command };
                std::fs::write(state.join(file), "")?;
                if command == "stop" || command == "mute" || command == "quit" {
                    std::fs::write(state.join("stop-speech"), "")?;
                }
                if command == "stop" {
                    if let Ok(previous) = std::fs::read_to_string(state.join("last-request.json")) {
                        let value: Value = serde_json::from_str(&previous)?;
                        exchange(
                            &json!({"op":"cancel","id":value["id"]}),
                            args.ssh.as_deref(),
                            &args.device,
                        )?;
                    }
                }
            }
            "unmute" => {
                let _ = std::fs::remove_file(state.join("muted"));
            }
            _ => anyhow::bail!("Use mute, unmute, stop or quit"),
        };
        return Ok(());
    }
    if let Some(path) = &args.check_audio {
        let wave =
            sherpa_onnx::Wave::read(path.to_str().context("WAV path")?).context("Read WAV")?;
        let mut r = Resampler::new(wave.sample_rate() as u32);
        let mut audio = r.push(wave.samples());
        audio.extend(vec![0.; 6 * st_audio::RATE]);
        let mut engine = Engine::new(&models)?;
        let mut asr = Transcriber::new(&models, &args.language);
        let mut wakes = 0;
        for chunk in audio.chunks(512) {
            match engine.push(chunk) {
                Some(Event::Wake) => {
                    wakes += 1;
                    println!("wake");
                }
                Some(Event::Dictation(samples)) | Some(Event::Limit(samples)) => {
                    println!("transcript: {}", asr.transcribe(&samples)?)
                }
                Some(Event::Empty) => println!("empty"),
                None => {}
            }
        }
        println!("wake_count: {wakes}");
        return Ok(());
    }
    if let Some(path) = args.transcribe {
        let wave =
            sherpa_onnx::Wave::read(path.to_str().context("WAV path")?).context("Read WAV")?;
        let mut r = Resampler::new(wave.sample_rate() as u32);
        let audio = r.push(wave.samples());
        println!(
            "{}",
            Transcriber::new(&models, &args.language).transcribe(&audio)?
        );
        return Ok(());
    }
    if let Some(text) = args.synthesize {
        let speaker = output::Speaker::new(&models)?;
        let audio = speaker.synthesize(&text)?;
        anyhow::ensure!(
            audio.save(
                args.output
                    .context("Use --output WAV")?
                    .to_str()
                    .context("Output path")?
            ),
            "Save WAV"
        );
        return Ok(());
    }
    // OS file lock releases on crashes and prevents duplicate listeners.
    use fs2::FileExt;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(state.join("listener.lock"))?;
    lock.try_lock_exclusive()
        .context("An ST voice listener is already running")?;
    let _ = std::fs::remove_file(state.join("quit"));
    let _ = std::fs::remove_file(state.join("speaking"));
    let stage = Arc::new(AtomicU8::new(0));
    let ui_stage = stage.clone();
    thread::spawn(move || ui::run(ui_stage));
    let suspended = Arc::new(AtomicU8::new(0));
    let delivery_args = args.clone();
    let delivery_state = state.clone();
    let delivery_pause = suspended.clone();
    let delivery_stage = stage.clone();
    thread::spawn(move || {
        deliver(
            delivery_args,
            delivery_state,
            delivery_pause,
            delivery_stage,
        )
    });
    let send_args = args.clone();
    let send_state = state.clone();
    if !args.record_once {
        thread::spawn(move || submit_outbox(send_args, send_state));
    }
    let status_state = state.clone();
    let status_stage = stage.clone();
    thread::spawn(move || {
        while status_stage.load(Ordering::Relaxed) != 255 {
            let v = status_stage.load(Ordering::Relaxed);
            let name = match v {
                1 => "listening",
                2 => "transcribing",
                3 => "submitted",
                4 => "offline",
                _ => "idle",
            };
            let _=atomic_write(&status_state.join("status.json"), &json!({"state":name,"muted":status_state.join("muted").exists(),"speaking":status_state.join("speaking").exists()}).to_string());
            thread::sleep(Duration::from_millis(500));
        }
    });
    let mut engine = Engine::new(&models)?;
    let mut asr = Transcriber::new(&models, &args.language);
    loop {
        match listen(
            &args,
            &state,
            &stage,
            suspended.clone(),
            &mut engine,
            &mut asr,
        ) {
            Ok(()) => break,
            Err(e) => {
                if args.record_once {
                    return Err(e);
                }
                stage.store(4, Ordering::Relaxed);
                atomic_write(&state.join("capture-error.txt"), &e.to_string())?;
                engine.reset();
                thread::sleep(Duration::from_secs(2));
            }
        }
    }
    stage.store(255, Ordering::Relaxed);
    Ok(())
}

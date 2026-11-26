use super::*;

pub fn configured(args: &Args, state: &Path) -> Args {
    let mut args = args.clone();
    if let Ok(raw) = std::fs::read_to_string(state.join("remote-settings.json")) {
        if let Ok(value) = serde_json::from_str::<Value>(&raw) {
            for (key, target) in [
                ("microphone", &mut args.mic),
                ("speaker", &mut args.speaker),
            ] {
                if let Some(name) = value["settings"][key].as_str() {
                    *target = if name.is_empty() {
                        None
                    } else {
                        Some(name.to_owned())
                    };
                }
            }
        }
    }
    args
}

fn read_json(path: &Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null)
}

pub fn run(args: Args, state: PathBuf, stage: Arc<AtomicU8>, suspended: Arc<AtomicU8>) {
    let mut client = Client::new(args.ssh.as_deref(), &args.device);
    let receipts = state.join("command-receipts");
    let _ = std::fs::create_dir_all(&receipts);
    let mut devices = json!({"inputs":[],"outputs":[]});
    let mut enumerated = Instant::now() - Duration::from_secs(60);
    while stage.load(Ordering::Relaxed) != 255 {
        if enumerated.elapsed() >= Duration::from_secs(30) {
            let host = cpal::default_host();
            let inputs: Vec<_> = host
                .input_devices()
                .into_iter()
                .flatten()
                .filter_map(|d| d.name().ok())
                .collect();
            let outputs: Vec<_> = host
                .output_devices()
                .into_iter()
                .flatten()
                .filter_map(|d| d.name().ok())
                .collect();
            devices = json!({"inputs":inputs,"outputs":outputs});
            enumerated = Instant::now();
        }
        let current = configured(&args, &state);
        let remote = read_json(&state.join("remote-settings.json"));
        let queue = std::fs::read_dir(state.join("outbox"))
            .into_iter()
            .flatten()
            .flatten()
            .filter(|f| f.path().extension().is_some_and(|e| e == "json"))
            .count();
        let errors: Vec<_> = ["capture-error.txt","speech-error.txt","delivery-error.txt","submission-error.txt"]
            .iter().filter_map(|name|std::fs::read_to_string(state.join(name)).ok().map(|text|json!({"source":name.trim_end_matches("-error.txt"),"message":text.chars().take(1000).collect::<String>()}))).collect();
        let report = json!({"state": match stage.load(Ordering::Relaxed) {1=>"listening",2=>"transcribing",3=>"submitted",4=>"offline",_=>"idle"},
            "muted":state.join("muted").exists(),"speaking":state.join("speaking").exists(),"queue":queue,
            "inputs":devices["inputs"],"outputs":devices["outputs"],"microphone":current.mic,"speaker":current.speaker,
            "revision":remote["revision"].as_i64().unwrap_or(0),"errors":errors,
            "test_recording":read_json(&state.join("test-recording.json")),"version":env!("CARGO_PKG_VERSION")});
        let _ = atomic_write(&state.join("status.json"), &report.to_string());
        let acks: Vec<_> = std::fs::read_dir(&receipts)
            .into_iter()
            .flatten()
            .flatten()
            .take(20)
            .map(|f| read_json(&f.path()))
            .filter(|v| v.is_object())
            .collect();
        match client.exchange(&json!({"op":"voice_sync","report":report,"acks":acks})) {
            Ok(reply) => {
                for ack in &acks {
                    if let Some(id) = ack["id"].as_str() {
                        let _ = std::fs::remove_file(receipts.join(id));
                    }
                }
                let _ = std::fs::remove_file(state.join("management-error.txt"));
                let revision = reply["revision"].as_i64().unwrap_or(0);
                if revision != remote["revision"].as_i64().unwrap_or(0) {
                    let before = configured(&args, &state);
                    if atomic_write(
                        &state.join("remote-settings.json"),
                        &json!({"revision":revision,"settings":reply["settings"]}).to_string(),
                    )
                    .is_ok()
                    {
                        if let Some(muted) = reply["settings"]["muted"].as_bool() {
                            let _ = control(&args, &state, if muted { "mute" } else { "unmute" });
                        }
                        let after = configured(&args, &state);
                        if before.mic != after.mic || before.speaker != after.speaker {
                            let _ = std::fs::write(state.join("reload"), "");
                        }
                    }
                }
                for command in reply["commands"].as_array().into_iter().flatten() {
                    let Some(id) = command["id"]
                        .as_str()
                        .filter(|s| uuid::Uuid::parse_str(s).is_ok())
                    else {
                        continue;
                    };
                    let done = state.join("commands-done");
                    let _ = std::fs::create_dir_all(&done);
                    if done.join(id).exists() {
                        let _=atomic_write(&receipts.join(id),&json!({"id":id,"result":{"status":"interrupted","message":"Command was already accepted; it will not be replayed."}}).to_string());
                        continue;
                    }
                    // Durable at-most-once recording: never reopen a mic after a lost acknowledgement.
                    if std::fs::write(done.join(id), "").is_err() {
                        continue;
                    }
                    let action = command["action"].as_str().unwrap_or("");
                    let result = (|| -> Result<&str> {
                        match action {
                            "stop" => {
                                control(&args, &state, "stop")?;
                                Ok("Stopped")
                            }
                            "record" | "test_recording" => {
                                anyhow::ensure!(
                                    stage.load(Ordering::Relaxed) == 0
                                        && !state.join("muted").exists()
                                        && suspended.load(Ordering::Relaxed) == 0
                                        && !state.join("capture-command.json").exists(),
                                    "The microphone is muted, unavailable or busy"
                                );
                                atomic_write(
                                    &state.join("capture-command.json"),
                                    &command.to_string(),
                                )?;
                                Ok("Recording requested")
                            }
                            "test_speaker" => {
                                anyhow::ensure!(
                                    matches!(stage.load(Ordering::Relaxed), 0 | 4)
                                        && suspended.load(Ordering::Relaxed) == 0,
                                    "Audio is busy"
                                );
                                anyhow::ensure!(
                                    suspended
                                        .compare_exchange(0, 4, Ordering::SeqCst, Ordering::Relaxed)
                                        .is_ok(),
                                    "Audio became busy"
                                );
                                let played = (|| -> Result<()> {
                                    let speaker = output::Speaker::new(
                                        current
                                            .models
                                            .as_ref()
                                            .context("Speech models unavailable")?,
                                    )?;
                                    let audio = speaker
                                        .synthesize("This is your S T assistant speaker test.")?;
                                    let _ = std::fs::remove_file(state.join("stop-speech"));
                                    output::play(
                                        audio.samples().to_vec(),
                                        audio.sample_rate() as u32,
                                        current.speaker.as_deref(),
                                        &state.join("stop-speech"),
                                    )
                                })();
                                suspended.fetch_and(!4, Ordering::Relaxed);
                                played?;
                                Ok("Speaker test played")
                            }
                            _ => anyhow::bail!("Unknown command"),
                        }
                    })();
                    let result = match result {
                        Ok(message) => json!({"status":"accepted","message":message}),
                        Err(e) => json!({"status":"failed","message":e.to_string()}),
                    };
                    let _ = atomic_write(
                        &receipts.join(id),
                        &json!({"id":id,"result":result}).to_string(),
                    );
                }
            }
            Err(e) => {
                let _ = atomic_write(&state.join("management-error.txt"), &e.to_string());
            }
        }
        thread::sleep(Duration::from_secs(2));
    }
}

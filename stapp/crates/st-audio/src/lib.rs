//! Shared native wake/VAD/ASR state machine. Audio never leaves the endpoint.
use anyhow::{Context, Result};
use sherpa_onnx::{
    KeywordSpotter, KeywordSpotterConfig, OfflineRecognizer, OfflineRecognizerConfig, OnlineStream,
    VadModelConfig, VoiceActivityDetector,
};
use std::{
    collections::VecDeque,
    path::Path,
    time::{Duration, Instant},
};

pub const RATE: usize = 16_000;
#[derive(Debug)]
pub enum Event {
    Wake,
    Dictation(Vec<f32>),
    Empty,
    Limit(Vec<f32>),
}

/// Streaming windowed-sinc low-pass resampling. State crosses callback boundaries.
/// A fixed 32-tap filter prevents the aliasing of simple sample decimation.
pub struct Resampler {
    input_rate: f64,
    next: f64,
    base: i64,
    samples: VecDeque<f32>,
}
impl Resampler {
    pub fn new(rate: u32) -> Self {
        Self {
            input_rate: rate as f64,
            next: 16.,
            base: 0,
            samples: VecDeque::new(),
        }
    }
    pub fn push(&mut self, input: &[f32]) -> Vec<f32> {
        self.samples.extend(input);
        let ratio = RATE as f64 / self.input_rate;
        let cutoff = ratio.min(1.) * 0.9;
        let mut output = Vec::new();
        while self.next + 16. < (self.base + self.samples.len() as i64) as f64 {
            let center = self.next.floor() as i64;
            let mut total = 0.;
            let mut weight = 0.;
            for i in center - 15..=center + 16 {
                let x = i as f64 - self.next;
                let sinc = if x.abs() < 1e-9 {
                    cutoff
                } else {
                    (std::f64::consts::PI * x * cutoff).sin() / (std::f64::consts::PI * x)
                };
                let window = 0.5 + 0.5 * (std::f64::consts::PI * x / 16.).cos();
                let w = sinc * window;
                if let Some(v) = self.samples.get((i - self.base) as usize) {
                    total += *v as f64 * w;
                    weight += w;
                }
            }
            output.push((total / weight.max(1e-9)) as f32);
            self.next += 1. / ratio;
            let discard = (self.next.floor() as i64 - 16 - self.base).max(0) as usize;
            for _ in 0..discard.min(self.samples.len()) {
                self.samples.pop_front();
                self.base += 1;
            }
        }
        output
    }
}

pub struct Engine {
    kws: KeywordSpotter,
    stream: OnlineStream,
    vad: VoiceActivityDetector,
    pre: VecDeque<f32>,
    active: Option<Vec<f32>>,
    speech: bool,
    quiet: usize,
    max_samples: usize,
}
fn file(root: &Path, name: &str) -> Result<String> {
    let p = root.join(name);
    anyhow::ensure!(p.is_file(), "Missing speech model {}", p.display());
    Ok(p.to_string_lossy().into())
}
fn primed_stream(kws: &KeywordSpotter) -> OnlineStream {
    let stream = kws.create_stream();
    stream.accept_waveform(RATE as i32, &vec![0.; RATE]);
    while kws.is_ready(&stream) {
        kws.decode(&stream);
    }
    stream
}
impl Engine {
    pub fn new(root: &Path) -> Result<Self> {
        let folder = root.join("sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01");
        let mut c = KeywordSpotterConfig::default();
        let part = |prefix: &str| -> Result<String> {
            std::fs::read_dir(&folder)?
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .find(|p| {
                    let n = p.file_name().unwrap().to_string_lossy();
                    n.starts_with(prefix) && n.ends_with(".int8.onnx")
                })
                .map(|p| p.to_string_lossy().into_owned())
                .context("Missing keyword model")
        };
        c.model_config.transducer.encoder = Some(part("encoder")?);
        c.model_config.transducer.decoder = Some(part("decoder")?);
        c.model_config.transducer.joiner = Some(part("joiner")?);
        c.model_config.tokens = Some(file(&folder, "tokens.txt")?);
        c.model_config.num_threads = 1;
        c.model_config.provider = Some("cpu".into());
        c.keywords_file = Some(file(root, "st-keywords.txt")?);
        let kws = KeywordSpotter::create(&c).context("Initialize keyword spotter")?;
        let stream = primed_stream(&kws);
        let mut v = VadModelConfig::default();
        v.sample_rate = RATE as i32;
        v.num_threads = 1;
        v.provider = Some("cpu".into());
        v.silero_vad.model = Some(file(root, "silero_vad.onnx")?);
        v.silero_vad.threshold = 0.5;
        v.silero_vad.min_silence_duration = std::env::var("STAPP_ENDPOINT_SILENCE_MS")
            .ok()
            .and_then(|s| s.parse::<f32>().ok())
            .unwrap_or(700.)
            .clamp(200., 3000.)
            / 1000.;
        v.silero_vad.min_speech_duration = 0.2;
        v.silero_vad.window_size = 512;
        let max_seconds = std::env::var("STAPP_MAX_RECORDING_SECONDS")
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(120)
            .clamp(15, 300);
        v.silero_vad.max_speech_duration = max_seconds as f32;
        let vad =
            VoiceActivityDetector::create(&v, max_seconds as f32 + 5.).context("Initialize VAD")?;
        Ok(Self {
            kws,
            stream,
            vad,
            pre: VecDeque::new(),
            active: None,
            speech: false,
            quiet: 0,
            max_samples: max_seconds * RATE,
        })
    }
    pub fn reset(&mut self) {
        self.active = None;
        self.pre.clear();
        self.quiet = 0;
        self.speech = false;
        self.stream = primed_stream(&self.kws);
        self.vad.reset();
    }
    pub fn start(&mut self) {
        self.active = Some(self.pre.iter().copied().collect());
        self.speech = false;
        self.quiet = 0;
        self.vad.reset();
        if let Some(audio) = self.active.as_ref() {
            self.vad.accept_waveform(audio);
            self.speech = self.vad.detected();
        }
    }
    pub fn push(&mut self, samples: &[f32]) -> Option<Event> {
        if let Some(active) = self.active.as_mut() {
            active.extend_from_slice(samples);
            self.vad.accept_waveform(samples);
            if self.vad.detected() {
                self.speech = true;
                self.quiet = 0;
            } else {
                self.quiet += samples.len();
            }
            while !self.vad.is_empty() {
                self.vad.pop();
            }
            let limit = active.len() >= self.max_samples;
            let end = self.speech && self.quiet > RATE / 2;
            let empty = !self.speech && active.len() > 5 * RATE;
            if limit || end || empty {
                let audio = self.active.take().unwrap();
                self.reset();
                return Some(if empty {
                    Event::Empty
                } else if limit {
                    Event::Limit(audio)
                } else {
                    Event::Dictation(audio)
                });
            }
        } else {
            self.pre.extend(samples);
            while self.pre.len() > RATE * 2 {
                self.pre.pop_front();
            }
            self.stream.accept_waveform(RATE as i32, samples);
            while self.kws.is_ready(&self.stream) {
                self.kws.decode(&self.stream);
                if self
                    .kws
                    .get_result(&self.stream)
                    .is_some_and(|r| !r.keyword.is_empty())
                {
                    self.start();
                    return Some(Event::Wake);
                }
            }
        }
        None
    }
}

pub struct Transcriber {
    root: std::path::PathBuf,
    language: String,
    recognizer: Option<OfflineRecognizer>,
    used: Instant,
}
impl Transcriber {
    pub fn new(root: &Path, language: &str) -> Self {
        Self {
            root: root.into(),
            language: language.into(),
            recognizer: None,
            used: Instant::now(),
        }
    }
    pub fn unload_if_idle(&mut self) {
        if self.used.elapsed() > Duration::from_secs(300) {
            self.recognizer = None;
        }
    }
    pub fn transcribe(&mut self, audio: &[f32]) -> Result<String> {
        Ok(strip_wake(&self.transcribe_raw(audio)?))
    }
    pub fn transcribe_raw(&mut self, audio: &[f32]) -> Result<String> {
        if self.recognizer.is_none() {
            let root = self.root.join("sherpa-onnx-whisper-base");
            let mut c = OfflineRecognizerConfig::default();
            c.model_config.whisper.encoder = Some(file(&root, "base-encoder.int8.onnx")?);
            c.model_config.whisper.decoder = Some(file(&root, "base-decoder.int8.onnx")?);
            c.model_config.whisper.language = Some(self.language.clone());
            c.model_config.whisper.task = Some("transcribe".into());
            c.model_config.whisper.tail_paddings = -1;
            c.model_config.tokens = Some(file(&root, "base-tokens.txt")?);
            c.model_config.num_threads = 2;
            c.model_config.provider = Some("cpu".into());
            self.recognizer = Some(OfflineRecognizer::create(&c).context("Initialize Whisper")?);
        }
        self.used = Instant::now();
        let rec = self.recognizer.as_ref().unwrap();
        let mut words: Vec<String> = Vec::new();
        // Whisper has a 30s window: overlapping 25s chunks preserve long dictation.
        let mut start = 0;
        while start < audio.len() {
            let end = (start + 25 * RATE).min(audio.len());
            let stream = rec.create_stream();
            stream.accept_waveform(RATE as i32, &audio[start..end]);
            rec.decode(&stream);
            if let Some(result) = stream.get_result() {
                let next: Vec<String> = result.text.split_whitespace().map(String::from).collect();
                let overlap = (1..=words.len().min(next.len()).min(12))
                    .rev()
                    .find(|&n| {
                        words[words.len() - n..]
                            .iter()
                            .zip(&next[..n])
                            .all(|(a, b)| a.to_lowercase() == b.to_lowercase())
                    })
                    .unwrap_or(0);
                words.extend_from_slice(&next[overlap..]);
            }
            if end == audio.len() {
                break;
            }
            start = end - RATE;
        }
        Ok(words.join(" "))
    }
}
/// Confirm the wake phrase with full ASR before dispatch. A provisional KWS hit
/// such as "Hey Steve" may open capture, but must never execute that transcript.
pub fn confirmed_wake(text: &str) -> Option<String> {
    let mut words: Vec<(String, usize)> = Vec::new();
    let mut word = String::new();
    for (i, c) in text.char_indices() {
        if c.is_alphanumeric() {
            word.extend(c.to_lowercase());
        } else if !word.is_empty() {
            words.push((std::mem::take(&mut word), i));
        }
        if words.len() >= 4 {
            break;
        }
    }
    if !word.is_empty() {
        words.push((word, text.len()));
    }
    if !words
        .first()
        .is_some_and(|(w, _)| matches!(w.as_str(), "hey" | "okay" | "ok"))
    {
        return None;
    }
    let n = if words.get(1).is_some_and(|(w, _)| w == "st") {
        2
    } else if words
        .get(1)
        .zip(words.get(2))
        .is_some_and(|((a, _), (b, _))| (a == "s" && b == "t") || (a == "ess" && b == "tee"))
    {
        3
    } else {
        return None;
    };
    Some(
        text[words[n - 1].1..]
            .trim_start_matches(|c: char| c.is_whitespace() || ",.!?:;".contains(c))
            .to_string(),
    )
}
pub fn strip_wake(text: &str) -> String {
    confirmed_wake(text).unwrap_or_else(|| text.trim().to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resampling_keeps_time_across_chunks() {
        let mut r = Resampler::new(48000);
        let mut out = vec![];
        for _ in 0..100 {
            out.extend(r.push(&vec![0.25; 480]));
        }
        assert!((out.len() as i32 - 16000).abs() < 20);
        assert!(out.iter().all(|x| (*x - 0.25).abs() < 0.001));
    }
    #[test]
    fn wake_prefix_only() {
        assert_eq!(strip_wake("Okay ST, add a task"), "add a task");
        assert_eq!(
            strip_wake("Explain why I say hey ST"),
            "Explain why I say hey ST"
        );
        assert_eq!(strip_wake("hey strange"), "hey strange");
        assert_eq!(confirmed_wake("Hey Steve, delete my notes"), None);
        assert_eq!(
            confirmed_wake("Okay, S.T., list tasks"),
            Some("list tasks".into())
        );
    }
}

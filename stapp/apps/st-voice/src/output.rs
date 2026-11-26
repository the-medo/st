use anyhow::{Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use sherpa_onnx::{GenerationConfig, OfflineTts, OfflineTtsConfig};
use std::{
    ffi::{c_char, c_void, CStr, CString},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

pub struct Speaker {
    tts: OfflineTts,
    espeak: libloading::Library,
}
impl Speaker {
    pub fn new(root: &Path) -> Result<Self> {
        let base = std::env::var_os("STAPP_TTS_MODEL_DIRECTORY")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| root.join("vits-piper-en_US-lessac-medium"));
        let model = std::fs::read_dir(&base)?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .find(|p| p.extension().is_some_and(|e| e == "onnx"))
            .context("Missing Piper ONNX model")?;
        let metadata: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(model.with_extension("onnx.json"))?)?;
        let language = CString::new(metadata["espeak"]["voice"].as_str().unwrap_or("en-us"))?;
        let mut c = OfflineTtsConfig::default();
        c.model.vits.noise_scale = std::env::var("STAPP_TTS_NOISE_SCALE")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.667);
        c.model.vits.noise_scale_w = std::env::var("STAPP_TTS_NOISE_SCALE_W")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.8);
        c.model.num_threads = 2;
        c.model.provider = Some("cpu".into());
        c.max_num_sentences = 1;
        c.silence_scale = 1.;
        c.model.vits.model = Some(model.to_string_lossy().into());
        c.model.vits.tokens = Some(base.join("tokens.txt").to_string_lossy().into());
        let tts = OfflineTts::create(&c).context("Initialize Piper voice")?;
        let library = std::env::var("STAPP_ESPEAK_LIBRARY").unwrap_or_else(|_| {
            if cfg!(windows) {
                "libespeak-ng.dll".into()
            } else {
                "libespeak-ng.so.1".into()
            }
        });
        // eSpeak is used only on this speech thread. It returns IPA to the native
        // Piper/VITS runtime; neither a Python interpreter nor a synthesis subprocess runs.
        let espeak =
            unsafe { libloading::Library::new(library) }.context("Load eSpeak NG phonemizer")?;
        unsafe {
            let init: libloading::Symbol<
                unsafe extern "C" fn(i32, i32, *const c_char, i32) -> i32,
            > = espeak.get(b"espeak_Initialize\0")?;
            let path = CString::new(base.to_string_lossy().as_bytes())?;
            anyhow::ensure!(init(2, 0, path.as_ptr(), 0) > 0, "Initialize eSpeak data");
            let voice: libloading::Symbol<unsafe extern "C" fn(*const c_char) -> i32> =
                espeak.get(b"espeak_SetVoiceByName\0")?;
            anyhow::ensure!(voice(language.as_ptr()) == 0, "Select voice");
        }
        Ok(Self { tts, espeak })
    }
    pub fn synthesize(&self, text: &str) -> Result<sherpa_onnx::GeneratedAudio> {
        let text = CString::new(text)?;
        let mut ptr = text.as_ptr() as *const c_void;
        let mut sentences = vec![];
        unsafe {
            let phonemes: libloading::Symbol<
                unsafe extern "C" fn(*mut *const c_void, i32, i32) -> *const c_char,
            > = self.espeak.get(b"espeak_TextToPhonemes\0")?;
            while !ptr.is_null() {
                let raw = phonemes(&mut ptr, 1, 2);
                if raw.is_null() {
                    break;
                }
                let value = CStr::from_ptr(raw).to_string_lossy();
                if !value.is_empty() {
                    sentences.push(value.chars().map(|c| c as i32).collect());
                }
            }
        }
        anyhow::ensure!(!sentences.is_empty(), "No speech phonemes");
        let config = GenerationConfig {
            phoneme_codepoints: Some(sentences),
            ..Default::default()
        };
        self.tts
            .generate_with_config::<fn(&[f32], f32) -> bool>("", &config, None)
            .context("Synthesize speech")
    }
}
impl Drop for Speaker {
    fn drop(&mut self) {
        unsafe {
            if let Ok(terminate) = self
                .espeak
                .get::<unsafe extern "C" fn() -> i32>(b"espeak_Terminate\0")
            {
                terminate();
            }
        }
    }
}
fn output<T: cpal::SizedSample + cpal::FromSample<f32>>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    samples: Vec<f32>,
    rate: u32,
    done: Arc<AtomicBool>,
) -> Result<cpal::Stream> {
    let mut pos = 0f64;
    let step = rate as f64 / config.sample_rate.0 as f64;
    let channels = config.channels as usize;
    Ok(device.build_output_stream(
        config,
        move |out: &mut [T], _| {
            for frame in out.chunks_exact_mut(channels) {
                let i = pos.floor() as usize;
                let f = (pos - i as f64) as f32;
                let a = samples.get(i).copied().unwrap_or(0.);
                let b = samples.get(i + 1).copied().unwrap_or(a);
                let v = a + (b - a) * f;
                for x in frame {
                    *x = T::from_sample(v);
                }
                pos += step;
                if i >= samples.len() {
                    done.store(true, Ordering::Relaxed);
                }
            }
        },
        |e| eprintln!("Speaker: {e}"),
        None,
    )?)
}
pub fn play(samples: Vec<f32>, rate: u32, speaker: Option<&str>, stop: &Path) -> Result<()> {
    let host = cpal::default_host();
    let device = match speaker {
        Some(name) => host
            .output_devices()?
            .find(|d| d.name().ok().as_deref() == Some(name)),
        None => host.default_output_device(),
    }
    .context("Selected speaker unavailable")?;
    let supported = device.default_output_config()?;
    let format = supported.sample_format();
    let config = supported.into();
    let done = Arc::new(AtomicBool::new(false));
    let stream = match format {
        cpal::SampleFormat::F32 => output::<f32>(&device, &config, samples, rate, done.clone())?,
        cpal::SampleFormat::I16 => output::<i16>(&device, &config, samples, rate, done.clone())?,
        cpal::SampleFormat::U16 => output::<u16>(&device, &config, samples, rate, done.clone())?,
        _ => anyhow::bail!("Unsupported speaker format"),
    };
    stream.play()?;
    let start = Instant::now();
    while !done.load(Ordering::Relaxed)
        && !stop.exists()
        && start.elapsed() < Duration::from_secs(90)
    {
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok(())
}

/// A short local recording cue; does not load a speech model.
pub fn earcon(speaker: Option<&str>, end: bool, stop: &Path) {
    if std::env::var("STAPP_EARCONS").as_deref() == Ok("0") {
        return;
    }
    let rate = 24000;
    let samples = (0..1920)
        .map(|i| {
            let t = i as f32 / rate as f32;
            let envelope = (std::f32::consts::PI * i as f32 / 1920.).sin();
            0.06 * envelope * (2. * std::f32::consts::PI * t * if end { 660. } else { 880. }).sin()
        })
        .collect();
    let _ = play(samples, rate, speaker, stop);
}

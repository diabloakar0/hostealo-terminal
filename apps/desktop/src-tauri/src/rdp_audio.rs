//! A remote desktop's sound on this computer's speakers.
//!
//! The server sends 16-bit PCM at 44.1 kHz stereo (the one format offered: Windows and xrdp both
//! have it, and offering several makes the format numbering ambiguous). It is converted to
//! whatever the output device uses (often 48 kHz, float, on a Mac) and played from a queue that
//! the audio callback only drains: an empty queue plays silence, it never waits. The queue is
//! capped so sound does not drift behind the picture.

use std::borrow::Cow;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use ironrdp::rdpsnd::client::RdpsndClientHandler;
use ironrdp::rdpsnd::pdu::{AudioFormat, PitchPdu, VolumePdu, WaveFormat};

/// What the UI is told about the sound.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AudioStatus {
    /// Sound arrived and is playing.
    Playing,
    /// It arrived but cannot be played here.
    Failed(String),
}

const RATE_IN: u32 = 44_100;
const CHANNELS_IN: usize = 2;
/// The most sound kept waiting to be played.
const MAX_QUEUE_SECS: f64 = 0.5;

fn formats() -> &'static [AudioFormat] {
    static FORMATS: std::sync::OnceLock<[AudioFormat; 1]> = std::sync::OnceLock::new();
    FORMATS.get_or_init(|| {
        [AudioFormat {
            format: WaveFormat::PCM,
            n_channels: CHANNELS_IN as u16,
            n_samples_per_sec: RATE_IN,
            n_avg_bytes_per_sec: RATE_IN * 4,
            n_block_align: 4,
            bits_per_sample: 16,
            data: None,
        }]
    })
}

/// 16-bit little-endian stereo PCM as frames of floats in [-1, 1].
pub fn decode_pcm16(bytes: &[u8]) -> Vec<[f32; 2]> {
    bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|frame| {
            let left = i16::from_le_bytes([frame[0], frame[1]]);
            let right = i16::from_le_bytes([frame[2], frame[3]]);
            [f32::from(left) / 32768.0, f32::from(right) / 32768.0]
        })
        .collect()
}

/// Linear resampling that carries its position between chunks, so the joins are seamless.
#[derive(Debug)]
pub struct Resampler {
    /// Input frames per output frame.
    step: f64,
    /// Position in the virtual sequence `[previous frame, chunk...]`.
    position: f64,
    previous: [f32; 2],
}

impl Resampler {
    pub fn new(rate_in: u32, rate_out: u32) -> Self {
        Self {
            step: f64::from(rate_in) / f64::from(rate_out),
            position: 1.0,
            previous: [0.0; 2],
        }
    }

    pub fn process(&mut self, input: &[[f32; 2]], out: &mut Vec<[f32; 2]>) {
        if input.is_empty() {
            return;
        }
        let at = |k: usize| if k == 0 { self.previous } else { input[k - 1] };
        let len = input.len() as f64;
        while self.position <= len {
            let i = self.position.floor() as usize;
            let frac = (self.position - i as f64) as f32;
            let a = at(i);
            let b = if i < input.len() { at(i + 1) } else { a };
            out.push([a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac]);
            self.position += self.step;
        }
        self.position -= len;
        self.previous = input[input.len() - 1];
    }
}

/// Stereo frames laid out for a device with `channels` channels (mono gets the mix; extra
/// channels stay silent).
pub fn to_device_channels(frames: &[[f32; 2]], channels: usize, out: &mut VecDeque<f32>) {
    for [left, right] in frames {
        match channels {
            1 => out.push_back((left + right) / 2.0),
            n => {
                out.push_back(*left);
                out.push_back(*right);
                for _ in 2..n {
                    out.push_back(0.0);
                }
            }
        }
    }
}

/// Drops the oldest samples beyond `max`, keeping whole frames.
pub fn cap_queue(queue: &mut VecDeque<f32>, max: usize, channels: usize) {
    if queue.len() > max {
        let excess = queue.len() - max;
        let excess = excess.div_ceil(channels) * channels;
        queue.drain(..excess.min(queue.len()));
    }
}

/// What the audio callback and the protocol side share.
struct Shared {
    queue: Mutex<VecDeque<f32>>,
    /// Volume from the server, as `f32` bits (1.0 = full).
    volume: AtomicU32,
}

/// The output stream, on a thread of its own (a stream cannot move between threads).
struct Output {
    rate: u32,
    channels: usize,
    stop: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

impl Output {
    fn open(shared: Arc<Shared>) -> Result<Self, String> {
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(u32, usize), String>>();
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let thread = std::thread::spawn(move || {
            let stream = match build_stream(shared) {
                Ok((stream, rate, channels)) => {
                    let _ = ready_tx.send(Ok((rate, channels)));
                    stream
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };
            while !thread_stop.load(Ordering::Relaxed) {
                std::thread::park_timeout(Duration::from_millis(500));
            }
            drop(stream);
        });
        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok((rate, channels))) => Ok(Self {
                rate,
                channels,
                stop,
                thread,
            }),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("the sound output did not start".into()),
        }
    }

    fn close(self) {
        self.stop.store(true, Ordering::Relaxed);
        self.thread.thread().unpark();
        let _ = self.thread.join();
    }
}

/// Opens the default output device in its own format and starts it (it must be started:
/// CoreAudio does not play a stream on its own).
fn build_stream(shared: Arc<Shared>) -> Result<(cpal::Stream, u32, usize), String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    let device = cpal::default_host()
        .default_output_device()
        .ok_or("no sound output on this computer")?;
    let config = device.default_output_config().map_err(|e| e.to_string())?;
    let rate = config.sample_rate().0;
    let channels = usize::from(config.channels());
    let stream_config = config.config();
    let on_error = |error| eprintln!("sound output: {error}");

    fn fill<T: cpal::SizedSample + cpal::FromSample<f32>>(shared: &Shared, data: &mut [T]) {
        let volume = f32::from_bits(shared.volume.load(Ordering::Relaxed));
        let mut queue = shared.queue.lock().unwrap_or_else(|p| p.into_inner());
        for sample in data.iter_mut() {
            let value = queue.pop_front().unwrap_or(0.0) * volume;
            *sample = T::from_sample(value);
        }
    }

    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_output_stream(
            &stream_config,
            move |data: &mut [f32], _: &_| fill(&shared, data),
            on_error,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_output_stream(
            &stream_config,
            move |data: &mut [i16], _: &_| fill(&shared, data),
            on_error,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_output_stream(
            &stream_config,
            move |data: &mut [u16], _: &_| fill(&shared, data),
            on_error,
            None,
        ),
        cpal::SampleFormat::I32 => device.build_output_stream(
            &stream_config,
            move |data: &mut [i32], _: &_| fill(&shared, data),
            on_error,
            None,
        ),
        other => return Err(format!("unsupported sound output format {other}")),
    }
    .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    Ok((stream, rate, channels))
}

/// The remote desktop's sound handler.
pub struct Speaker {
    shared: Arc<Shared>,
    output: Option<Output>,
    resampler: Option<Resampler>,
    on_status: Box<dyn Fn(AudioStatus) + Send>,
    /// The output could not be opened: do not retry for every packet.
    failed: bool,
    told_playing: bool,
}

impl std::fmt::Debug for Speaker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Speaker")
            .field("open", &self.output.is_some())
            .finish()
    }
}

impl Speaker {
    pub fn new(on_status: Box<dyn Fn(AudioStatus) + Send>) -> Self {
        Self {
            shared: Arc::new(Shared {
                queue: Mutex::new(VecDeque::new()),
                volume: AtomicU32::new(1.0f32.to_bits()),
            }),
            output: None,
            resampler: None,
            on_status,
            failed: false,
            told_playing: false,
        }
    }
}

impl RdpsndClientHandler for Speaker {
    fn get_formats(&self) -> &[AudioFormat] {
        formats()
    }

    fn wave(&mut self, _format_no: usize, _ts: u32, data: Cow<'_, [u8]>) {
        if self.failed {
            return;
        }
        if self.output.is_none() {
            match Output::open(self.shared.clone()) {
                Ok(output) => {
                    self.resampler = Some(Resampler::new(RATE_IN, output.rate));
                    self.output = Some(output);
                }
                Err(error) => {
                    self.failed = true;
                    (self.on_status)(AudioStatus::Failed(error));
                    return;
                }
            }
        }
        let (Some(output), Some(resampler)) = (&self.output, &mut self.resampler) else {
            return;
        };
        let mut frames = Vec::new();
        resampler.process(&decode_pcm16(&data), &mut frames);
        {
            let mut queue = self.shared.queue.lock().unwrap_or_else(|p| p.into_inner());
            to_device_channels(&frames, output.channels, &mut queue);
            let max = (f64::from(output.rate) * MAX_QUEUE_SECS) as usize * output.channels;
            cap_queue(&mut queue, max, output.channels);
        }
        if !self.told_playing {
            self.told_playing = true;
            (self.on_status)(AudioStatus::Playing);
        }
    }

    fn set_volume(&mut self, volume: VolumePdu) {
        // One volume for both sides (the louder one): a stereo balance is rarely set remotely.
        let level = f32::from(volume.volume_left.max(volume.volume_right)) / f32::from(u16::MAX);
        self.shared.volume.store(level.to_bits(), Ordering::Relaxed);
    }

    fn set_pitch(&mut self, _pitch: PitchPdu) {}

    fn close(&mut self) {
        if let Some(output) = self.output.take() {
            output.close();
        }
        self.resampler = None;
        self.shared
            .queue
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
    }
}

impl Drop for Speaker {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcm_decodes_to_floats() {
        let bytes = [0x00, 0x80, 0xff, 0x7f, 0x00, 0x00, 0x00, 0x40];
        assert_eq!(
            decode_pcm16(&bytes),
            vec![[-1.0, 32767.0 / 32768.0], [0.0, 0.5]]
        );
    }

    #[test]
    fn resampling_44_1_to_48_khz_keeps_the_length_and_the_shape() {
        let mut resampler = Resampler::new(44_100, 48_000);
        let ramp: Vec<[f32; 2]> = (0..4410).map(|i| [i as f32 / 4410.0, 0.0]).collect();
        let mut out = Vec::new();
        // In uneven chunks, as packets come.
        for chunk in ramp.chunks(997) {
            resampler.process(chunk, &mut out);
        }
        // 0.1 s in, 0.1 s out (give or take a frame).
        assert!((out.len() as i64 - 4800).abs() <= 1, "{}", out.len());
        // A ramp stays a ramp: rising, no jumps at the chunk joins.
        for pair in out.windows(2).skip(2) {
            let delta = pair[1][0] - pair[0][0];
            assert!(delta > 0.0 && delta < 0.0005, "{delta}");
        }
    }

    #[test]
    fn the_same_rate_passes_through() {
        let mut resampler = Resampler::new(44_100, 44_100);
        let input = [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]];
        let mut out = Vec::new();
        resampler.process(&input, &mut out);
        assert_eq!(out, input);
    }

    #[test]
    fn stereo_goes_to_any_device_layout_and_the_queue_stays_short() {
        let frames = [[0.2, 0.4]];
        let mut queue = VecDeque::new();
        to_device_channels(&frames, 1, &mut queue);
        to_device_channels(&frames, 2, &mut queue);
        to_device_channels(&frames, 4, &mut queue);
        let got: Vec<f32> = queue.iter().copied().collect();
        assert_eq!(got.len(), 7);
        assert!((got[0] - 0.3).abs() < 1e-6);
        assert_eq!(&got[1..], &[0.2, 0.4, 0.2, 0.4, 0.0, 0.0]);

        let mut queue: VecDeque<f32> = (0..10).map(|i| i as f32).collect();
        cap_queue(&mut queue, 5, 2);
        // Oldest dropped in whole frames until it fits: 2 frames left, from a frame boundary.
        assert_eq!(
            queue.iter().copied().collect::<Vec<_>>(),
            vec![6.0, 7.0, 8.0, 9.0]
        );
    }

    #[test]
    fn one_format_is_offered_the_one_servers_have() {
        let speaker = Speaker::new(Box::new(|_| {}));
        let formats = speaker.get_formats();
        assert_eq!(formats.len(), 1);
        assert_eq!(
            (
                formats[0].format,
                formats[0].n_samples_per_sec,
                formats[0].n_channels,
                formats[0].bits_per_sample
            ),
            (WaveFormat::PCM, 44_100, 2, 16)
        );
        assert_eq!(formats[0].n_avg_bytes_per_sec, 176_400);
    }

    /// Opens this computer's real sound output and plays a quarter second of silence (nothing
    /// is heard). cargo test -- --ignored rdp_audio
    #[test]
    #[ignore = "uses the computer's sound output"]
    fn the_real_output_opens_and_plays() {
        let statuses = Arc::new(Mutex::new(Vec::new()));
        let seen = statuses.clone();
        let mut speaker = Speaker::new(Box::new(move |status| seen.lock().unwrap().push(status)));
        let silence = vec![0u8; 44_100]; // 0.25 s
        speaker.wave(0, 0, Cow::Borrowed(&silence));
        let output = speaker.output.as_ref().expect("output opened");
        println!("device: {} Hz, {} channels", output.rate, output.channels);
        std::thread::sleep(Duration::from_millis(400));
        // The callback has been draining the queue: the stream really runs.
        assert!(
            speaker.shared.queue.lock().unwrap().len()
                < (output.rate as usize / 8) * output.channels
        );
        assert_eq!(*statuses.lock().unwrap(), vec![AudioStatus::Playing]);
        speaker.close();
    }
}

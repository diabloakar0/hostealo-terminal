use std::borrow::Cow;
use std::collections::HashSet;

use ironrdp_core::{cast_length, impl_as_any, Decode as _, EncodeResult, ReadCursor};
use ironrdp_pdu::gcc::ChannelName;
use ironrdp_pdu::{encode_err, pdu_other_err, PduResult};
use ironrdp_svc::{CompressionCondition, SvcClientProcessor, SvcMessage, SvcProcessor};
use tracing::{debug, error};

use crate::pdu::{self, AudioFormat, PitchPdu, ServerAudioFormatPdu, TrainingPdu, VolumePdu};
use crate::server::RdpsndSvcMessages;

/// [Hostealo patch] Message type of a WaveInfo PDU (MS-RDPEA 2.2.3.3).
const SNDC_WAVE: u8 = 0x02;

pub trait RdpsndClientHandler: Send + core::fmt::Debug {
    fn get_flags(&self) -> pdu::AudioFormatFlags {
        pdu::AudioFormatFlags::empty()
    }

    fn get_formats(&self) -> &[AudioFormat];

    fn wave(&mut self, format_no: usize, ts: u32, data: Cow<'_, [u8]>);

    fn set_volume(&mut self, volume: VolumePdu);

    fn set_pitch(&mut self, pitch: PitchPdu);

    fn close(&mut self);
}

#[derive(Debug)]
pub struct NoopRdpsndBackend;

impl RdpsndClientHandler for NoopRdpsndBackend {
    fn get_formats(&self) -> &[AudioFormat] {
        &[]
    }

    fn wave(&mut self, _format_no: usize, _ts: u32, _data: Cow<'_, [u8]>) {}

    fn set_volume(&mut self, _volume: VolumePdu) {}

    fn set_pitch(&mut self, _pitch: PitchPdu) {}

    fn close(&mut self) {}
}

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
enum RdpsndState {
    Start,
    WaitingForTraining,
    Ready,
    Stop,
}

/// Required for rdpdr to work: [\[MS-RDPEFS\] Appendix A<1>]
///
/// [\[MS-RDPEFS\] Appendix A<1>]: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpefs/fd28bfd9-dae2-4a78-abe1-b4efa208b7aa#Appendix_A_1
#[derive(Debug)]
pub struct Rdpsnd {
    handler: Box<dyn RdpsndClientHandler>,
    state: RdpsndState,
    server_format: Option<ServerAudioFormatPdu>,
    /// [Hostealo patch] A WaveInfo PDU whose Wave PDU arrives in the next channel message
    /// (protocol versions before 8, e.g. xrdp), with the expected audio data length.
    pending_wave_info: Option<(pdu::WaveInfoPdu, usize)>,
}

impl Rdpsnd {
    pub const NAME: ChannelName = ChannelName::from_static(b"rdpsnd\0\0");

    pub fn new(handler: Box<dyn RdpsndClientHandler>) -> Self {
        Self {
            handler,
            state: RdpsndState::Start,
            server_format: None,
            pending_wave_info: None,
        }
    }

    pub fn get_format(&self, format_no: u16) -> PduResult<&AudioFormat> {
        let server_format = self
            .server_format
            .as_ref()
            .ok_or_else(|| pdu_other_err!("invalid state - no format"))?;

        server_format
            .formats
            .get(format_no as usize)
            .ok_or_else(|| pdu_other_err!("invalid format"))
    }

    pub fn version(&self) -> PduResult<pdu::Version> {
        let server_format = self
            .server_format
            .as_ref()
            .ok_or_else(|| pdu_other_err!("invalid state - no version"))?;

        Ok(server_format.version)
    }

    pub fn client_formats(&mut self) -> PduResult<RdpsndSvcMessages> {
        // Windows seems to be confused if the client replies with more formats, or unknown formats (e.g.: opus).
        // We ensure to only send supported formats in common with the server.
        let server_format: HashSet<_> = self
            .server_format
            .as_ref()
            .ok_or_else(|| pdu_other_err!("invalid state - no server format"))?
            .formats
            .iter()
            .collect();
        let formats: HashSet<_> = self.handler.get_formats().iter().collect();
        let formats = formats.intersection(&server_format).map(|&x| x.clone()).collect();

        let pdu = pdu::ClientAudioFormatPdu {
            version: self.version()?,
            flags: self.handler.get_flags() | pdu::AudioFormatFlags::ALIVE,
            formats,
            volume_left: 0xFFFF,
            volume_right: 0xFFFF,
            pitch: 0x00010000,
            dgram_port: 0,
        };
        Ok(RdpsndSvcMessages::new(vec![pdu::ClientAudioOutputPdu::AudioFormat(
            pdu,
        )
        .into()]))
    }

    pub fn quality_mode(&mut self) -> PduResult<RdpsndSvcMessages> {
        let pdu = pdu::QualityModePdu {
            quality_mode: pdu::QualityMode::High,
        };
        Ok(RdpsndSvcMessages::new(vec![pdu::ClientAudioOutputPdu::QualityMode(
            pdu,
        )
        .into()]))
    }

    pub fn training_confirm(&mut self, pdu: &TrainingPdu) -> PduResult<RdpsndSvcMessages> {
        let pack_size: EncodeResult<_> = cast_length!("wPackSize", pdu.data.len());
        let pack_size = pack_size.map_err(|e| encode_err!(e))?;
        let pdu = pdu::TrainingConfirmPdu {
            timestamp: pdu.timestamp,
            pack_size,
        };
        Ok(RdpsndSvcMessages::new(vec![
            pdu::ClientAudioOutputPdu::TrainingConfirm(pdu).into(),
        ]))
    }

    /// [Hostealo patch] Second half of a WaveInfo + Wave pair.
    fn process_wave(&mut self, info: &pdu::WaveInfoPdu, data_len: usize, payload: &[u8]) -> PduResult<Vec<SvcMessage>> {
        if self.state != RdpsndState::Ready || payload.len() < 4 {
            return Ok(Vec::new());
        }
        // The first 4 bytes of the audio travel in the WaveInfo PDU, replacing the Wave padding.
        let rest = &payload[4..];
        let rest = &rest[..rest.len().min(data_len)];
        let mut data = Vec::with_capacity(4 + rest.len());
        data.extend_from_slice(&info.data);
        data.extend_from_slice(rest);
        self.handler.wave(usize::from(info.format_no), u32::from(info.timestamp), data.into());
        Ok(self.wave_confirm(info.timestamp, info.block_no)?.into())
    }

    pub fn wave_confirm(&mut self, timestamp: u16, block_no: u8) -> PduResult<RdpsndSvcMessages> {
        let pdu = pdu::WaveConfirmPdu { timestamp, block_no };
        Ok(RdpsndSvcMessages::new(vec![pdu::ClientAudioOutputPdu::WaveConfirm(
            pdu,
        )
        .into()]))
    }
}

impl_as_any!(Rdpsnd);

impl SvcProcessor for Rdpsnd {
    fn channel_name(&self) -> ChannelName {
        Self::NAME
    }

    fn compression_condition(&self) -> CompressionCondition {
        CompressionCondition::Never
    }

    fn process(&mut self, payload: &[u8]) -> PduResult<Vec<SvcMessage>> {
        // [Hostealo patch] Versions before 8 send audio as a WaveInfo PDU followed by a separate
        // Wave PDU (4 padding bytes, then the rest of the data). Upstream only handled both in one
        // message, and the decode error closed the whole RDP session.
        if let Some((info, data_len)) = self.pending_wave_info.take() {
            return self.process_wave(&info, data_len, payload);
        }
        if payload.first() == Some(&SNDC_WAVE) && payload.len() >= 4 {
            let body_size = usize::from(u16::from_le_bytes([payload[2], payload[3]]));
            if payload.len() < 4 + body_size {
                return match pdu::WaveInfoPdu::decode(&mut ReadCursor::new(&payload[4..])) {
                    Ok(info) => {
                        self.pending_wave_info = Some((info, body_size.saturating_sub(12)));
                        Ok(Vec::new())
                    }
                    Err(e) => {
                        error!(error = %e, "Invalid WaveInfo PDU, dropping audio");
                        Ok(Vec::new())
                    }
                };
            }
        }

        // [Hostealo patch] An audio PDU that cannot be decoded is dropped instead of failing the
        // session: losing a bit of sound is better than losing the remote desktop.
        let pdu = match pdu::ServerAudioOutputPdu::decode(&mut ReadCursor::new(payload)) {
            Ok(pdu) => pdu,
            Err(e) => {
                error!(error = %e, "Invalid audio PDU, dropping it");
                return Ok(Vec::new());
            }
        };

        debug!(?pdu, ?self.state);
        let msg = match self.state {
            RdpsndState::Start => {
                let pdu::ServerAudioOutputPdu::AudioFormat(af) = pdu else {
                    error!("Invalid pdu");
                    self.state = RdpsndState::Stop;
                    return Ok(vec![]);
                };
                self.server_format = Some(af);
                self.state = RdpsndState::WaitingForTraining;
                let mut msgs: Vec<SvcMessage> = self.client_formats()?.into();
                if self.version()? >= pdu::Version::V6 {
                    let mut m = self.quality_mode()?.into();
                    msgs.append(&mut m);
                }
                msgs
            }
            RdpsndState::WaitingForTraining => {
                let pdu::ServerAudioOutputPdu::Training(pdu) = pdu else {
                    error!("Invalid PDU");
                    self.state = RdpsndState::Stop;
                    return Ok(vec![]);
                };
                self.state = RdpsndState::Ready;
                self.training_confirm(&pdu)?.into()
            }
            RdpsndState::Ready => {
                match pdu {
                    // TODO: handle WaveInfo for < v8
                    pdu::ServerAudioOutputPdu::Wave2(pdu) => {
                        let format_no = pdu.format_no as usize;
                        let ts = pdu.audio_timestamp;
                        self.handler.wave(format_no, ts, pdu.data);
                        return Ok(self.wave_confirm(pdu.timestamp, pdu.block_no)?.into());
                    }
                    pdu::ServerAudioOutputPdu::Volume(pdu) => {
                        self.handler.set_volume(pdu);
                    }
                    pdu::ServerAudioOutputPdu::Pitch(pdu) => {
                        self.handler.set_pitch(pdu);
                    }
                    pdu::ServerAudioOutputPdu::Close => {
                        self.handler.close();
                    }
                    pdu::ServerAudioOutputPdu::Training(pdu) => return Ok(self.training_confirm(&pdu)?.into()),
                    _ => {
                        error!("Invalid PDU");
                        self.state = RdpsndState::Stop;
                        return Ok(vec![]);
                    }
                }
                vec![]
            }
            state => {
                error!(?state, "Invalid state");
                vec![]
            }
        };

        Ok(msg)
    }
}

impl Drop for Rdpsnd {
    fn drop(&mut self) {
        self.handler.close();
    }
}

impl SvcClientProcessor for Rdpsnd {}

/// [Hostealo patch] Tests for the WaveInfo + Wave handling and non-fatal errors.
#[cfg(test)]
mod hostealo_patch_tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    #[derive(Debug, Default)]
    struct Recorder(Arc<Mutex<Vec<(usize, u32, Vec<u8>)>>>);

    impl RdpsndClientHandler for Recorder {
        fn get_formats(&self) -> &[AudioFormat] {
            &[]
        }
        fn wave(&mut self, format_no: usize, ts: u32, data: Cow<'_, [u8]>) {
            self.0.lock().unwrap().push((format_no, ts, data.into_owned()));
        }
        fn set_volume(&mut self, _volume: VolumePdu) {}
        fn set_pitch(&mut self, _pitch: PitchPdu) {}
        fn close(&mut self) {}
    }

    fn ready() -> (Rdpsnd, Arc<Mutex<Vec<(usize, u32, Vec<u8>)>>>) {
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let mut rdpsnd = Rdpsnd::new(Box::new(Recorder(recorded.clone())));
        rdpsnd.state = RdpsndState::Ready;
        (rdpsnd, recorded)
    }

    #[test]
    fn wave_info_and_wave_in_separate_messages_are_combined() {
        let (mut rdpsnd, recorded) = ready();
        let audio: Vec<u8> = (0u8..20).collect();
        // WaveInfo: header (type, pad, body size) + timestamp, format, block, 3 pad, first 4 bytes.
        let body_size = 12 + audio.len() - 4;
        let mut info = vec![SNDC_WAVE, 0];
        info.extend_from_slice(&(body_size as u16).to_le_bytes());
        info.extend_from_slice(&7u16.to_le_bytes()); // timestamp
        info.extend_from_slice(&1u16.to_le_bytes()); // format number
        info.extend_from_slice(&[3, 0, 0, 0]); // block number + padding
        info.extend_from_slice(&audio[..4]);
        assert!(rdpsnd.process(&info).unwrap().is_empty());

        // Wave: 4 padding bytes, then the rest of the audio.
        let mut wave = vec![0, 0, 0, 0];
        wave.extend_from_slice(&audio[4..]);
        let confirm = rdpsnd.process(&wave).unwrap();
        assert_eq!(confirm.len(), 1, "a wave confirm is sent back");
        assert_eq!(recorded.lock().unwrap().as_slice(), &[(1, 7, audio)]);
    }

    #[test]
    fn undecodable_audio_is_dropped_without_an_error() {
        let (mut rdpsnd, recorded) = ready();
        assert!(rdpsnd.process(&[0xFF, 0, 4, 0, 1, 2, 3, 4]).unwrap().is_empty());
        assert!(rdpsnd.process(&[]).unwrap().is_empty());
        assert!(recorded.lock().unwrap().is_empty());
    }
}

# ironrdp-rdpsnd 0.6.0 (patched)

Copy of [ironrdp-rdpsnd 0.6.0](https://crates.io/crates/ironrdp-rdpsnd/0.6.0) (MIT OR Apache-2.0,
see the LICENSE files) used through `[patch.crates-io]` in the workspace `Cargo.toml`.

Changes, all in `src/client.rs` and marked `[Hostealo patch]`:

1. **Audio from servers using protocol versions before 8** (xrdp, older Windows): they send a
   WaveInfo PDU and the Wave PDU in separate channel messages. Upstream expected both in one
   message, so every audio packet failed to decode. The WaveInfo is now kept until its Wave
   arrives, and the two are combined.
2. **Audio errors no longer close the RDP session.** A PDU that cannot be decoded is logged and
   dropped instead of returning an error, which used to end the whole remote desktop session.

Drop this patch when the IronRDP version in use handles both (check upstream `client.rs`).

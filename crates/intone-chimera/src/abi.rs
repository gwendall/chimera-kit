//! The C ABI the TypeScript facade calls. Requests are JSON, audio is a pointer into wasm memory.
//!
//! Every pointer argument must come from the matching `ic_*` constructor or from `ic_alloc`, and
//! must not be used after its `ic_*_free`. `src/engines/chimera.ts` is the only intended caller.

use crate::live::{self, BeatHitRequest, BeatTempoRequest, ShapeRequest};
use crate::{Body, Request, SAMPLE_RATE, ScoreRequest, Speaker, Utterance};
use chimera::engine::Engine;
use chimera::voice::human_voice::{SourcePatch, VoiceTelemetry};
use std::alloc::{Layout, alloc, dealloc};
use std::slice;

/// Bump when a signature below changes, along with `ABI_VERSION` in `src/engines/chimera.ts`
/// and in `src/engines/chimera-live.ts`.
const ABI_VERSION: u32 = 6;
/// The most samples one `ic_utterance_render` or `ic_live_render` call can hand over.
const CHUNK: usize = 4096;

/// A speaker, the text of its last error, and its last planned score's JSON.
pub struct SpeakerHandle {
    speaker: Speaker,
    error: String,
    plan: String,
}

pub struct UtteranceHandle {
    utterance: Utterance,
    buffer: Box<[f32; CHUNK]>,
    airway: Vec<f32>,
}

#[unsafe(no_mangle)]
pub extern "C" fn ic_abi_version() -> u32 {
    ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn ic_sample_rate() -> f64 {
    SAMPLE_RATE
}

/// # Safety
/// `n` must be above 0. Free the result with `ic_free` and the same `n`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_alloc(n: usize) -> *mut u8 {
    unsafe { alloc(Layout::array::<u8>(n).expect("allocation size")) }
}

/// # Safety
/// `p` must come from `ic_alloc(n)` and not have been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_free(p: *mut u8, n: usize) {
    unsafe { dealloc(p, Layout::array::<u8>(n).expect("allocation size")) }
}

#[unsafe(no_mangle)]
pub extern "C" fn ic_speaker_new() -> *mut SpeakerHandle {
    Box::into_raw(Box::new(SpeakerHandle {
        speaker: Speaker::new(),
        error: String::new(),
        plan: String::new(),
    }))
}

/// # Safety
/// `s` must come from `ic_speaker_new` and not have been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_speaker_free(s: *mut SpeakerHandle) {
    drop(unsafe { Box::from_raw(s) });
}

/// # Safety
/// `s` must be live and `text` must point to `len` readable bytes of UTF-8.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_speaker_load_dictionary(
    s: *mut SpeakerHandle,
    text: *const u8,
    len: usize,
) -> u32 {
    let s = unsafe { &mut *s };
    match std::str::from_utf8(unsafe { slice::from_raw_parts(text, len) }) {
        Ok(text) => {
            s.speaker.load_dictionary(text);
            1
        }
        Err(e) => {
            s.error = format!("dictionary is not UTF-8: {e}");
            0
        }
    }
}

/// # Safety
/// `s` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_speaker_error_ptr(s: *const SpeakerHandle) -> *const u8 {
    unsafe { &*s }.error.as_ptr()
}

/// # Safety
/// `s` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_speaker_error_len(s: *const SpeakerHandle) -> usize {
    unsafe { &*s }.error.len()
}

/// Starts an utterance from a JSON [`Request`]. Null on error; the speaker then holds the message.
///
/// # Safety
/// `s` must be live and `json` must point to `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_utterance_new(
    s: *mut SpeakerHandle,
    json: *const u8,
    len: usize,
) -> *mut UtteranceHandle {
    let s = unsafe { &mut *s };
    let bytes = unsafe { slice::from_raw_parts(json, len) };
    let result = serde_json::from_slice::<Request>(bytes)
        .map_err(|e| format!("invalid request: {e}"))
        .and_then(|request| s.speaker.utterance(&request));
    match result {
        Ok(utterance) => Box::into_raw(Box::new(UtteranceHandle {
            utterance,
            buffer: Box::new([0.0; CHUNK]),
            airway: Vec::new(),
        })),
        Err(message) => {
            s.error = message;
            std::ptr::null_mut()
        }
    }
}

/// Plans a JSON [`Request`] into a score instead of rendering it. 0 on error (the speaker then
/// holds the message); 1 on success (`ic_speaker_plan_ptr`/`_len` then hold the score's JSON).
///
/// # Safety
/// `s` must be live and `json` must point to `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_speaker_plan(
    s: *mut SpeakerHandle,
    json: *const u8,
    len: usize,
) -> u32 {
    let s = unsafe { &mut *s };
    let bytes = unsafe { slice::from_raw_parts(json, len) };
    let result = serde_json::from_slice::<Request>(bytes)
        .map_err(|e| format!("invalid request: {e}"))
        .and_then(|request| s.speaker.plan(&request));
    match result {
        Ok(score) => {
            s.plan = serde_json::to_string(&score).expect("a score always serializes");
            1
        }
        Err(message) => {
            s.error = message;
            0
        }
    }
}

/// Plans a JSON [`crate::sing::SingRequest`] (lyrics and notes) into a score, the way
/// `ic_speaker_plan` plans text: additive, so it shares that call's storage and getters
/// (`ic_speaker_plan_ptr`/`_len`) rather than adding new ones. 0 on error (the speaker then holds
/// the message); 1 on success. A later `ic_speaker_plan` or `ic_speaker_sing` call on the same
/// speaker replaces whichever score was there.
///
/// # Safety
/// `s` must be live and `json` must point to `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_speaker_sing(
    s: *mut SpeakerHandle,
    json: *const u8,
    len: usize,
) -> u32 {
    let s = unsafe { &mut *s };
    let bytes = unsafe { slice::from_raw_parts(json, len) };
    let result = serde_json::from_slice::<crate::sing::SingRequest>(bytes)
        .map_err(|e| format!("invalid sing request: {e}"))
        .and_then(|request| s.speaker.sing(&request));
    match result {
        Ok(score) => {
            s.plan = serde_json::to_string(&score).expect("a score always serializes");
            1
        }
        Err(message) => {
            s.error = message;
            0
        }
    }
}

/// # Safety
/// `s` must be live, and the pointer is valid only until the next `ic_speaker_plan` or
/// `ic_speaker_sing` call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_speaker_plan_ptr(s: *const SpeakerHandle) -> *const u8 {
    unsafe { &*s }.plan.as_ptr()
}

/// # Safety
/// `s` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_speaker_plan_len(s: *const SpeakerHandle) -> usize {
    unsafe { &*s }.plan.len()
}

/// Starts an utterance from a JSON [`ScoreRequest`] (its timing and pitch honored exactly). Null
/// on error; the speaker then holds the message.
///
/// # Safety
/// `s` must be live and `json` must point to `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_utterance_new_from_score(
    s: *mut SpeakerHandle,
    json: *const u8,
    len: usize,
) -> *mut UtteranceHandle {
    let s = unsafe { &mut *s };
    let bytes = unsafe { slice::from_raw_parts(json, len) };
    let result = serde_json::from_slice::<ScoreRequest>(bytes)
        .map_err(|e| format!("invalid score request: {e}"))
        .and_then(|request| s.speaker.utterance_from_score(&request));
    match result {
        Ok(utterance) => Box::into_raw(Box::new(UtteranceHandle {
            utterance,
            buffer: Box::new([0.0; CHUNK]),
            airway: Vec::new(),
        })),
        Err(message) => {
            s.error = message;
            std::ptr::null_mut()
        }
    }
}

/// # Safety
/// `u` must come from `ic_utterance_new` or `ic_utterance_new_from_score`, and not have been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_utterance_free(u: *mut UtteranceHandle) {
    drop(unsafe { Box::from_raw(u) });
}

/// # Safety
/// `u` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_utterance_samples(u: *const UtteranceHandle) -> usize {
    unsafe { &*u }.utterance.total_samples()
}

/// Reads the airway as it is now into the utterance's storage; see [`Utterance::airway`] for the
/// layout. Returns its address, valid until the next call on `u`.
///
/// # Safety
/// `u` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_utterance_airway(u: *mut UtteranceHandle) -> *const f32 {
    let u = unsafe { &mut *u };
    u.utterance.airway(&mut u.airway);
    u.airway.as_ptr()
}

/// The values [`ic_utterance_airway`] last wrote.
///
/// # Safety
/// `u` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_utterance_airway_len(u: *const UtteranceHandle) -> usize {
    unsafe { &*u }.airway.len()
}

/// Renders up to `max` samples (at most 4096) into the utterance's buffer and returns how many;
/// 0 means finished. A small `max` hands the first audio over sooner.
///
/// # Safety
/// `u` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_utterance_render(u: *mut UtteranceHandle, max: usize) -> usize {
    let u = unsafe { &mut *u };
    u.utterance.render(&mut u.buffer[..max.min(CHUNK)])
}

/// # Safety
/// `u` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_utterance_buffer(u: *const UtteranceHandle) -> *const f32 {
    unsafe { &*u }.buffer.as_ptr()
}

// ---------------------------------------------------------------------- the held, played voice

/// A live `Engine`, its telemetry buffers, the beat's playhead at the last `ic_live_telemetry`
/// call, and the text of its last error.
pub struct LiveHandle {
    engine: Engine,
    error: String,
    buffer: Box<[f32; CHUNK]>,
    telemetry: VoiceTelemetry,
    telemetry_buf: Vec<f32>,
}

/// # Safety
/// `sample_rate` must be a normal, positive audio rate.
#[unsafe(no_mangle)]
pub extern "C" fn ic_live_new(sample_rate: f64) -> *mut LiveHandle {
    Box::into_raw(Box::new(LiveHandle {
        engine: Engine::new(sample_rate),
        error: String::new(),
        buffer: Box::new([0.0; CHUNK]),
        telemetry: VoiceTelemetry::default(),
        telemetry_buf: Vec::new(),
    }))
}

/// # Safety
/// `h` must come from `ic_live_new` and not have been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_live_free(h: *mut LiveHandle) {
    drop(unsafe { Box::from_raw(h) });
}

/// # Safety
/// `h` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_live_error_ptr(h: *const LiveHandle) -> *const u8 {
    unsafe { &*h }.error.as_ptr()
}

/// # Safety
/// `h` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_live_error_len(h: *const LiveHandle) -> usize {
    unsafe { &*h }.error.len()
}

/// Applies a JSON [`Body`] (a 0 on failure, the handle's error then holds the message) shared by
/// every `ic_live_*`/`ic_beat_*` setter below: parse, validate, and only then mutate the engine,
/// so invalid input leaves it exactly as it was.
unsafe fn apply<T>(
    h: *mut LiveHandle,
    json: *const u8,
    len: usize,
    run: impl FnOnce(&mut Engine, T) -> Result<(), String>,
) -> u32
where
    T: serde::de::DeserializeOwned,
{
    let h = unsafe { &mut *h };
    let bytes = unsafe { slice::from_raw_parts(json, len) };
    let result = serde_json::from_slice::<T>(bytes)
        .map_err(|e| format!("invalid request: {e}"))
        .and_then(|request| run(&mut h.engine, request));
    match result {
        Ok(()) => 1,
        Err(message) => {
            h.error = message;
            0
        }
    }
}

/// # Safety
/// `h` must be live and `json` must point to `len` readable bytes (a [`Body`]).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_live_set_body(h: *mut LiveHandle, json: *const u8, len: usize) -> u32 {
    unsafe { apply::<Body>(h, json, len, |e, body| live::set_body(e, &body)) }
}

/// # Safety
/// `h` must be live and `json` must point to `len` readable bytes (a [`ShapeRequest`]).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_live_shape(h: *mut LiveHandle, json: *const u8, len: usize) -> u32 {
    unsafe { apply::<ShapeRequest>(h, json, len, |e, req| live::set_artic(e, &req)) }
}

/// # Safety
/// `h` must be live and `json` must point to `len` readable bytes (a [`SourcePatch`]).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_live_source(h: *mut LiveHandle, json: *const u8, len: usize) -> u32 {
    unsafe { apply::<SourcePatch>(h, json, len, |e, patch| live::set_source(e, &patch)) }
}

/// # Safety
/// `h` must be live and `ipa` must point to `len` readable UTF-8 bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_live_vowel(h: *mut LiveHandle, ipa: *const u8, len: usize) -> u32 {
    let h = unsafe { &mut *h };
    let result = std::str::from_utf8(unsafe { slice::from_raw_parts(ipa, len) })
        .map_err(|e| format!("vowel is not UTF-8: {e}"))
        .and_then(|ipa| live::set_vowel(&mut h.engine, ipa));
    match result {
        Ok(()) => 1,
        Err(message) => {
            h.error = message;
            0
        }
    }
}

/// Starts a note: `midi` is its pitch, `velocity` the breath gate (0..1.5; 1 is a plain note).
///
/// # Safety
/// `h` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_live_note_on(h: *mut LiveHandle, midi: f64, velocity: f64) -> u32 {
    let h = unsafe { &mut *h };
    match live::note_on(&mut h.engine, midi, velocity) {
        Ok(()) => 1,
        Err(message) => {
            h.error = message;
            0
        }
    }
}

/// # Safety
/// `h` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_live_note_off(h: *mut LiveHandle) {
    live::note_off(&mut unsafe { &mut *h }.engine);
}

/// Glides to a new pitch while a note is held.
///
/// # Safety
/// `h` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_live_bend(h: *mut LiveHandle, midi: f64) -> u32 {
    let h = unsafe { &mut *h };
    match live::bend(&mut h.engine, midi) {
        Ok(()) => 1,
        Err(message) => {
            h.error = message;
            0
        }
    }
}

/// Renders up to `max` samples (at most 4096) into the live buffer; always `max.min(4096)`, since
/// a held voice never runs out the way an utterance does.
///
/// # Safety
/// `h` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_live_render(h: *mut LiveHandle, max: usize) -> usize {
    let h = unsafe { &mut *h };
    let n = max.min(CHUNK);
    h.engine.render(&mut h.buffer[..n]);
    n
}

/// # Safety
/// `h` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_live_buffer(h: *const LiveHandle) -> *const f32 {
    unsafe { &*h }.buffer.as_ptr()
}

/// Reads the voice's telemetry and the beat's playhead now, packed as [`live::pack_telemetry`]
/// documents. Returns its address, valid until the next call on `h`.
///
/// # Safety
/// `h` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_live_telemetry(h: *mut LiveHandle) -> *const f32 {
    let h = unsafe { &mut *h };
    h.engine.telemetry(&mut h.telemetry);
    let step = h.engine.beat_step();
    live::pack_telemetry(&h.telemetry, step, &mut h.telemetry_buf);
    h.telemetry_buf.as_ptr()
}

/// The values [`ic_live_telemetry`] last wrote.
///
/// # Safety
/// `h` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_live_telemetry_len(h: *const LiveHandle) -> usize {
    unsafe { &*h }.telemetry_buf.len()
}

// ---------------------------------------------------------------------- the beatbox sequencer

/// One beatbox hit, by pattern symbol or sound name.
///
/// # Safety
/// `h` must be live and `json` must point to `len` readable bytes (a [`BeatHitRequest`]).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_beat_hit(h: *mut LiveHandle, json: *const u8, len: usize) -> u32 {
    unsafe { apply::<BeatHitRequest>(h, json, len, |e, req| live::beat_hit(e, &req)) }
}

/// Replaces the sequencer's pattern from its text ("B . t .").
///
/// # Safety
/// `h` must be live and `text` must point to `len` readable UTF-8 bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_beat_steps(h: *mut LiveHandle, text: *const u8, len: usize) -> u32 {
    let h = unsafe { &mut *h };
    match std::str::from_utf8(unsafe { slice::from_raw_parts(text, len) }) {
        Ok(text) => {
            live::set_beat_steps(&mut h.engine, text);
            1
        }
        Err(e) => {
            h.error = format!("beat pattern is not UTF-8: {e}");
            0
        }
    }
}

/// # Safety
/// `h` must be live and `json` must point to `len` readable bytes (a [`BeatTempoRequest`]).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_beat_tempo(h: *mut LiveHandle, json: *const u8, len: usize) -> u32 {
    unsafe { apply::<BeatTempoRequest>(h, json, len, |e, req| live::set_beat_tempo(e, &req)) }
}

/// # Safety
/// `h` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_beat_playing(h: *mut LiveHandle, playing: u32) {
    live::set_beat_playing(&mut unsafe { &mut *h }.engine, playing != 0);
}

/// A compiled performance owns one physical voice for its entire timeline.
pub struct PerformanceHandle {
    renderer: crate::performance::Renderer,
    buffer: Box<[f32; CHUNK]>,
    telemetry: VoiceTelemetry,
    packed: Vec<f32>,
}

/// # Safety
/// `s` must be live; `json` must point to `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_performance_new(
    s: *mut SpeakerHandle,
    json: *const u8,
    len: usize,
) -> *mut PerformanceHandle {
    let s = unsafe { &mut *s };
    let result = serde_json::from_slice::<crate::performance::Performance>(unsafe {
        slice::from_raw_parts(json, len)
    })
    .map_err(|e| format!("invalid performance: {e}"))
    .and_then(crate::performance::Renderer::new);
    match result {
        Ok(mut renderer) => {
            let mut telemetry = VoiceTelemetry::default();
            renderer.voice.telemetry(&mut telemetry);
            let mut packed = Vec::with_capacity(4096);
            live::pack_telemetry(&telemetry, -1, &mut packed);
            Box::into_raw(Box::new(PerformanceHandle {
                renderer,
                buffer: Box::new([0.0; CHUNK]),
                telemetry,
                packed,
            }))
        }
        Err(error) => {
            s.error = error;
            std::ptr::null_mut()
        }
    }
}

/// # Safety
/// `h` must be a live performance, not previously freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_performance_free(h: *mut PerformanceHandle) {
    drop(unsafe { Box::from_raw(h) });
}

/// # Safety
/// Both handles must be live. Returns -1 with the speaker's error on scheduling failure.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_performance_render(
    s: *mut SpeakerHandle,
    h: *mut PerformanceHandle,
    max: usize,
) -> i32 {
    let h = unsafe { &mut *h };
    match h.renderer.render(&mut h.buffer[..max.min(CHUNK)]) {
        Ok(n) => n as i32,
        Err(error) => {
            unsafe { &mut *s }.error = error;
            -1
        }
    }
}

/// # Safety
/// `h` must be live. The buffer is valid until the next render or free.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_performance_buffer(h: *const PerformanceHandle) -> *const f32 {
    unsafe { &*h }.buffer.as_ptr()
}

/// # Safety
/// `h` must be live. Snapshot clock is the number of rendered samples, not playback time.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_performance_telemetry(h: *mut PerformanceHandle) -> *const f32 {
    let h = unsafe { &mut *h };
    h.renderer.voice.telemetry(&mut h.telemetry);
    live::pack_telemetry(&h.telemetry, -1, &mut h.packed);
    h.packed.as_ptr()
}

/// # Safety
/// `h` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ic_performance_telemetry_len(h: *const PerformanceHandle) -> usize {
    unsafe { &*h }.packed.len()
}

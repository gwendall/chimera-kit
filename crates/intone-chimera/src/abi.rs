//! The C ABI the TypeScript facade calls. Requests are JSON, audio is a pointer into wasm memory.
//!
//! Every pointer argument must come from the matching `ic_*` constructor or from `ic_alloc`, and
//! must not be used after its `ic_*_free`. `src/engines/chimera.ts` is the only intended caller.

use crate::{Request, SAMPLE_RATE, Speaker, Utterance};
use std::alloc::{Layout, alloc, dealloc};
use std::slice;

/// Bump when a signature below changes, along with `ABI_VERSION` in `src/engines/chimera.ts`.
const ABI_VERSION: u32 = 2;
/// The most samples one `ic_utterance_render` call can hand over.
const CHUNK: usize = 4096;

/// A speaker and the text of its last error.
pub struct SpeakerHandle {
    speaker: Speaker,
    error: String,
}

pub struct UtteranceHandle {
    utterance: Utterance,
    buffer: Box<[f32; CHUNK]>,
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
        })),
        Err(message) => {
            s.error = message;
            std::ptr::null_mut()
        }
    }
}

/// # Safety
/// `u` must come from `ic_utterance_new` and not have been freed.
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

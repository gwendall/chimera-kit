//! The C ABI the TypeScript facade calls. The catalog crosses once as JSON; everything else is
//! small values and a pointer into this module's wasm memory.
//!
//! Every pointer argument must come from the matching `cc_*` constructor or from `cc_alloc`, and
//! must not be used after its `cc_*_free`. `src/creatures.ts` is the only intended caller.

use crate::SAMPLE_RATE;
use chimera::creatures::{CREATURES, CreatureVoice, creature_by_id};
use std::alloc::{Layout, alloc, dealloc};
use std::slice;
use std::sync::{LazyLock, Once};

/// Bump when a signature below changes, along with `ABI_VERSION` in `src/creatures.ts`.
const ABI_VERSION: u32 = 1;
/// The most samples one `cc_creature_render` call can hand over, and the handle buffer's size.
const CHUNK: usize = 4096;

static INIT: Once = Once::new();

/// Forces the creature registry and its tables, so nothing initializes lazily on the audio
/// thread. Idempotent; called from every entry point that might run first.
fn ensure_init() {
    INIT.call_once(chimera::creatures::init);
}

/// The creature catalog (`CreatureDef`'s own `Serialize`) as JSON, built once.
static CATALOG: LazyLock<String> = LazyLock::new(|| {
    ensure_init();
    serde_json::to_string(&*CREATURES).expect("the creature catalog always serializes")
});

pub struct CreatureHandle {
    voice: CreatureVoice,
    buffer: Box<[f32; CHUNK]>,
}

#[unsafe(no_mangle)]
pub extern "C" fn cc_abi_version() -> u32 {
    ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn cc_sample_rate() -> f64 {
    SAMPLE_RATE
}

/// # Safety
/// `n` must be above 0. Free the result with `cc_free` and the same `n`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cc_alloc(n: usize) -> *mut u8 {
    unsafe { alloc(Layout::array::<u8>(n).expect("allocation size")) }
}

/// # Safety
/// `p` must come from `cc_alloc(n)` and not have been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cc_free(p: *mut u8, n: usize) {
    unsafe { dealloc(p, Layout::array::<u8>(n).expect("allocation size")) }
}

/// The catalog never changes once built, so the pointer stays valid for the module's life.
#[unsafe(no_mangle)]
pub extern "C" fn cc_catalog_ptr() -> *const u8 {
    CATALOG.as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn cc_catalog_len() -> usize {
    CATALOG.len()
}

/// A creature by id, as in the catalog. Null for an unknown id. Allocates (not real-time); call
/// off the audio thread.
///
/// # Safety
/// `id` must point to `len` readable bytes of UTF-8.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cc_creature_new(id: *const u8, len: usize) -> *mut CreatureHandle {
    ensure_init();
    let bytes = unsafe { slice::from_raw_parts(id, len) };
    let Ok(id) = std::str::from_utf8(bytes) else {
        return std::ptr::null_mut();
    };
    let Some(def) = creature_by_id(id) else {
        return std::ptr::null_mut();
    };
    Box::into_raw(Box::new(CreatureHandle {
        voice: CreatureVoice::new(def, SAMPLE_RATE, &[]),
        buffer: Box::new([0.0; CHUNK]),
    }))
}

/// # Safety
/// `h` must come from `cc_creature_new` and not have been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cc_creature_free(h: *mut CreatureHandle) {
    drop(unsafe { Box::from_raw(h) });
}

/// Set one performer parameter, by its index in the creature's `params`. Out-of-range indices
/// and non-finite values are ignored.
///
/// # Safety
/// `h` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cc_creature_param(h: *mut CreatureHandle, index: usize, value: f64) {
    unsafe { &mut *h }.voice.set_params(&[(index, value)]);
}

/// # Safety
/// `h` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cc_creature_gate(h: *mut CreatureHandle, level: f64) {
    unsafe { &mut *h }.voice.set_gate(level);
}

/// Play call `index` (others are ignored); a NaN `pitch` keeps the call's own.
///
/// # Safety
/// `h` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cc_creature_call(
    h: *mut CreatureHandle,
    index: usize,
    pitch: f64,
    amp: f64,
) {
    let pitch = if pitch.is_nan() { None } else { Some(pitch) };
    unsafe { &mut *h }.voice.play_call(index, pitch, amp);
}

/// # Safety
/// `h` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cc_creature_stop(h: *mut CreatureHandle) {
    unsafe { &mut *h }.voice.stop_call();
}

/// The active call's index in the creature's `calls`, or -1 when none is playing.
///
/// # Safety
/// `h` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cc_creature_active(h: *const CreatureHandle) -> i32 {
    let h = unsafe { &*h };
    match h.voice.active_call() {
        Some(id) => h.voice.def.call_index(id).map_or(-1, |i| i as i32),
        None => -1,
    }
}

/// Renders up to `n` samples (at most 4096) into the handle's buffer and returns how many (always
/// `n.min(4096)`: a creature keeps rendering, silent or not, unlike an utterance that ends).
///
/// # Safety
/// `h` must be live.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cc_creature_render(h: *mut CreatureHandle, n: usize) -> usize {
    let h = unsafe { &mut *h };
    let n = n.min(CHUNK);
    h.voice.render(&mut h.buffer[..n]);
    n
}

/// # Safety
/// `h` must be live, and the pointer is valid only until the next `cc_creature_render` call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cc_creature_buffer(h: *const CreatureHandle) -> *const f32 {
    unsafe { &*h }.buffer.as_ptr()
}

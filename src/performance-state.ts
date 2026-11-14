/** Portable physical state, stored as changed pages of a deterministic fresh wasm instance. */
const PAGE = 65536,
  HEADER = 104,
  MAX_BYTES = 512 * 1024 * 1024;
export interface StateIdentity {
  engineId: string;
  baseHash: Uint8Array;
  speaker: number;
  handle: number;
  samples: number;
}
const hexBytes = (value: string): Uint8Array => {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("chimera-kit: state needs a SHA256 engine identity");
  return Uint8Array.from({ length: 32 }, (_, i) => Number.parseInt(value.slice(i * 2, i * 2 + 2), 16));
};
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export async function exportState(
  memory: Uint8Array,
  base: Uint8Array,
  identity: StateIdentity,
  position: number,
): Promise<Uint8Array> {
  if (memory.length > MAX_BYTES || memory.length % PAGE || base.length % PAGE)
    throw new Error("chimera-kit: unsupported state memory size");
  const now = new Uint32Array(memory.buffer, memory.byteOffset, memory.length / 4);
  const initial = new Uint32Array(base.buffer, base.byteOffset, base.length / 4);
  const pages: number[] = [];
  for (let at = 0; at < memory.length; at += PAGE) {
    const end = (at + PAGE) / 4;
    for (let i = at / 4; i < end; i++)
      if (now[i] !== (initial[i] ?? 0)) {
        pages.push(at);
        break;
      }
  }
  const bytes = new Uint8Array(HEADER + pages.length * (8 + PAGE) + 32),
    header = new DataView(bytes.buffer);
  bytes.set([67, 72, 80, 83]); // CHPS
  [
    1,
    7,
    identity.samples,
    position,
    identity.speaker,
    identity.handle,
    memory.length,
    pages.length,
    base.length,
  ].forEach((n, i) => {
    header.setUint32(4 + i * 4, n, true);
  });
  bytes.set(hexBytes(identity.engineId), 40);
  bytes.set(identity.baseHash, 72);
  let cursor = HEADER;
  for (const at of pages) {
    header.setUint32(cursor, at, true);
    header.setUint32(cursor + 4, PAGE, true);
    bytes.set(memory.subarray(at, at + PAGE), cursor + 8);
    cursor += 8 + PAGE;
  }
  bytes.set(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.subarray(0, cursor))), cursor);
  return bytes;
}

/** Validate the complete patch before touching memory; only a fresh matching instance is valid. */
export async function importState(
  memory: WebAssembly.Memory,
  state: Uint8Array,
  identity: StateIdentity,
): Promise<number> {
  if (state.length < HEADER + 32) throw new Error("chimera-kit: truncated physical state");
  const h = new DataView(state.buffer, state.byteOffset, state.byteLength);
  const u = (at: number) => h.getUint32(at, true);
  if (u(0) !== 0x53504843 || u(4) !== 1 || u(8) !== 7)
    throw new Error("chimera-kit: incompatible physical state");
  if (!same(state.subarray(40, 72), hexBytes(identity.engineId)))
    throw new Error("chimera-kit: physical state engine mismatch");
  if (
    !same(state.subarray(72, 104), identity.baseHash) ||
    u(36) !== memory.buffer.byteLength ||
    u(20) !== identity.speaker ||
    u(24) !== identity.handle ||
    u(12) !== identity.samples
  )
    throw new Error("chimera-kit: physical state base mismatch");
  const size = u(28),
    count = u(32),
    position = u(16);
  if (
    size < memory.buffer.byteLength ||
    size > MAX_BYTES ||
    size % PAGE ||
    position > identity.samples ||
    count > size / PAGE ||
    state.length !== HEADER + count * (8 + PAGE) + 32
  )
    throw new Error("chimera-kit: invalid physical state bounds");
  let cursor = HEADER,
    previous = -1;
  for (let i = 0; i < count; i++) {
    const at = u(cursor),
      len = u(cursor + 4);
    if (at % PAGE || at <= previous || len !== PAGE || at + len > size)
      throw new Error("chimera-kit: invalid physical state page");
    previous = at;
    cursor += 8 + len;
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", state.subarray(0, cursor) as BufferSource),
  );
  if (!same(digest, state.subarray(cursor))) throw new Error("chimera-kit: physical state checksum mismatch");
  if (size > memory.buffer.byteLength) memory.grow((size - memory.buffer.byteLength) / PAGE);
  const target = new Uint8Array(memory.buffer);
  cursor = HEADER;
  for (let i = 0; i < count; i++) {
    const at = u(cursor),
      len = u(cursor + 4);
    target.set(state.subarray(cursor + 8, cursor + 8 + len), at);
    cursor += 8 + len;
  }
  return position;
}

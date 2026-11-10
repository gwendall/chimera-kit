import { afterEach, describe, expect, test } from "bun:test";
import type { FromLive, ToLive } from "./engines/chimera-live.ts";
import { createInstrument } from "./live.ts";

const real = { AudioContext: globalThis.AudioContext, AudioWorkletNode: globalThis.AudioWorkletNode };
afterEach(() => Object.assign(globalThis, real));
const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
type Failure = "module" | "wasm" | "node" | "connect" | "body" | "ready";

function browser(failure?: Failure, cleanupThrows = false) {
  const cause = new Error(`failed ${failure}`);
  const contexts: FakeContext[] = [];
  const nodes: FakeNode[] = [];
  class FakeContext {
    state = "running";
    destination = {};
    closes = 0;
    loads = 0;
    rejectModule = failure === "module";
    audioWorklet = {
      addModule: async () => {
        this.loads++;
        if (this.rejectModule) throw cause;
      },
    };
    constructor() {
      contexts.push(this);
    }
    async resume() {}
    async close() {
      this.closes++;
      this.state = "closed";
      if (cleanupThrows) throw new Error("close failed");
    }
  }
  class FakeNode {
    disconnected = 0;
    closed = 0;
    sent: ToLive[] = [];
    port = {
      onmessage: null as ((event: MessageEvent<FromLive>) => void) | null,
      postMessage: (message: ToLive) => {
        this.sent.push(message);
        if (message.type === "setBody" && failure === "body") throw cause;
        if (message.type === "free" && cleanupThrows) throw new Error("free failed");
      },
      close: () => {
        this.closed++;
        if (cleanupThrows) throw new Error("port close failed");
      },
    };
    constructor() {
      if (failure === "node") throw cause;
      nodes.push(this);
      queueMicrotask(() =>
        this.port.onmessage?.({
          data: failure === "ready" ? { type: "error", message: cause.message } : { type: "ready" },
        } as MessageEvent<FromLive>),
      );
    }
    connect() {
      if (failure === "connect") throw cause;
    }
    disconnect() {
      this.disconnected++;
      if (cleanupThrows) throw new Error("disconnect failed");
    }
  }
  Object.assign(globalThis, { AudioContext: FakeContext, AudioWorkletNode: FakeNode });
  return { cause, contexts, nodes, FakeContext };
}

describe("createInstrument ownership", () => {
  for (const supplied of [false, true]) {
    for (const failure of ["module", "wasm", "node", "connect", "body", "ready"] as const) {
      test(`${failure} failure cleans up ${supplied ? "a supplied" : "an owned"} context correctly`, async () => {
        const { cause, contexts, nodes, FakeContext } = browser(failure);
        const context = supplied ? (new FakeContext() as unknown as BaseAudioContext) : undefined;
        const creating = createInstrument({
          ...(context ? { context } : {}),
          body: "female",
          wasm: failure === "wasm" ? new Uint8Array([0]) : wasm,
        });
        if (failure === "wasm") await expect(creating).rejects.toBeInstanceOf(WebAssembly.CompileError);
        else if (failure === "ready") await expect(creating).rejects.toThrow(cause.message);
        else await expect(creating).rejects.toBe(cause);
        expect(contexts[0]?.closes).toBe(supplied ? 0 : 1);
        for (const node of nodes) {
          expect(node.disconnected).toBe(1);
          expect(node.closed).toBe(1);
          expect(node.port.onmessage).toBeNull();
          expect(node.sent.filter((message) => message.type === "free")).toHaveLength(1);
        }
      });
    }
  }

  test("cleanup failures preserve the original initialization error", async () => {
    const { cause, contexts, nodes } = browser("connect", true);
    await expect(createInstrument({ wasm })).rejects.toBe(cause);
    expect(contexts[0]?.closes).toBe(1);
    expect(nodes[0]?.closed).toBe(1);
    expect(nodes[0]?.disconnected).toBe(1);
  });

  test("a rejected worklet load can retry on a supplied context", async () => {
    const { cause, nodes, FakeContext } = browser("module");
    const context = new FakeContext();
    const options = { context: context as unknown as BaseAudioContext, wasm };
    await expect(createInstrument(options)).rejects.toBe(cause);
    context.rejectModule = false;
    const instrument = await createInstrument(options);
    try {
      expect(context.loads).toBe(2);
      expect(context.closes).toBe(0);
    } finally {
      instrument.free();
    }
    expect(nodes[0]?.closed).toBe(1);
    expect(context.closes).toBe(0);
  });
});

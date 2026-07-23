import assert from "node:assert/strict";
import test from "node:test";

import {
  MAXIMUM_IPC_FRAME_BYTES,
  IpcFrameDecoder,
  encodeIpcFrame,
} from "../../src/desktop-ipc/ipc-framer.ts";

test("IPC framing accepts every header/payload split and coalesced frames", () => {
  const first = encodeIpcFrame({ type: "broadcast", method: "one", version: 1 });
  const second = encodeIpcFrame({ type: "response", requestId: "two", success: true });
  const combined = Buffer.concat([first, second]);

  for (let split = 0; split <= combined.length; split += 1) {
    const decoder = new IpcFrameDecoder();
    const decoded = [
      ...decoder.push(combined.subarray(0, split)),
      ...decoder.push(combined.subarray(split)),
    ];
    decoder.end();
    assert.deepEqual(decoded, [
      { type: "broadcast", method: "one", version: 1 },
      { type: "response", requestId: "two", success: true },
    ]);
  }
});

test("IPC framing rejects zero, oversize, invalid UTF-8/JSON/root and incomplete frames", () => {
  const cases = [
    Buffer.alloc(4),
    Buffer.from([9, 0, 0, 0]),
    Buffer.from([2, 0, 0, 0, 0xc3, 0x28]),
    Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.from("{")]),
    Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.from("1")]),
  ];
  for (const frame of cases) {
    const decoder = new IpcFrameDecoder({ maximumFrameBytes: 8 });
    assert.throws(() => decoder.push(frame));
  }

  const incompleteHeader = new IpcFrameDecoder();
  incompleteHeader.push(Buffer.from([1, 0]));
  assert.throws(() => incompleteHeader.end());

  const incompletePayload = new IpcFrameDecoder();
  incompletePayload.push(Buffer.from([3, 0, 0, 0, 0x7b]));
  assert.throws(() => incompletePayload.end());
});

test("IPC framing enforces its accumulator bound before retaining input", () => {
  const decoder = new IpcFrameDecoder({ maximumFrameBytes: 8 });
  assert.throws(() => decoder.push(Buffer.alloc(13)));
  assert.equal(decoder.bufferedBytes, 0);
});

test("IPC framing incrementally assembles large ChatGPT snapshots and an immediate next frame", () => {
  assert.equal(MAXIMUM_IPC_FRAME_BYTES, 256 * 1024 * 1024);
  const large = encodeIpcFrame({
    type: "broadcast",
    method: "thread-stream-state-changed",
    state: "x".repeat(2 * 1024 * 1024),
  });
  const following = encodeIpcFrame({ type: "broadcast", method: "client-status-changed" });
  const combined = Buffer.concat([large, following]);
  const decoder = new IpcFrameDecoder();
  const decoded: Readonly<Record<string, unknown>>[] = [];

  for (let offset = 0; offset < combined.length; offset += 8_192) {
    decoded.push(...decoder.push(combined.subarray(offset, offset + 8_192)));
  }

  decoder.end();
  assert.equal(decoded.length, 2);
  assert.equal(decoded[0]?.method, "thread-stream-state-changed");
  assert.equal((decoded[0]?.state as string).length, 2 * 1024 * 1024);
  assert.equal(decoded[1]?.method, "client-status-changed");
  assert.equal(decoder.bufferedBytes, 0);
});

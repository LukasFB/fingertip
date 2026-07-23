// ChatGPT snapshots contain the complete conversation state. Long-running tasks
// can legitimately exceed 100 MiB (observed with desktop build 26.707.72221),
// so keep a finite guard while leaving enough room for real desktop frames.
export const MAXIMUM_IPC_FRAME_BYTES = 256 * 1024 * 1024;

export interface IpcFrameDecoderOptions {
  readonly maximumFrameBytes: number;
}

function fail(message: string): never {
  throw new TypeError(message);
}

function isObjectRoot(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function encodeIpcFrame(value: Readonly<Record<string, unknown>>): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length === 0 || payload.length > MAXIMUM_IPC_FRAME_BYTES) fail("invalid IPC frame size");
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export class IpcFrameDecoder {
  readonly #maximumFrameBytes: number;
  readonly #header = Buffer.allocUnsafe(4);
  #headerBytes = 0;
  #payload: Buffer | null = null;
  #payloadBytes = 0;
  #failed = false;

  constructor(options?: Partial<IpcFrameDecoderOptions>) {
    this.#maximumFrameBytes = options?.maximumFrameBytes ?? MAXIMUM_IPC_FRAME_BYTES;
    if (!Number.isInteger(this.#maximumFrameBytes) || this.#maximumFrameBytes < 1) {
      fail("maximumFrameBytes must be a positive integer");
    }
  }

  get bufferedBytes(): number {
    return this.#headerBytes + this.#payloadBytes;
  }

  push(chunk: Uint8Array): readonly Readonly<Record<string, unknown>>[] {
    if (this.#failed) return fail("IPC frame decoder is closed");
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const values: Readonly<Record<string, unknown>>[] = [];
    let offset = 0;
    while (offset < bytes.length) {
      if (this.#payload === null) {
        const headerLength = Math.min(4 - this.#headerBytes, bytes.length - offset);
        bytes.copy(this.#header, this.#headerBytes, offset, offset + headerLength);
        this.#headerBytes += headerLength;
        offset += headerLength;
        if (this.#headerBytes < 4) continue;
        const payloadLength = this.#header.readUInt32LE(0);
        if (payloadLength === 0 || payloadLength > this.#maximumFrameBytes) {
          return this.#reject("invalid IPC frame size");
        }
        this.#payload = Buffer.allocUnsafe(payloadLength);
        this.#payloadBytes = 0;
      }

      const payload = this.#payload;
      const payloadLength = payload.length;
      const copyLength = Math.min(payloadLength - this.#payloadBytes, bytes.length - offset);
      bytes.copy(payload, this.#payloadBytes, offset, offset + copyLength);
      this.#payloadBytes += copyLength;
      offset += copyLength;
      if (this.#payloadBytes < payloadLength) continue;

      this.#payload = null;
      this.#payloadBytes = 0;
      this.#headerBytes = 0;
      let decoded: string;
      let parsed: unknown;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(payload);
        parsed = JSON.parse(decoded) as unknown;
      } catch {
        return this.#reject("invalid IPC frame payload");
      }
      if (!isObjectRoot(parsed)) return this.#reject("IPC frame root must be an object");
      values.push(Object.freeze(parsed));
    }
    return Object.freeze(values);
  }

  end(): void {
    if (this.#failed) return fail("IPC frame decoder is closed");
    if (this.#headerBytes !== 0 || this.#payload !== null) this.#reject("incomplete IPC frame");
  }

  #reject(message: string): never {
    this.#failed = true;
    this.#headerBytes = 0;
    this.#payload = null;
    this.#payloadBytes = 0;
    return fail(message);
  }
}

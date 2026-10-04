import { fromBrowserError } from "../errors";
import type { PlaySource } from "../types";

/** decodeAudioData detaches its input, so it always gets a private copy. */
export async function decodeSource(ctx: AudioContext, src: PlaySource): Promise<AudioBuffer> {
  let bytes: ArrayBuffer;
  if (src instanceof Blob) bytes = await src.arrayBuffer();
  else if (ArrayBuffer.isView(src)) bytes = toBytes(src).slice().buffer; // slice() of a plain view is a plain ArrayBuffer
  else bytes = src.slice(0);
  try {
    return await ctx.decodeAudioData(bytes);
  } catch (err) {
    throw fromBrowserError(err, "decode_failed");
  }
}

/** Any of the byte-ish things a network stream hands you, as a Uint8Array view. */
export function toBytes(chunk: ArrayBuffer | ArrayBufferView): Uint8Array<ArrayBuffer> {
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  const shared = typeof SharedArrayBuffer !== "undefined" && chunk.buffer instanceof SharedArrayBuffer;
  // Views over shared memory are copied: MSE and decodeAudioData only accept plain ArrayBuffers.
  if (shared) return new Uint8Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as unknown as ArrayBuffer);
  if (chunk instanceof Uint8Array) return chunk as Uint8Array<ArrayBuffer>;
  return new Uint8Array(chunk.buffer as ArrayBuffer, chunk.byteOffset, chunk.byteLength);
}

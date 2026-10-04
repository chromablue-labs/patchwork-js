/**
 * A synthetic chunker: feeds bytes to a sink the way a streaming endpoint
 * would — paced, in uneven pieces — so the sink's gapless scheduling and
 * first-audio latency can be measured with no backend at all.
 */
export type ChunkerOptions = {
  /** Wall-clock pacing between chunks. */
  intervalMs: number;
  /** Bytes per chunk; `jitter` (0..1) randomises the size around it. */
  chunkBytes: number;
  jitter: number;
};

export async function pump(
  bytes: Uint8Array,
  write: (chunk: Uint8Array) => void,
  opts: ChunkerOptions,
  signal?: AbortSignal,
): Promise<{ chunks: number }> {
  let offset = 0;
  let chunks = 0;
  while (offset < bytes.byteLength) {
    if (signal?.aborted) break;
    const size = Math.max(1, Math.round(opts.chunkBytes * (1 + (Math.random() * 2 - 1) * opts.jitter)));
    write(bytes.subarray(offset, Math.min(bytes.byteLength, offset + size)));
    offset += size;
    chunks++;
    if (opts.intervalMs > 0) await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
  return { chunks };
}

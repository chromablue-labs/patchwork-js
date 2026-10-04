/**
 * The platform's voice endpoints, through the same seam the SDK uses: a
 * base URL and a `mint()` that returns a bearer token. The lab has no
 * session, so both come from the developer — `VITE_PATCHWORK_URL` and a
 * token pasted into the panel (or `VITE_PATCHWORK_TOKEN`). Until both are
 * present, everything that needs the API is off, and the lab says so.
 */
export type ApiConfig = { url: string; token: string; connection?: string };

const STORAGE_KEY = "audio-lab.api";

export function readApiConfig(): ApiConfig | null {
  let stored: Partial<ApiConfig> = {};
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<ApiConfig>;
  } catch {
    /* ignore */
  }
  const url = (stored.url || import.meta.env.VITE_PATCHWORK_URL || "").replace(/\/$/, "");
  const token = stored.token || import.meta.env.VITE_PATCHWORK_TOKEN || "";
  const connection = stored.connection || import.meta.env.VITE_PATCHWORK_CONNECTION || undefined;
  return url && token ? { url, token, connection } : null;
}

export function writeApiConfig(config: Partial<ApiConfig>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* private mode */
  }
}

export type Voice = { id: string; name: string; category?: string; preview_url?: string };

type Envelope<T> = { data?: T; error?: { message?: string; code?: string } };

function headers(config: ApiConfig, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${config.token}`, ...extra };
  if (config.connection) h["Patchwork-Connection"] = config.connection;
  return h;
}

async function fail(response: Response): Promise<never> {
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as Envelope<unknown>;
    if (body.error?.message) message = `${body.error.code ?? "error"}: ${body.error.message}`;
  } catch {
    /* not JSON */
  }
  throw new Error(message);
}

export async function listVoices(config: ApiConfig): Promise<Voice[]> {
  const response = await fetch(`${config.url}/v1/voice/voices`, { headers: headers(config) });
  if (!response.ok) return fail(response);
  const body = (await response.json()) as Envelope<Voice[]>;
  return body.data ?? [];
}

/** Whole-clip speak: the API buffers the MP3 and sends it in one response (ENG-61 streams it). */
export async function speak(config: ApiConfig, text: string, voiceId?: string): Promise<{ blob: Blob; ms: number }> {
  const started = performance.now();
  const response = await fetch(`${config.url}/v1/voice/speak`, {
    method: "POST",
    headers: headers(config, { "Content-Type": "application/json" }),
    body: JSON.stringify(voiceId ? { text, voice_id: voiceId } : { text }),
  });
  if (!response.ok) return fail(response);
  const blob = await response.blob();
  return { blob, ms: performance.now() - started };
}

/**
 * Streamed speak, for when ENG-61 lands: reads the body as it arrives and
 * hands each chunk to `onChunk`. Works against today's endpoint too — it just
 * delivers one big chunk after the whole thing is generated.
 */
export async function speakStream(
  config: ApiConfig,
  text: string,
  voiceId: string | undefined,
  onChunk: (bytes: Uint8Array, contentType: string) => void,
): Promise<{ firstByteMs: number; totalMs: number; bytes: number }> {
  const started = performance.now();
  const response = await fetch(`${config.url}/v1/voice/speak`, {
    method: "POST",
    headers: headers(config, { "Content-Type": "application/json" }),
    body: JSON.stringify(voiceId ? { text, voice_id: voiceId } : { text }),
  });
  if (!response.ok || !response.body) return fail(response);
  const type = response.headers.get("content-type") ?? "audio/mpeg";
  const reader = response.body.getReader();
  let firstByteMs = -1;
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (firstByteMs < 0) firstByteMs = performance.now() - started;
    bytes += value.byteLength;
    onChunk(value, type);
  }
  return { firstByteMs, totalMs: performance.now() - started, bytes };
}

export async function transcribe(config: ApiConfig, blob: Blob, mimeType: string): Promise<{ text: string; confidence?: number; ms: number }> {
  const started = performance.now();
  const form = new FormData();
  const ext = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "m4a" : mimeType.includes("wav") ? "wav" : "webm";
  form.append("audio", blob, `take.${ext}`);
  const response = await fetch(`${config.url}/v1/voice/transcribe`, { method: "POST", headers: headers(config), body: form });
  if (!response.ok) return fail(response);
  const body = (await response.json()) as Envelope<{ text: string; confidence?: number }>;
  return { text: body.data?.text ?? "", confidence: body.data?.confidence, ms: performance.now() - started };
}

const CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac"];

export function recorderSupported(): boolean {
  return typeof MediaRecorder !== "undefined";
}

/** First container the browser will encode. Chromium/Firefox: webm/opus; Safari: mp4. */
export function pickMimeType(preferred?: string): string | undefined {
  if (!recorderSupported()) return undefined;
  const list = preferred ? [preferred, ...CANDIDATES] : CANDIDATES;
  return list.find((type) => MediaRecorder.isTypeSupported(type));
}

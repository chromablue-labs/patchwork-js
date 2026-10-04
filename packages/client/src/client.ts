import { PatchworkError } from "./errors";
import type { ActionOutcome, ChatMessage, ElicitationKind, ElicitationPrompt, MessagePart, PlanStep, RunResult, ThreadSummary, Transcript, VoiceOption, WriteSummary } from "./types";

// The recorder picks the container: webm/opus on Chromium and Firefox, mp4 on
// Safari. ElevenLabs sniffs the bytes, but the multipart filename still has to
// match the format it is really given.
const AUDIO_EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/aac": "aac",
  "audio/wav": "wav",
};

function utteranceName(type: string): string {
  const base = (type.split(";")[0] ?? "").trim().toLowerCase();
  return `utterance.${AUDIO_EXTENSIONS[base] ?? "webm"}`;
}

export interface PatchworkConfig {
  url: string;
  mint: () => Promise<string>;
  storageKey?: string;
  /**
   * Echo of the token's `conn` claim. Sent as Patchwork-Connection on the POST
   * that opens a run. Cannot retarget — a mismatch is 400 connection_mismatch,
   * and a header with no claim is ignored. Ids are stable; names are convenience.
   */
  connection?: string;
  /**
   * The agent's public id (`agent_…`) to open threads against. Omit to let the
   * workspace fall back to its most recently updated published agent.
   */
  agent?: string;
}

const DEFAULT_STORAGE_KEY = "patchwork.thread";
const REFRESH_SKEW_SECONDS = 10;
const PAUSED_STATES = ["awaiting_input", "awaiting_outcome"];
const THREAD_PAGE = 30;

interface Envelope<T> {
  status: "success" | "error";
  data?: T;
  pagination?: Pagination;
  error?: { message: string; code?: string };
}

export interface Pagination {
  next_cursor: string | null;
  has_more: boolean;
  limit: number;
}

interface RawThread {
  id: string;
  title: string;
  message_count: number;
  plan?: PlanStep[] | null;
  last_message: { role: string; content: string; created_at: string } | null;
  pending_elicitation: { run_id: string; kind: string; prompt: Record<string, unknown> } | null;
  pending_action: {
    run_id: string;
    tool_call_id: string;
    patch_ref: string;
    args: Record<string, unknown>;
    method?: string;
    route?: string;
    risk?: string;
  } | null;
  pending_confirmation: {
    run_id: string;
    tool_call_id: string;
    patch_ref: string;
    summary: WriteSummary | null;
    risk?: string;
  } | null;
  updated_at: string;
}

interface RawMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  parts?: MessagePart[] | null;
  created_at: string;
}

interface RawAccepted {
  run_id: string;
  thread_id: string;
  state: string;
}

interface RawRun {
  id: string;
  thread_id: string;
  state: string;
  terminal: boolean;
  cost_credits: number;
  plan?: PlanStep[] | null;
  message: { id: string; role: "user" | "assistant"; content: string; parts?: MessagePart[] | null; created_at: string } | null;
}

export interface RunStatus {
  runId: string;
  threadId: string;
  state: string;
  terminal: boolean;
  costCredits: number;
  plan: PlanStep[];
  message: ChatMessage | null;
}

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
}

export interface RealtimeConfig {
  enabled: boolean;
  key?: string;
  cluster?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rowsOf<T>(value: unknown, what: string): T[] {
  if (!Array.isArray(value)) {
    throw new PatchworkError(`Expected a list of ${what} from the Patchwork API`);
  }
  return value as T[];
}

function decodeExp(token: string): number {
  const payload = token.split(".")[1];
  if (!payload) return 0;
  try {
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const claims = JSON.parse(json) as { exp?: number };
    return claims.exp ?? 0;
  } catch {
    return 0;
  }
}

function toThreadSummary(thread: RawThread): ThreadSummary {
  return {
    id: thread.id,
    title: thread.title,
    messageCount: thread.message_count,
    plan: thread.plan ?? [],
    lastMessage: thread.last_message
      ? {
          role: thread.last_message.role,
          content: thread.last_message.content,
          createdAt: thread.last_message.created_at,
        }
      : null,
    pendingElicitation: thread.pending_elicitation
      ? {
          runId: thread.pending_elicitation.run_id,
          kind: thread.pending_elicitation.kind as ElicitationKind,
          prompt: thread.pending_elicitation.prompt as ElicitationPrompt,
        }
      : null,
    pendingAction: thread.pending_action
      ? {
          runId: thread.pending_action.run_id,
          toolCallId: thread.pending_action.tool_call_id,
          patchRef: thread.pending_action.patch_ref,
          action: {
            method: thread.pending_action.method,
            route: thread.pending_action.route,
            args: thread.pending_action.args,
          },
          risk: thread.pending_action.risk,
        }
      : null,
    pendingConfirmation: thread.pending_confirmation
      ? {
          runId: thread.pending_confirmation.run_id,
          toolCallId: thread.pending_confirmation.tool_call_id,
          patchRef: thread.pending_confirmation.patch_ref,
          summary: thread.pending_confirmation.summary,
          risk: thread.pending_confirmation.risk,
        }
      : null,
    updatedAt: thread.updated_at,
  };
}

function toChatMessage(message: RawMessage): ChatMessage {
  return { id: message.id, role: message.role, content: message.content, parts: message.parts ?? undefined, createdAt: message.created_at };
}

export class PatchworkClient {
  readonly storageKey: string;
  private cached: { token: string; exp: number } | null = null;

  constructor(private readonly config: PatchworkConfig) {
    this.storageKey = config.storageKey ?? DEFAULT_STORAGE_KEY;
  }

  get url(): string {
    return this.config.url;
  }

  async listThreads(limit = THREAD_PAGE): Promise<ThreadSummary[]> {
    const rows = await this.call<RawThread[]>("GET", `/threads?limit=${limit}`);
    return rowsOf<RawThread>(rows, "threads").map(toThreadSummary);
  }

  async createThread(): Promise<{ id: string }> {
    return this.call<{ id: string }>("POST", "/threads", this.config.agent ? { agent: this.config.agent } : {});
  }

  async getMessages(threadId: string): Promise<ChatMessage[]> {
    const rows: RawMessage[] = [];
    let cursor: string | null = null;

    do {
      const query: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const page: Envelope<RawMessage[]> = await this.callPage<RawMessage[]>(
        "GET",
        `/threads/${threadId}/messages${query}`,
      );
      rows.unshift(...rowsOf<RawMessage>(page.data ?? [], "messages"));
      cursor = page.pagination?.next_cursor ?? null;
    } while (cursor);

    return rows.map(toChatMessage);
  }

  async sendMessage(threadId: string, content: string): Promise<RunResult> {
    const accepted = await this.call<RawAccepted>("POST", `/threads/${threadId}/messages`, { content }, { sendConnection: true });
    return { runId: accepted.run_id, state: accepted.state };
  }

  async reportOutcome(runId: string, toolCallId: string, outcome: ActionOutcome): Promise<RunResult> {
    const accepted = await this.call<RawAccepted>("POST", `/runs/${runId}/outcome`, {
      tool_call_id: toolCallId,
      state: outcome.state,
      detail: outcome.detail ?? {},
    });
    return { runId: accepted.run_id, state: accepted.state };
  }

  // Approve or reject a write held at the always_ask gate. On approve the
  // runtime executes the write server-side, then continues the run (ADR-016).
  async confirmWrite(runId: string, toolCallId: string, approve: boolean, detail?: Record<string, unknown>): Promise<RunResult> {
    const accepted = await this.call<RawAccepted>("POST", `/runs/${runId}/confirm`, {
      tool_call_id: toolCallId,
      decision: approve ? "approve" : "reject",
      detail: detail ?? {},
    });
    return { runId: accepted.run_id, state: accepted.state };
  }

  async getRun(runId: string): Promise<RunStatus> {
    const raw = await this.call<RawRun>("GET", `/runs/${runId}`);
    return {
      runId: raw.id,
      threadId: raw.thread_id,
      state: raw.state,
      terminal: raw.terminal,
      costCredits: raw.cost_credits,
      plan: raw.plan ?? [],
      message: raw.message
        ? { id: raw.message.id, role: raw.message.role, content: raw.message.content, parts: raw.message.parts ?? undefined, createdAt: raw.message.created_at }
        : null,
    };
  }

  realtimeConfig(): Promise<RealtimeConfig> {
    return this.call<RealtimeConfig>("GET", "/realtime/config");
  }

  // Voice (ENG-48). These sit under /v1/voice, not /v1/loom, and don't fit the
  // JSON `call` helper: transcribe is multipart, speak returns raw audio.
  async transcribe(audio: Blob): Promise<Transcript> {
    const form = new FormData();
    form.append("audio", audio, utteranceName(audio.type));
    const token = await this.token();
    const response = await fetch(`${this.config.url}/v1/voice/transcribe`, {
      method: "POST",
      headers: this.voiceHeaders(token),
      body: form,
    });
    const envelope = (await response.json().catch(() => null)) as Envelope<Transcript> | null;
    if (!response.ok || !envelope || envelope.status === "error") {
      throw new PatchworkError(envelope?.error?.message ?? `Transcription failed (${response.status})`, envelope?.error?.code);
    }
    return envelope.data as Transcript;
  }

  async speak(text: string, voiceId?: string): Promise<Blob> {
    const token = await this.token();
    const response = await fetch(`${this.config.url}/v1/voice/speak`, {
      method: "POST",
      headers: { ...this.voiceHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice_id: voiceId }),
    });
    if (!response.ok) {
      const envelope = (await response.json().catch(() => null)) as Envelope<never> | null;
      throw new PatchworkError(envelope?.error?.message ?? `Synthesis failed (${response.status})`, envelope?.error?.code);
    }
    return response.blob();
  }

  listVoices(): Promise<VoiceOption[]> {
    return this.callVoice<VoiceOption[]>("/voices");
  }

  private voiceHeaders(token: string): Record<string, string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (this.config.connection) headers["Patchwork-Connection"] = this.config.connection;
    return headers;
  }

  private async callVoice<T>(path: string): Promise<T> {
    const token = await this.token();
    const response = await fetch(`${this.config.url}/v1/voice${path}`, { headers: this.voiceHeaders(token) });
    const envelope = (await response.json().catch(() => null)) as Envelope<T> | null;
    if (!response.ok || !envelope || envelope.status === "error") {
      throw new PatchworkError(envelope?.error?.message ?? `Request failed (${response.status})`, envelope?.error?.code);
    }
    return envelope.data as T;
  }

  // Called by the Pusher channel authorizer: mint a token, then have Patchwork
  // sign the subscription (it verifies the subject owns the thread first).
  async realtimeAuth(socketId: string, channelName: string): Promise<Record<string, unknown>> {
    const token = await this.token();
    const response = await fetch(`${this.config.url}/v1/loom/realtime/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ socket_id: socketId, channel_name: channelName }),
    });
    if (!response.ok) throw new PatchworkError("Realtime authorization failed");
    return response.json();
  }

  async awaitRun(runId: string, options: PollOptions = {}): Promise<RunStatus> {
    const intervalMs = options.intervalMs ?? 800;
    const deadline = Date.now() + (options.timeoutMs ?? 120_000);

    for (;;) {
      const status = await this.getRun(runId);
      // Stop on a terminal state OR a pause — a run that's awaiting input, an
      // action, or a confirmation is settled from the poller's point of view;
      // continuing to poll would never resolve and just burns requests.
      if (status.terminal || PAUSED_STATES.includes(status.state)) return status;
      if (Date.now() > deadline) throw new PatchworkError("Timed out waiting for the run to finish");
      await sleep(intervalMs);
    }
  }

  private async token(): Promise<string> {
    const now = Date.now() / 1000;
    if (this.cached && this.cached.exp - REFRESH_SKEW_SECONDS > now) {
      return this.cached.token;
    }
    const token = await this.config.mint();
    this.cached = { token, exp: decodeExp(token) };
    return token;
  }

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { sendConnection?: boolean } = {},
  ): Promise<T> {
    const envelope = await this.callPage<T>(method, path, body, options);
    return envelope.data as T;
  }

  private async callPage<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { sendConnection?: boolean } = {},
  ): Promise<Envelope<T>> {
    const token = await this.token();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };
    // Echo only. The token's conn claim is the authority; this header must
    // match if present. Polls, createThread, and outcome never retarget.
    if (options.sendConnection && this.config.connection) {
      headers["Patchwork-Connection"] = this.config.connection;
    }
    const response = await fetch(`${this.config.url}/v1/loom${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    let envelope: Envelope<T>;
    try {
      envelope = (await response.json()) as Envelope<T>;
    } catch {
      throw new PatchworkError(`Request failed (${response.status})`);
    }

    if (!response.ok || envelope.status === "error") {
      throw new PatchworkError(envelope.error?.message ?? `Request failed (${response.status})`, envelope.error?.code);
    }
    return envelope;
  }
}

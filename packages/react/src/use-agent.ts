import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createEngine, type Engine, type Take } from "@usepatchwork/audio";
import { CanvasBars } from "@usepatchwork/audio/visualizers";
import { usePatchworkClient } from "./provider";
import {
  PatchworkError,
  Realtime,
  toPatchworkError,
  type ActionOutcome,
  type AgentEvent,
  type AgentStatus,
  type ChatMessage,
  type Elicitation,
  type Handoff,
  type MessagePart,
  type PlanStep,
  type ProposedAction,
  type RunResult,
  type ThreadSubscription,
  type ThreadSummary,
  type WriteConfirmation,
} from "@usepatchwork/client";

// Safety net only: with realtime on, run.completed settles the send. This fires
// solely if that terminal event is genuinely dropped — well past any real run.
const FALLBACK_POLL_MS = 90000;

// Replies already spoken this session, so replay costs nothing.
const SPOKEN_CACHE_LIMIT = 24;

export interface UseAgentOptions {
  onMessage?: (message: ChatMessage) => void;
  onRunComplete?: (run: RunResult) => void;
  onHandoff?: (handoff: Handoff) => void;
  onError?: (error: PatchworkError) => void;
  // Dictation (ENG-48). When true, startVoice/stopVoice capture push-to-talk
  // audio and stopVoice returns the transcript — it does not send, and nothing
  // is spoken unless speak() is called. `voiceId` picks the synthesizer voice
  // (the platform default applies when omitted). Live back-and-forth is voice
  // mode, a later slice.
  voice?: boolean;
  voiceId?: string;
}

/**
 * Dictation (ENG-48): capture an utterance, get the text back, read a reply
 * aloud when asked. Nothing here sends or speaks on its own — that is voice
 * mode, a later slice, which is why this is one object and not ten members on
 * the hook.
 */
export interface VoiceControls {
  isListening: boolean;
  isTranscribing: boolean;
  isSpeaking: boolean;
  /** Which speak() call is sounding — the id it was given, or null. */
  speakingId: string | null;
  start: () => Promise<void>;
  /** Ends the take and resolves with the transcript. Empty when cancelled or silent. */
  stop: () => Promise<string>;
  cancel: () => void;
  speak: (text: string, id?: string) => Promise<void>;
  stopSpeaking: () => void;
  /** Attach a canvas to draw the mic while recording. */
  waveformRef: (canvas: HTMLCanvasElement | null) => void;
}

export interface UseAgent {
  messages: ChatMessage[];
  threads: ThreadSummary[];
  threadId: string | null;
  status: AgentStatus;
  elicitation: Elicitation | null;
  proposedAction: ProposedAction | null;
  pendingWrite: WriteConfirmation | null;
  handoff: Handoff | null;
  plan: PlanStep[];
  error: PatchworkError | null;
  voice: VoiceControls;
  send: (text: string) => Promise<void>;
  resolveAction: (toolCallId: string, outcome: ActionOutcome) => Promise<void>;
  confirmWrite: (toolCallId: string, approve: boolean, detail?: Record<string, unknown>) => Promise<void>;
  openThread: (id: string) => void;
  newChat: () => void;
  refreshThreads: () => Promise<void>;
}

export function useAgent(options: UseAgentOptions = {}): UseAgent {
  const client = usePatchworkClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [elicitation, setElicitation] = useState<Elicitation | null>(null);
  const [proposedAction, setProposedAction] = useState<ProposedAction | null>(null);
  const [pendingWrite, setPendingWrite] = useState<WriteConfirmation | null>(null);
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [plan, setPlan] = useState<PlanStep[]>([]);
  const [error, setError] = useState<PatchworkError | null>(null);
  const [realtimeReady, setRealtimeReady] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [speakingId, setSpeakingId] = useState<string | null>(null);

  const opts = useRef(options);
  opts.current = options;

  const threadsRef = useRef<ThreadSummary[]>(threads);
  threadsRef.current = threads;

  const realtime = useRef<Realtime | null>(null);
  const subscription = useRef<{ threadId: string; sub: ThreadSubscription } | null>(null);
  const pendingRuns = useRef<Map<string, (failed: boolean) => void>>(new Map());
  const started = useRef(false);

  const bubble = useRef<{ runId: string; id: string; finished: boolean } | null>(null);
  const bubbleCount = useRef(0);
  const pausedRunId = useRef<string | null>(null);

  const engine = useRef<Engine | null>(null);
  const take = useRef<Take | null>(null);
  const waveform = useRef<CanvasBars | null>(null);
  const speakToken = useRef(0);
  const spoken = useRef(new Map<string, Blob>());

  const fail = useCallback((value: unknown) => {
    const err = toPatchworkError(value);
    setError(err);
    setStatus("error");
    opts.current.onError?.(err);
  }, []);

  const nextBubbleId = useCallback((runId: string) => {
    bubbleCount.current += 1;
    return `${runId}:${bubbleCount.current}`;
  }, []);

  const appendDelta = useCallback(
    (runId: string, text: string, createdAt: string) => {
      const current = bubble.current;
      if (!current || current.runId !== runId || current.finished) {
        const id = nextBubbleId(runId);
        bubble.current = { runId, id, finished: false };
        setMessages((prev) => [...prev, { id, role: "assistant", content: text, createdAt }]);
        return;
      }
      const { id } = current;
      setMessages((prev) => prev.map((message) => (message.id === id ? { ...message, content: message.content + text } : message)));
    },
    [nextBubbleId],
  );

  // Finalize the current assistant bubble (or start a fresh one). `parts` carries
  // a render block (ADR-017); when a preamble streamed as deltas, the block's own
  // text part supersedes it in the same bubble, so nothing is shown twice.
  const completeAssistant = useCallback(
    (runId: string, content: string, createdAt: string, parts?: MessagePart[]) => {
      const current = bubble.current;
      if (current && current.runId === runId && !current.finished) {
        const { id } = current;
        bubble.current = { runId, id, finished: true };
        setMessages((prev) => prev.map((message) => (message.id === id ? { ...message, content, parts } : message)));
        opts.current.onMessage?.({ id, role: "assistant", content, parts, createdAt });
        return;
      }
      const id = nextBubbleId(runId);
      bubble.current = { runId, id, finished: true };
      setMessages((prev) => [...prev, { id, role: "assistant", content, parts, createdAt }]);
      opts.current.onMessage?.({ id, role: "assistant", content, parts, createdAt });
    },
    [nextBubbleId],
  );

  const refreshThreads = useCallback(async () => {
    setThreads(await client.listThreads());
  }, [client]);

  // Surface a run's pause (elicitation / proposed action / write confirmation)
  // from a thread summary. Shared by rehydration (openThread) and the polling
  // fallback (surfacePending), so a pause shows even when realtime is down.
  const applyPending = useCallback((summary?: ThreadSummary | null): boolean => {
    const pe = summary?.pendingElicitation ?? null;
    const pa = summary?.pendingAction ?? null;
    const pc = summary?.pendingConfirmation ?? null;
    if (pe) {
      pausedRunId.current = pe.runId;
      setElicitation({ kind: pe.kind, prompt: pe.prompt });
      setStatus("awaitingInput");
      return true;
    }
    if (pa) {
      pausedRunId.current = pa.runId;
      setProposedAction({ toolCallId: pa.toolCallId, patchRef: pa.patchRef, action: pa.action, risk: pa.risk });
      setStatus("awaitingAction");
      return true;
    }
    if (pc) {
      pausedRunId.current = pc.runId;
      setPendingWrite({ toolCallId: pc.toolCallId, patchRef: pc.patchRef, summary: pc.summary, risk: pc.risk });
      setStatus("awaitingConfirmation");
      return true;
    }
    return false;
  }, []);

  // Poll-path counterpart to the realtime pause events: re-read threads and show
  // the pause that this run parked on.
  const surfacePending = useCallback(
    async (runId: string): Promise<boolean> => {
      const list = await client.listThreads();
      setThreads(list);
      const summary = list.find(
        (thread) =>
          thread.pendingElicitation?.runId === runId ||
          thread.pendingAction?.runId === runId ||
          thread.pendingConfirmation?.runId === runId,
      );
      return summary ? applyPending(summary) : false;
    },
    [client, applyPending],
  );

  const openThread = useCallback(
    (id: string, summary?: ThreadSummary) => {
      setThreadId(id);
      localStorage.setItem(client.storageKey, id);
      setStatus("loadingThread");
      setElicitation(null);
      setProposedAction(null);
      setPendingWrite(null);
      setHandoff(null);
      setPlan(summary?.plan ?? []);
      setError(null);
      bubble.current = null;
      const source = summary ?? threadsRef.current.find((thread) => thread.id === id);
      client
        .getMessages(id)
        .then((history) => {
          setMessages(history);
          if (!applyPending(source)) setStatus("idle");
        })
        .catch(fail);
    },
    [client, fail, applyPending],
  );

  const newChat = useCallback(() => {
    setThreadId(null);
    setMessages([]);
    setElicitation(null);
    setProposedAction(null);
    setPendingWrite(null);
    setHandoff(null);
    setPlan([]);
    setError(null);
    setStatus("idle");
    bubble.current = null;
    localStorage.removeItem(client.storageKey);
  }, [client]);

  const settleRun = useCallback((runId: string, failed: boolean) => {
    const settle = pendingRuns.current.get(runId);
    if (settle) {
      pendingRuns.current.delete(runId);
      settle(failed);
    }
  }, []);

  const handleEvent = useCallback(
    (event: AgentEvent) => {
      if (event.type === "message.delta") {
        setStatus("streaming");
        appendDelta(event.run_id, String(event.data.text ?? ""), event.created_at);
      } else if (event.type === "message.completed") {
        completeAssistant(event.run_id, String(event.data.content ?? ""), event.created_at);
      } else if (event.type === "message.block") {
        completeAssistant(event.run_id, String(event.data.content ?? ""), event.created_at, (event.data.parts ?? []) as MessagePart[]);
      } else if (event.type === "plan.updated") {
        setPlan((event.data.steps ?? []) as PlanStep[]);
      } else if (event.type === "elicitation.requested") {
        pausedRunId.current = event.run_id;
        setStatus("awaitingInput");
        setElicitation({
          kind: event.data.kind as Elicitation["kind"],
          prompt: (event.data.prompt ?? {}) as Elicitation["prompt"],
        });
        settleRun(event.run_id, false);
      } else if (event.type === "action.proposed") {
        pausedRunId.current = event.run_id;
        setStatus("awaitingAction");
        setProposedAction({
          toolCallId: String(event.data.tool_call_id ?? ""),
          patchRef: String(event.data.patch_ref ?? ""),
          action: {
            method: event.data.method as string | undefined,
            route: event.data.route as string | undefined,
            args: (event.data.args ?? {}) as Record<string, unknown>,
          },
          risk: event.data.risk as string | undefined,
        });
        settleRun(event.run_id, false);
      } else if (event.type === "write.confirmation_requested") {
        pausedRunId.current = event.run_id;
        setStatus("awaitingConfirmation");
        setPendingWrite({
          toolCallId: String(event.data.tool_call_id ?? ""),
          patchRef: String(event.data.patch_ref ?? ""),
          summary: (event.data.summary ?? null) as WriteConfirmation["summary"],
          risk: event.data.risk as string | undefined,
        });
        settleRun(event.run_id, false);
      } else if (event.type === "handoff.requested") {
        const handed: Handoff = {
          destination: String(event.data.destination ?? ""),
          reason: event.data.reason as string | undefined,
          context: event.data.context as Record<string, unknown> | undefined,
        };
        setHandoff(handed);
        opts.current.onHandoff?.(handed);
        settleRun(event.run_id, false);
      } else if (event.type === "run.completed" || event.type === "run.failed") {
        settleRun(event.run_id, event.type === "run.failed");
      }
    },
    [appendDelta, completeAssistant, settleRun],
  );

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    client
      .listThreads()
      .then((list) => {
        setThreads(list);
        const stored = localStorage.getItem(client.storageKey);
        const resume = list.find((thread) => thread.id === stored) ?? list[0];
        if (resume) openThread(resume.id, resume);
      })
      .catch(fail);

    client
      .realtimeConfig()
      .then((config) => {
        if (config.enabled && config.key && config.cluster) {
          realtime.current = new Realtime(config.key, config.cluster, client);
          setRealtimeReady(true);
        }
      })
      .catch((error) => {
        console.warn("[patchwork] realtime unavailable, falling back to polling:", error);
      });

    return () => {
      subscription.current?.sub.unsubscribe();
      subscription.current = null;
      realtime.current?.disconnect();
      realtime.current = null;
    };
  }, [client, openThread, fail]);

  // Subscribe to the thread's channel and hand back the readiness promise, so a
  // sender can wait until we're live before publishing (Pusher never replays).
  const ensureSubscribed = useCallback(
    (id: string): Promise<void> => {
      if (!realtime.current) return Promise.resolve();
      if (subscription.current?.threadId === id) return subscription.current.sub.ready;

      subscription.current?.sub.unsubscribe();
      const sub = realtime.current.subscribeThread(id, handleEvent);
      subscription.current = { threadId: id, sub };
      return sub.ready;
    },
    [handleEvent],
  );

  useEffect(() => {
    if (!realtimeReady || !threadId) return;
    ensureSubscribed(threadId).catch(() => undefined);
  }, [realtimeReady, threadId, ensureSubscribed]);

  const awaitCompletion = useCallback(
    (runId: string) => {
      // Poll result handling: apply the latest assistant message, surface a
      // pause if the run parked on one, and reject on failure.
      const finish = async (result: { message: ChatMessage | null; state: string; plan?: PlanStep[] }) => {
        if (result.plan) setPlan(result.plan);
        if (result.message) completeAssistant(runId, result.message.content, result.message.createdAt);
        if (result.state === "awaiting_input" || result.state === "awaiting_outcome") {
          await surfacePending(runId);
        } else if (result.state === "failed") {
          throw new PatchworkError("The agent run failed", "run_failed");
        }
      };

      if (!realtime.current) {
        return client.awaitRun(runId).then(finish);
      }

      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRuns.current.delete(runId);
          client.awaitRun(runId).then(finish).then(resolve).catch(reject);
        }, FALLBACK_POLL_MS);

        pendingRuns.current.set(runId, (failed) => {
          clearTimeout(timer);
          if (failed) reject(new PatchworkError("The agent run failed", "run_failed"));
          else resolve();
        });
      });
    },
    [client, completeAssistant, surfacePending],
  );

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || status === "sending") return;

      setStatus("sending");
      setElicitation(null);
      setProposedAction(null);
      setPendingWrite(null);
      setHandoff(null);
      pausedRunId.current = null;
      setError(null);
      const userMessage: ChatMessage = {
        id: `local-${crypto.randomUUID()}`,
        role: "user",
        content,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMessage]);
      opts.current.onMessage?.(userMessage);

      try {
        let id = threadId;
        if (!id) {
          const created = await client.createThread();
          id = created.id;
          setThreadId(id);
          localStorage.setItem(client.storageKey, id);
        }

        // Be live on the channel before the run starts, or early deltas are lost.
        await ensureSubscribed(id);
        const { runId, state } = await client.sendMessage(id, content);
        await awaitCompletion(runId);
        if (pausedRunId.current === runId) {
          await refreshThreads();
          return;
        }
        opts.current.onRunComplete?.({ runId, state });
        setStatus("idle");
        await refreshThreads();
      } catch (value) {
        fail(value);
      }
    },
    [client, status, threadId, ensureSubscribed, awaitCompletion, refreshThreads, fail],
  );

  // One engine for the hook's lifetime, created lazily so importing the SDK
  // never touches Web Audio (SSR) and a consumer who never speaks never opens
  // a context. Half-duplex: no VAD, no barge-in — those are full-duplex.
  const audioEngine = useCallback((): Engine => {
    let current = engine.current;
    if (!current) {
      current = createEngine({
        bargeIn: false,
        vad: { enabled: false },
        // historyMs alone sets how fast the strip travels (width / historyMs
        // px per ms); hopMs only sets how finely it is sliced, so bar count is
        // free to choose. 2.4 s on screen at 40 ms a slice is ~60 bars: a
        // voice-memo tick strip. Slicing much finer closes the gaps and it
        // reads as one solid waveform instead.
        levels: { historyMs: 2400, hopMs: 40 },
      });
      // Every mic and playback failure reaches this bus, including a denied
      // permission prompt — which rejects the take without stop() ever being
      // called, so the control has to be released here or it stays stuck.
      current.on("error", (value) => {
        take.current = null;
        speakToken.current++;
        setIsListening(false);
        setIsTranscribing(false);
        setSpeakingId(null);
        fail(value);
      });
      engine.current = current;
    }
    return current;
  }, [fail]);

  // Speak a piece of text on demand. Dictation never speaks on its own: the UI
  // decides what gets a voice and when. `id` is echoed back as speakingId so a
  // list can mark the one message that is sounding.
  const speak = useCallback(
    async (text: string, id?: string) => {
      const body = text.trim();
      if (!body) return;
      const audio = audioEngine();
      // A second speak() supersedes the first, so stale calls must not clear
      // the new one's state when their own play() unwinds.
      const token = ++speakToken.current;
      audio.player.stop();
      setSpeakingId(id ?? body);
      try {
        await audio.unlock();
        // The platform caches the audio too; this is so pressing play a second
        // time is instant rather than a round trip. Bounded, because the blobs
        // are held in memory.
        const cacheKey = `${opts.current.voiceId ?? ""}|${body}`;
        let clip = spoken.current.get(cacheKey);
        if (!clip) {
          clip = await client.speak(body, opts.current.voiceId);
          if (spoken.current.size >= SPOKEN_CACHE_LIMIT) {
            spoken.current.delete(spoken.current.keys().next().value as string);
          }
          spoken.current.set(cacheKey, clip);
        }
        if (speakToken.current !== token) return;
        await audio.player.play(clip);
      } catch (value) {
        // Nothing worth saying is not a failure: a reply that is all code or
        // all data renders to an empty script, and the button that asked for it
        // should just do nothing.
        if (value instanceof PatchworkError && value.code === "voice_empty_text") return;
        // A superseded request that fails is not this turn's problem.
        if (speakToken.current !== token) return;
        fail(value);
      } finally {
        if (speakToken.current === token) setSpeakingId(null);
      }
    },
    [client, audioEngine, fail],
  );

  const stopSpeaking = useCallback(() => {
    speakToken.current++;
    engine.current?.player.stop();
    setSpeakingId(null);
  }, []);

  // Push-to-talk: start capturing. stopVoice ends the take and hands back the
  // transcript for the caller to put wherever it belongs — it does not send.
  const startVoice = useCallback(async () => {
    if (opts.current.voice !== true) {
      fail(new PatchworkError("Voice is not enabled. Pass { voice: true } to useAgent.", "voice_disabled"));
      return;
    }
    if (take.current) return;
    const audio = audioEngine();
    try {
      // unlock() must be the first await: the click that reached us is the
      // gesture that permits audio, and it does not survive an await.
      await audio.unlock();
      take.current = audio.mic.record();
      setIsListening(true);
    } catch (value) {
      take.current = null;
      setIsListening(false);
      fail(value);
    }
  }, [audioEngine, fail]);

  const stopVoice = useCallback(async (): Promise<string> => {
    const current = take.current;
    if (!current) return "";
    // Claim it before the first await. The control stays live while the
    // recorder finishes stopping, and a second press would otherwise transcribe
    // the same clip again and hand back a second copy of the text.
    take.current = null;
    try {
      const clip = await current.stop();
      setIsListening(false);
      if (clip.cancelled || clip.blob.size === 0) return "";
      setIsTranscribing(true);
      const { text } = await client.transcribe(clip.blob);
      return text.trim();
    } catch (value) {
      setIsListening(false);
      fail(value);
      return "";
    } finally {
      setIsTranscribing(false);
    }
  }, [client, fail]);

  // Discard the utterance instead of transcribing it — the "never mind" on a
  // push-to-talk control.
  const cancelVoice = useCallback(() => {
    const current = take.current;
    if (!current) return;
    take.current = null;
    current.cancel();
    setIsListening(false);
  }, []);

  const waveformRef = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      waveform.current?.disconnect();
      waveform.current = null;
      if (!canvas) return;
      waveform.current = new CanvasBars(canvas, {
        glide: true,
        mirrored: true,
        // What makes it ticks rather than a waveform is gap ≈ bar width, not
        // thinness on its own: at a ~5 px slot this leaves ~2 px bars.
        gap: 3,
        minHeight: 3,
        // Newest bar at the right edge, older ones pushed left.
        enterFrom: "right",
      }).connect(audioEngine().levels);
    },
    [audioEngine],
  );

  useEffect(
    () => () => {
      waveform.current?.disconnect();
      waveform.current = null;
      spoken.current.clear();
      engine.current?.close();
      engine.current = null;
      take.current = null;
    },
    [],
  );

  const voice = useMemo<VoiceControls>(
    () => ({
      isListening,
      isTranscribing,
      isSpeaking: speakingId !== null,
      speakingId,
      start: startVoice,
      stop: stopVoice,
      cancel: cancelVoice,
      speak,
      stopSpeaking,
      waveformRef,
    }),
    [isListening, isTranscribing, speakingId, startVoice, stopVoice, cancelVoice, speak, stopSpeaking, waveformRef],
  );

  const resolveAction = useCallback(
    async (toolCallId: string, outcome: ActionOutcome) => {
      const runId = pausedRunId.current;
      if (!proposedAction || proposedAction.toolCallId !== toolCallId || !runId) return;

      setProposedAction(null);
      pausedRunId.current = null;
      setStatus("sending");
      try {
        await client.reportOutcome(runId, toolCallId, outcome);
        await awaitCompletion(runId);
        if (pausedRunId.current === runId) {
          await refreshThreads();
          return;
        }
        setStatus((current) => (current === "awaitingInput" || current === "awaitingAction" ? current : "idle"));
        await refreshThreads();
      } catch (value) {
        fail(value);
      }
    },
    [client, proposedAction, awaitCompletion, refreshThreads, fail],
  );

  const confirmWrite = useCallback(
    async (toolCallId: string, approve: boolean, detail?: Record<string, unknown>) => {
      const runId = pausedRunId.current;
      if (!pendingWrite || pendingWrite.toolCallId !== toolCallId || !runId) return;

      setPendingWrite(null);
      pausedRunId.current = null;
      setStatus("sending");
      try {
        await client.confirmWrite(runId, toolCallId, approve, detail);
        await awaitCompletion(runId);
        if (pausedRunId.current === runId) {
          await refreshThreads();
          return;
        }
        setStatus((current) =>
          current === "awaitingInput" || current === "awaitingAction" || current === "awaitingConfirmation" ? current : "idle",
        );
        await refreshThreads();
      } catch (value) {
        fail(value);
      }
    },
    [client, pendingWrite, awaitCompletion, refreshThreads, fail],
  );

  return {
    messages,
    threads,
    threadId,
    status,
    elicitation,
    proposedAction,
    pendingWrite,
    handoff,
    plan,
    error,
    voice,
    send,
    resolveAction,
    confirmWrite,
    openThread,
    newChat,
    refreshThreads,
  };
}

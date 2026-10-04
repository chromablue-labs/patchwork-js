export type MessageRole = "user" | "assistant";

// Rich messages (ADR-017): a reply is an ordered list of parts. A text part is
// prose; a data part carries a `kind` + structured `payload` the consumer draws
// with a registered renderer. `content` stays the plain-text fallback.
export interface TextPart {
  type: "text";
  text: string;
}

export interface DataPart {
  type: "data";
  kind: string;
  payload: Record<string, unknown>;
  ref?: string;
}

export type MessagePart = TextPart | DataPart;

export type PlanStepStatus = "pending" | "doing" | "done";

export interface PlanStep {
  text: string;
  status: PlanStepStatus;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  parts?: MessagePart[];
  createdAt: string;
}

// A consumer supplies one renderer per data-block kind. An unknown kind falls
// back to the message's plain-text `content`.
export interface ThreadLastMessage {
  role: string;
  content: string;
  createdAt: string;
}

export interface ThreadSummary {
  id: string;
  title: string;
  messageCount: number;
  plan: PlanStep[];
  lastMessage: ThreadLastMessage | null;
  pendingElicitation: PendingElicitation | null;
  pendingAction: PendingAction | null;
  pendingConfirmation: PendingConfirmation | null;
  updatedAt: string;
}

export interface RunResult {
  runId: string;
  state: string;
}

export type AgentStatus =
  | "idle"
  | "loadingThread"
  | "sending"
  | "streaming"
  | "awaitingInput"
  | "awaitingAction"
  | "awaitingConfirmation"
  | "error";

export type ElicitationKind = "ask_user" | "ask_choice" | "confirm";

export interface ElicitationOption {
  value: string;
  label: string;
}

export interface ElicitationPrompt {
  question?: string;
  placeholder?: string;
  message?: string;
  options?: ElicitationOption[];
  multi?: boolean;
  confirm_label?: string;
  cancel_label?: string;
}

export interface Elicitation {
  kind: ElicitationKind;
  prompt: ElicitationPrompt;
}

export interface PendingElicitation extends Elicitation {
  runId: string;
}

export interface Handoff {
  destination: string;
  reason?: string;
  context?: Record<string, unknown>;
}

export interface Transcript {
  text: string;
  confidence?: number;
}

export interface VoiceOption {
  id: string;
  name: string;
  category?: string;
  preview_url?: string;
}

export interface ProposedAction {
  toolCallId: string;
  patchRef: string;
  action: { method?: string; route?: string; args: Record<string, unknown> };
  risk?: string;
}

export interface PendingAction extends ProposedAction {
  runId: string;
}

export type OutcomeState = "occurred" | "failed";

export interface ActionOutcome {
  state: OutcomeState;
  detail?: Record<string, unknown>;
}

// A server-executed write held at the always_ask gate. The consumer renders the
// summary and approves/rejects; on approval the runtime executes it (ADR-016).
export interface WriteSummaryField {
  name: string;
  label: string;
  value: unknown;
  in: "path" | "query" | "body";
}

export interface WriteSummary {
  title?: string;
  description?: string;
  action: { method?: string; route?: string };
  fields: WriteSummaryField[];
  risk?: string;
  warnings: string[];
}

export interface WriteConfirmation {
  toolCallId: string;
  patchRef: string;
  summary: WriteSummary | null;
  risk?: string;
}

export interface PendingConfirmation extends WriteConfirmation {
  runId: string;
}

import Pusher, { type Channel } from "pusher-js";
import type { PatchworkClient } from "./client";

export type AgentEventOrigin = "agent" | "mcp" | "playground" | "api" | (string & {});

export interface AgentEventSource {
  kind: "run" | "request" | (string & {});
  id: string;
}

export interface AgentEventContext {
  workspace_id?: string;
  connection_id?: string;
  agent_id?: string;
  agent_key?: string;
  thread_id?: string;
  subject_ref?: string;
  product?: string;
}

export interface AgentEvent {
  id: string;
  type: string;
  run_id: string;
  thread_id: string;
  created_at: string;
  seq: number | null;
  origin: AgentEventOrigin;
  source: AgentEventSource;
  parent: string | null;
  context: AgentEventContext;
  data: Record<string, unknown>;
}

export interface ThreadSubscription {
  ready: Promise<void>;
  unsubscribe: () => void;
}

const EVENT_TYPES = [
  "run.started",
  "message.delta",
  "tool_call.started",
  "tool_call.completed",
  "message.completed",
  "message.block",
  "plan.updated",
  "elicitation.requested",
  "action.proposed",
  "write.confirmation_requested",
  "handoff.requested",
  "run.completed",
  "run.failed",
];

export class Realtime {
  private pusher: Pusher;

  constructor(key: string, cluster: string, client: PatchworkClient) {
    this.pusher = new Pusher(key, {
      cluster,
      channelAuthorization: {
        endpoint: `${client.url}/v1/loom/realtime/auth`,
        transport: "ajax",
        customHandler: (params, callback) => {
          client
            .realtimeAuth(params.socketId, params.channelName)
            .then((data) => callback(null, data as { auth: string; channel_data?: string; shared_secret?: string }))
            .catch((error) => callback(error as Error, null));
        },
      },
    });
  }

  subscribeThread(threadId: string, onEvent: (event: AgentEvent) => void): ThreadSubscription {
    const channelName = `private-thread-${threadId}`;
    const channel: Channel = this.pusher.subscribe(channelName);

    // Resolves once the channel is live — the sender awaits this so no early
    // deltas are published before we're subscribed (Pusher doesn't replay).
    const ready = new Promise<void>((resolve, reject) => {
      if (channel.subscribed) {
        resolve();
        return;
      }
      channel.bind("pusher:subscription_succeeded", () => resolve());
      channel.bind("pusher:subscription_error", () => reject(new Error("channel subscription failed")));
    });

    const bound = EVENT_TYPES.map((type) => {
      const handler = (data: AgentEvent) => onEvent(data);
      channel.bind(type, handler);
      return { type, handler };
    });

    const unsubscribe = () => {
      bound.forEach(({ type, handler }) => channel.unbind(type, handler));
      this.pusher.unsubscribe(channelName);
    };

    return { ready, unsubscribe };
  }

  disconnect(): void {
    this.pusher.disconnect();
  }
}

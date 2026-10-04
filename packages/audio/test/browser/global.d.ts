// Typed view of what harness.html and the tests put on window, so page.evaluate bodies typecheck.
type AudioModule = typeof import("../../src/index");
type VisualizersModule = typeof import("../../src/visualizers");

declare global {
  interface Window {
    A: AudioModule;
    VZ: VisualizersModule;
    E: InstanceType<AudioModule["Engine"]>;
    ready: boolean;
    log: string[];
    errors: { code: string; recoverable: boolean; message: string }[];
    V: Record<string, unknown>[];
    locked?: { activeBefore: boolean | null; stateAtBirth: string; attempt: string; stateAfter: string; activeAfter: boolean | null };
    gesture?: () => unknown;
    gestureResult?: Promise<unknown>;
  }
}

export {};

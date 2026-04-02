/**
 * forked-subagent.ts
 *
 * Spawns a background subagent that runs in complete isolation from the
 * parent agent's context. Results are reported back via an EventEmitter
 * callback, so the parent never has to poll or hold the result in its
 * own context window.
 *
 * Inspired by Claude Code's KAIROS autoDream: a forked subagent handles
 * heavy work (memory consolidation, research, etc.) without polluting the
 * main agent's context.
 *
 * Design principles:
 * 1. Forked subagent runs in its own session — no shared message history
 * 2. Results arrive as typed events, not return values
 * 3. Parent context stays clean regardless of what the subagent does
 * 4. Strict typing via Zod for all task definitions
 */

import { EventEmitter } from "node:events";
import { checkpoint } from "../orla-proactive/checkpoint.js";
import { registerSubagentRun } from "./subagent-registry.js";
import {
  type SpawnSubagentParams,
  type SpawnSubagentContext,
  spawnSubagentDirect,
} from "./subagent-spawn.js";

// ---------------------------------------------------------------------------
// Task result types
// ---------------------------------------------------------------------------

export type ForkedSubagentStatus =
  | "spawning"
  | "running"
  | "completed"
  | "timeout"
  | "error"
  | "killed";

export interface ForkedSubagentResult<T = unknown> {
  status: ForkedSubagentStatus;
  childSessionKey?: string;
  runId?: string;
  output?: string;
  error?: string;
  statsLine?: string;
  /** Parsed payload — undefined if parsing failed or output is not JSON */
  payload?: T;
  durationMs?: number;
}

export interface ForkedSubagentEvents<T = unknown> {
  result: (result: ForkedSubagentResult<T>) => void;
  error: (err: Error) => void;
}

// ---------------------------------------------------------------------------
// Task definition schema (Zod)
// ---------------------------------------------------------------------------

import { z } from "zod";

export const ForkedTaskOptionsSchema = z.object({
  /** Human-readable label for logging and debugging */
  label: z.string().optional(),
  /** Optional run timeout in seconds (0 = no timeout) */
  runTimeoutSeconds: z.number().int().min(0).optional(),
  /** Cleanup policy for the child session after completion */
  cleanup: z.enum(["delete", "keep"]).default("delete"),
  /** Sandbox inheritance mode */
  sandbox: z.enum(["inherit", "require"]).default("inherit"),
  /** Set to true to receive completion even if parent session ends first */
  expectsCompletionMessage: z.boolean().default(true),
});

export type ForkedTaskOptions = z.infer<typeof ForkedTaskOptionsSchema>;

// ---------------------------------------------------------------------------
// Internal event types (mirrors internal-events.ts but for forked subagents)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface _ForkedTaskCompletionInternalEvent {
  type: "forked_task_completion";
  childSessionKey: string;
  taskLabel: string;
  status: ForkedSubagentStatus;
  result: string;
  statsLine?: string;
}

/**
 * Parses subagent completion output, looking for a typed result marker.
 * The subagent is expected to end its final message with:
 *
 *   <<<FORK_RESULT>>>
 *   { "key": "value" }
 *   <<<FORK_RESULT_END>>>
 *
 * If markers are absent, the full text is returned as `output`.
 */
export function parseForkedResult<T = unknown>(rawText: string): { output: string; payload?: T } {
  const marker = "<<<FORK_RESULT>>>";
  const endMarker = "<<<FORK_RESULT_END>>>";
  const markerIdx = rawText.indexOf(marker);
  if (markerIdx === -1) {
    return { output: rawText.trim(), payload: undefined };
  }
  const start = markerIdx + marker.length;
  const endIdx = rawText.indexOf(endMarker, start);
  const jsonStr = endIdx !== -1 ? rawText.slice(start, endIdx).trim() : rawText.slice(start).trim();
  let payload: T | undefined;
  try {
    payload = JSON.parse(jsonStr) as T;
  } catch {
    // Not JSON — caller can still use output
  }
  const textBefore = rawText.slice(0, markerIdx).trim();
  const textAfter = endIdx !== -1 ? rawText.slice(endIdx + endMarker.length).trim() : "";
  const output = (textBefore + textAfter).trim() || "";
  return { output, payload };
}

// ---------------------------------------------------------------------------
// ForkedSubagentHandle
// ---------------------------------------------------------------------------

export class ForkedSubagentHandle<T = unknown> extends EventEmitter {
  private readonly task: string;
  private readonly taskCtx: SpawnSubagentContext;
  private readonly options: ForkedTaskOptions;
  private readonly startTime: number;

  private status: ForkedSubagentStatus = "spawning";
  private childSessionKey?: string;
  private runId?: string;
  private completed = false;

  constructor(task: string, ctx: SpawnSubagentContext, options: Partial<ForkedTaskOptions> = {}) {
    super();
    this.task = task;
    this.taskCtx = ctx;
    this.options = ForkedTaskOptionsSchema.parse(options);
    this.startTime = Date.now();

    // Spawn immediately — no await in constructor, but we track status
    this.#spawn().catch((err) => {
      this.#deliverResult({ status: "error", error: String(err) });
    });
  }

  get sessionKey(): string | undefined {
    return this.childSessionKey;
  }

  get currentStatus(): ForkedSubagentStatus {
    return this.status;
  }

  /**
   * Returns a promise that resolves when the forked subagent completes.
   * Use this OR the `result` event — not both for the same purpose.
   */
  waitForCompletion(): Promise<ForkedSubagentResult<T>> {
    return new Promise((resolve) => {
      this.once("result", (result) => {
        resolve(result);
      });
      this.once("error", (err) => {
        resolve({ status: "error", error: err.message });
      });
    });
  }

  /**
   * Forcibly terminate the forked subagent session.
   */
  async kill(): Promise<void> {
    if (this.completed) {
      return;
    }
    this.status = "killed";
    if (this.childSessionKey) {
      try {
        const { callGateway } = await import("../gateway/call.js");
        await callGateway({
          method: "sessions.delete",
          params: {
            key: this.childSessionKey,
            emitLifecycleHooks: true,
            deleteTranscript: this.options.cleanup === "delete",
          },
          timeoutMs: 5_000,
        });
      } catch {
        // Best-effort
      }
    }
    this.#deliverResult({ status: "killed" });
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  async #spawn(): Promise<void> {
    // MoltClaw.Twin — checkpoint before starting long task
    try {
      const checkpointId = await checkpoint(
        this.options.label ?? "forked-subagent",
        1,
        1,
        `Starting forked subagent: ${this.task.slice(0, 50)}...`,
        [__filename],
        "Spawn subagent and wait for completion",
      );
      console.debug(`[MoltClaw.Twin] Checkpoint saved: ${checkpointId}`);
    } catch (err) {
      console.warn(`[MoltClaw.Twin] Failed to save checkpoint before spawn:`, err);
      // Don't fail the spawn if checkpointing fails
    }

    const { label, runTimeoutSeconds, cleanup, sandbox, expectsCompletionMessage } = this.options;

    const ctx: SpawnSubagentContext = {
      ...this.taskCtx,
      // Ensure forked subagents are clearly labelled
      requesterAgentIdOverride: this.taskCtx.requesterAgentIdOverride,
    };

    // Wrap the task so it knows to report structured results
    const wrappedTask = `[Background Task — ${label ?? "forked subagent"}]\n\n${this.task}\n\nWhen finished, output your conclusion, then output the marker:\n<<<FORK_RESULT>>>\n{}\n<<<FORK_RESULT_END>>>\n\nReplace {} with a JSON object of any structured data you want to pass back.`;

    const spawnResult = await spawnSubagentDirect(
      {
        task: wrappedTask,
        label: label ? `forked:${label}` : undefined,
        mode: "run",
        cleanup: cleanup ?? "delete",
        sandbox: sandbox ?? "inherit",
        runTimeoutSeconds,
        expectsCompletionMessage: expectsCompletionMessage ?? true,
      } as SpawnSubagentParams,
      ctx,
    );

    if (spawnResult.status !== "accepted") {
      this.#deliverResult({
        status: "error",
        error: spawnResult.error ?? "Spawn rejected",
        childSessionKey: spawnResult.childSessionKey,
      });
      return;
    }

    this.childSessionKey = spawnResult.childSessionKey;
    this.runId = spawnResult.runId;
    this.status = "running";

    // Register the run so lifecycle events fire
    if (spawnResult.childSessionKey) {
      try {
        registerSubagentRun({
          runId: spawnResult.runId ?? "",
          childSessionKey: spawnResult.childSessionKey,
          requesterSessionKey: this.taskCtx.agentSessionKey ?? "",
          requesterDisplayKey: this.taskCtx.agentSessionKey ?? "",
          task: this.task,
          cleanup: this.options.cleanup,
          label: this.options.label,
          runTimeoutSeconds: this.options.runTimeoutSeconds,
          expectsCompletionMessage: this.options.expectsCompletionMessage,
        });
      } catch {
        // Non-fatal: registry is best-effort for tracking
      }
    }

    // Set up timeout watcher if configured
    if (runTimeoutSeconds && runTimeoutSeconds > 0) {
      const timeoutMs = runTimeoutSeconds * 1000;
      setTimeout(() => {
        if (!this.completed && this.status === "running") {
          this.status = "timeout";
          this.#deliverResult({
            status: "timeout",
            childSessionKey: this.childSessionKey,
            runId: this.runId,
          });
        }
      }, timeoutMs);
    }

    // MoltClaw.Twin — checkpoint after successful spawn
    try {
      const checkpointId = await checkpoint(
        this.options.label ?? "forked-subagent",
        2,
        2,
        "Spawn completed successfully",
        [__filename],
        "Forked subagent running — checkpoint saved",
      );
      console.debug(`[MoltClaw.Twin] Spawn checkpoint saved: ${checkpointId}`);
    } catch (err) {
      console.warn(`[MoltClaw.Twin] Failed to save spawn checkpoint:`, err);
    }
  }

  #deliverResult(
    partial: Partial<ForkedSubagentResult<T>> & { status: ForkedSubagentStatus },
  ): void {
    if (this.completed) {
      return;
    }
    this.completed = true;

    const result: ForkedSubagentResult<T> = {
      status: partial.status,
      childSessionKey: partial.childSessionKey ?? this.childSessionKey,
      runId: partial.runId ?? this.runId,
      output: partial.output,
      error: partial.error,
      statsLine: partial.statsLine,
      durationMs: Date.now() - this.startTime,
      ...(partial.payload !== undefined ? { payload: partial.payload } : {}),
    };

    this.status = result.status;
    this.emit("result", result);
  }
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * Spawns a forked subagent for a one-shot background task.
 *
 * @param task       Natural-language description of the task
 * @param ctx        Parent agent's session context
 * @param options    Task options (label, timeout, cleanup, etc.)
 * @returns          Handle to the forked subagent
 *
 * @example
 * ```ts
 * const handle = spawnForkedSubagent(
 *   "Research competitors for domain portfolio strategy and output a JSON array of findings.",
 *   { agentSessionKey: session.key },
 *   { label: "domain-research", runTimeoutSeconds: 120 }
 * );
 *
 * handle.on("result", (res) => {
 *   if (res.status === "completed" && res.payload) {
 *     const findings = res.payload as DomainFinding[];
 *     // ... process results
 *   }
 * });
 * ```
 */
export function spawnForkedSubagent<T = unknown>(
  task: string,
  ctx: SpawnSubagentContext,
  options?: ForkedTaskOptions,
): ForkedSubagentHandle<T> {
  return new ForkedSubagentHandle<T>(task, ctx, options);
}

// ---------------------------------------------------------------------------
// Convenience: listen to a forked subagent result exactly once
// ---------------------------------------------------------------------------

export function onForkedResult<T = unknown>(
  handle: ForkedSubagentHandle<T>,
  cb: (result: ForkedSubagentResult<T>) => void,
): () => void {
  const listener = (result: ForkedSubagentResult<T>) => cb(result);
  handle.on("result", listener);
  return () => handle.off("result", listener);
}

/**
 * proactive-agent.ts
 *
 * Implements PROACTIVE_MODE — autonomous agent actions within GREEN-tier boundaries.
 * YELLOW and RED tier actions still require explicit confirmation.
 *
 * The proactive agent wraps the main agent and can:
 * - Monitor context and take preemptive actions
 * - Suggest (not execute) YELLOW/RED tier actions
 * - Execute GREEN-tier actions autonomously
 * - Track decision patterns and predict what Abdullah would want
 *
 * This is Phase 2-3 territory: operates autonomously within safe boundaries,
 * escalates uncertain decisions to Abdullah.
 */

import { z } from "zod";
import { isEnabled, PROACTIVE_MODE } from "../feature-flags/flags.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const ProactiveConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** GREEN tier: autonomous. YELLOW: suggest only. RED: never without confirm. */
  maxAutonomousTier: z.enum(["GREEN", "YELLOW"]).default("GREEN"),
  /** Seconds between proactive checks when idle */
  checkIntervalMs: z.number().default(30_000),
  /** Enable predictive suggestions */
  predictiveMode: z.boolean().default(true),
  /** Max suggestions to queue before prompting user */
  maxSuggestionQueue: z.number().default(5),
});

export type ProactiveConfig = z.infer<typeof ProactiveConfigSchema>;

// ---------------------------------------------------------------------------
// Action Tier
// ---------------------------------------------------------------------------

export type ActionTier = "GREEN" | "YELLOW" | "RED";

export const TIER_THRESHOLDS: Record<string, ActionTier> = {
  "file:read": "GREEN",
  "file:glob": "GREEN",
  "file:grep": "GREEN",
  "web:search": "GREEN",
  "web:fetch": "GREEN",
  "memory:read": "GREEN",
  "memory:write": "GREEN",
  "analytics:read": "GREEN",
  "file:write": "YELLOW",
  "file:edit": "YELLOW",
  "exec:read": "YELLOW",
  "exec:write": "RED",
  "api:external": "RED",
  "message:send": "RED",
  "credential:access": "RED",
  "delete:*": "RED",
};

export function getActionTier(action: string): ActionTier {
  // Check exact match first
  if (TIER_THRESHOLDS[action]) {
    return TIER_THRESHOLDS[action];
  }
  // Check wildcard patterns
  for (const [pattern, tier] of Object.entries(TIER_THRESHOLDS)) {
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      if (action.startsWith(prefix)) {
        return tier;
      }
    }
  }
  return "RED"; // Default to safest
}

// ---------------------------------------------------------------------------
// Suggestion
// ---------------------------------------------------------------------------

export interface Suggestion {
  id: string;
  action: string;
  params: Record<string, unknown>;
  tier: ActionTier;
  reason: string;
  predicted: boolean; // true if predicted proactively, false if reactive
  timestamp: number;
  payload?: unknown;
}

// ---------------------------------------------------------------------------
// Proactive Engine
// ---------------------------------------------------------------------------

export class ProactiveAgent {
  private config: ProactiveConfig;
  private suggestionQueue: Suggestion[] = [];
  private isRunning = false;
  private checkTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<ProactiveConfig> = {}) {
    this.config = ProactiveConfigSchema.parse(config);
  }

  get enabled(): boolean {
    return this.config.enabled && isEnabled(PROACTIVE_MODE);
  }

  get queue(): Suggestion[] {
    return [...this.suggestionQueue];
  }

  get queueDepth(): number {
    return this.suggestionQueue.length;
  }

  // ─── Decision Engine ─────────────────────────────────────────────────────

  /**
   * Evaluate a context snapshot and generate proactive suggestions.
   * Called periodically or after significant events.
   */
  async evaluate(context: {
    recentFiles?: string[];
    recentExecutions?: string[];
    memoryPressure?: number; // 0-1
    idleMinutes?: number;
    pendingTasks?: string[];
    lastSuggestionTime?: number;
  }): Promise<Suggestion[]> {
    if (!this.enabled) {
      return [];
    }

    const suggestions: Suggestion[] = [];

    // 1. Memory pressure cleanup
    if (context.memoryPressure && context.memoryPressure > 0.8) {
      suggestions.push({
        id: crypto.randomUUID(),
        action: "memory:consolidate",
        params: { threshold: context.memoryPressure },
        tier: "GREEN",
        reason: `Memory pressure at ${(context.memoryPressure * 100).toFixed(0)}% — consolidation recommended`,
        predicted: true,
        timestamp: Date.now(),
      });
    }

    // 2. Idle dream trigger
    if (context.idleMinutes && context.idleMinutes >= 5) {
      suggestions.push({
        id: crypto.randomUUID(),
        action: "kairos:autoDream",
        params: { idleMinutes: context.idleMinutes },
        tier: "GREEN",
        reason: `User idle ${context.idleMinutes}m — autoDream window`,
        predicted: true,
        timestamp: Date.now(),
      });
    }

    // 3. Domain portfolio health check (Abdullah's priority)
    if (context.pendingTasks?.some((t) => t.includes("domain"))) {
      suggestions.push({
        id: crypto.randomUUID(),
        action: "domain:healthCheck",
        params: {},
        tier: "GREEN",
        reason: "Domain portfolio task pending — proactive health check",
        predicted: true,
        timestamp: Date.now(),
      });
    }

    // 4. Predict next action based on patterns (Phase 3 territory)
    if (this.config.predictiveMode && context.recentExecutions) {
      const predictions = this.predictNextAction(context.recentExecutions);
      for (const pred of predictions) {
        if (pred.confidence > 0.7) {
          suggestions.push({
            id: crypto.randomUUID(),
            action: pred.action,
            params: pred.params || {},
            tier: getActionTier(pred.action),
            reason: `Predicted: ${pred.reason}`,
            predicted: true,
            timestamp: Date.now(),
          });
        }
      }
    }

    // Filter by maxAutonomousTier
    const maxTier: ActionTier = this.config.maxAutonomousTier;
    const tierOrder: ActionTier[] = ["GREEN", "YELLOW", "RED"];
    const maxTierIndex = tierOrder.indexOf(maxTier);

    const filtered = suggestions.filter((s) => {
      const suggestionTierIndex = tierOrder.indexOf(s.tier);
      return suggestionTierIndex <= maxTierIndex;
    });

    // Add to queue
    for (const s of filtered) {
      if (!this.suggestionQueue.find((q) => q.id === s.id)) {
        this.suggestionQueue.push(s);
      }
    }

    // Trim queue
    if (this.suggestionQueue.length > this.config.maxSuggestionQueue) {
      this.suggestionQueue = this.suggestionQueue.slice(-this.config.maxSuggestionQueue);
    }

    return filtered;
  }

  /**
   * Predict next action based on execution history.
   * Simple pattern matching — Phase 3 will use embedding similarity.
   */
  private predictNextAction(recentExecutions: string[]): Array<{
    action: string;
    params?: Record<string, unknown>;
    reason: string;
    confidence: number;
  }> {
    const predictions: Array<{
      action: string;
      params?: Record<string, unknown>;
      reason: string;
      confidence: number;
    }> = [];

    // Pattern: after web:search often comes web:fetch
    const lastActions = new Set(recentExecutions.slice(-3));
    if (lastActions.has("web:search")) {
      predictions.push({
        action: "web:fetch",
        params: {},
        reason: "web:search was just executed — likely need to fetch results",
        confidence: 0.75,
      });
    }

    // Pattern: after file:read often comes file:edit
    if (lastActions.has("file:read")) {
      predictions.push({
        action: "file:edit",
        params: {},
        reason: "file:read just happened — often followed by edit",
        confidence: 0.6,
      });
    }

    // Pattern: domain research cycle
    if (lastActions.has("web:search") && lastActions.has("memory:write")) {
      predictions.push({
        action: "domain:outbound",
        params: {},
        reason: "domain research cycle detected — prepare outreach",
        confidence: 0.8,
      });
    }

    return predictions;
  }

  // ─── Queue Management ─────────────────────────────────────────────────────

  /**
   * Dequeue the next GREEN-tier action for autonomous execution.
   * Returns null if queue is empty or next item is YELLOW/RED.
   */
  dequeueGreen(): Suggestion | null {
    const idx = this.suggestionQueue.findIndex((s) => s.tier === "GREEN");
    if (idx === -1) {
      return null;
    }
    return this.suggestionQueue.splice(idx, 1)[0];
  }

  /**
   * Dequeue a specific suggestion by ID.
   */
  dequeue(id: string): Suggestion | null {
    const idx = this.suggestionQueue.findIndex((s) => s.id === id);
    if (idx === -1) {
      return null;
    }
    return this.suggestionQueue.splice(idx, 1)[0];
  }

  /**
   * Confirm a YELLOW/RED suggestion for execution (Abdullah approved).
   */
  approve(id: string): Suggestion | null {
    return this.dequeue(id);
  }

  /**
   * Reject a suggestion (Abdullah said no).
   */
  reject(id: string): void {
    this.dequeue(id);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    this.isRunning = true;
    this.checkTimer = setInterval(() => {
      void this.periodicCheck();
    }, this.config.checkIntervalMs);
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
    }
  }

  private async periodicCheck(): Promise<void> {
    // Placeholder: in production, this would gather context and evaluate
    // For now, just trim old suggestions (>1 hour)
    const oneHourAgo = Date.now() - 3_600_000;
    this.suggestionQueue = this.suggestionQueue.filter((s) => s.timestamp > oneHourAgo);
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let proactiveInstance: ProactiveAgent | null = null;

export function getProactiveAgent(config?: Partial<ProactiveConfig>): ProactiveAgent {
  if (!proactiveInstance) {
    proactiveInstance = new ProactiveAgent(config);
  }
  return proactiveInstance;
}

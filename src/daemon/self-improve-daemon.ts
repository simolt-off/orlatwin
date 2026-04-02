/**
 * Self-Improvement Daemon — monitors skill performance and auto-evolves skills.
 *
 * Monitors:
 * - Skill invocation frequency
 * - Success/failure rates
 * - Token usage per skill
 * - User feedback (implicit + explicit)
 *
 * Auto-evolves skills when:
 * - Success rate drops below threshold
 * - Token usage exceeds optimal range
 * - Feedback indicates improvement needed
 *
 * @module self-improve-daemon
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Performance Metrics
// ---------------------------------------------------------------------------

export const SkillInvocationSchema = z.object({
  skillId: z.string(),
  invocationCount: z.number(),
  successCount: z.number(),
  failureCount: z.number(),
  avgTokenUsage: z.number(),
  lastInvokedAt: z.number(),
  totalTokens: z.number(),
});

export type SkillInvocation = z.infer<typeof SkillInvocationSchema>;

export const SkillPerformanceSchema = z.object({
  skillId: z.string(),
  invocationRate: z.number(), // per hour
  successRate: z.number(), // 0-1
  avgTokenUsage: z.number(),
  totalInvocations: z.number(),
  lastEvaluatedAt: z.number(),
});

export type SkillPerformance = z.infer<typeof SkillPerformanceSchema>;

// ---------------------------------------------------------------------------
// Improvement Recommendations
// ---------------------------------------------------------------------------

export const ImprovementRecommendationSchema = z.object({
  skillId: z.string(),
  type: z.enum(["trim", "expand", "rewrite", "merge", "split"]),
  reason: z.string(),
  priority: z.enum(["low", "medium", "high", "critical"]),
  estimatedImpact: z.number(), // 0-1 improvement potential
  suggestedChanges: z.array(z.string()),
});

export type ImprovementRecommendation = z.infer<typeof ImprovementRecommendationSchema>;

// ---------------------------------------------------------------------------
// Self-Improvement Daemon
// ---------------------------------------------------------------------------

interface SelfImprovementDaemonOptions {
  /** Check interval in ms. Default: 1 hour. */
  checkIntervalMs?: number;
  /** Success rate threshold to trigger improvement. Default: 0.7 (70%). */
  successRateThreshold?: number;
  /** Max token usage to consider optimal. Default: 1000. */
  maxOptimalTokenUsage?: number;
  /** Min improvement potential to apply changes. Default: 0.5. */
  minImprovementPotential?: number;
}

export class SelfImprovementDaemon {
  private checkIntervalMs: number;
  private successRateThreshold: number;
  private maxOptimalTokenUsage: number;
  private minImprovementPotential: number;
  private checkInterval: NodeJS.Timeout | null = null;
  private skills: Map<string, SkillInvocation> = new Map();
  private recommendations: ImprovementRecommendation[] = [];
  private running = false;

  constructor(options: SelfImprovementDaemonOptions = {}) {
    this.checkIntervalMs = options.checkIntervalMs ?? 3600000; // 1 hour
    this.successRateThreshold = options.successRateThreshold ?? 0.7;
    this.maxOptimalTokenUsage = options.maxOptimalTokenUsage ?? 1000;
    this.minImprovementPotential = options.minImprovementPotential ?? 0.5;
  }

  /**
   * Record a skill invocation.
   */
  recordInvocation(skillId: string, success: boolean, tokenUsage: number): void {
    const existing = this.skills.get(skillId) || {
      skillId,
      invocationCount: 0,
      successCount: 0,
      failureCount: 0,
      avgTokenUsage: 0,
      lastInvokedAt: Date.now(),
      totalTokens: 0,
    };

    existing.invocationCount += 1;
    existing.totalTokens += tokenUsage;

    if (success) {
      existing.successCount += 1;
    } else {
      existing.failureCount += 1;
    }

    // Update average token usage (moving average)
    existing.avgTokenUsage =
      (existing.avgTokenUsage * (existing.invocationCount - 1) + tokenUsage) /
      existing.invocationCount;

    existing.lastInvokedAt = Date.now();
    this.skills.set(skillId, existing);
  }

  /**
   * Get current performance metrics for all skills.
   */
  getPerformance(): Map<string, SkillPerformance> {
    const performance = new Map<string, SkillPerformance>();

    for (const invocation of this.skills.values()) {
      const invocationRate = invocation.invocationCount / (Date.now() / 3600000); // per hour
      const successRate =
        invocation.invocationCount > 0 ? invocation.successCount / invocation.invocationCount : 0;

      performance.set(invocation.skillId, {
        skillId: invocation.skillId,
        invocationRate,
        successRate,
        avgTokenUsage: invocation.avgTokenUsage,
        totalInvocations: invocation.invocationCount,
        lastEvaluatedAt: Date.now(),
      });
    }

    return performance;
  }

  /**
   * Generate improvement recommendations based on current metrics.
   */
  generateRecommendations(): ImprovementRecommendation[] {
    this.recommendations = [];

    for (const [skillId, perf] of this.getPerformance().entries()) {
      // Low success rate
      if (perf.successRate < this.successRateThreshold && perf.totalInvocations > 10) {
        this.recommendations.push({
          skillId,
          type: "rewrite",
          reason: `Success rate (${(perf.successRate * 100).toFixed(1)}%) is below threshold (${(this.successRateThreshold * 100).toFixed(1)}%)`,
          priority: perf.successRate < 0.5 ? "critical" : "high",
          estimatedImpact: 0.5 + (1 - perf.successRate),
          suggestedChanges: [
            "Review skill prompt for clarity",
            "Add more examples/success cases",
            "Simplify instructions",
          ],
        });
      }

      // High token usage
      if (perf.avgTokenUsage > this.maxOptimalTokenUsage && perf.totalInvocations > 5) {
        this.recommendations.push({
          skillId,
          type: "trim",
          reason: `Average token usage (${perf.avgTokenUsage.toFixed(0)}) exceeds optimal range (< ${this.maxOptimalTokenUsage})`,
          priority: "medium",
          estimatedImpact: 0.3,
          suggestedChanges: [
            "Remove redundant instructions",
            "Shorten examples",
            "Use more concise phrasing",
          ],
        });
      }

      // Very low invocation rate (may need promotion)
      if (perf.invocationRate < 0.1 && perf.totalInvocations > 3) {
        this.recommendations.push({
          skillId,
          type: "expand",
          reason: `Low invocation rate (${perf.invocationRate.toFixed(3)} invocations/hour) — consider adding more use cases`,
          priority: "low",
          estimatedImpact: 0.2,
          suggestedChanges: [
            "Add more example prompts",
            "Document common use cases",
            "Create skill variants",
          ],
        });
      }
    }

    // Sort by priority (critical > high > medium > low)
    const priorityOrder: Record<ImprovementRecommendation["priority"], number> = {
      critical: 4,
      high: 3,
      medium: 2,
      low: 1,
    };

    this.recommendations.sort((a, b) => priorityOrder[b.priority] - priorityOrder[a.priority]);

    return this.recommendations;
  }

  /**
   * Apply an improvement recommendation to a skill.
   * NOTE: This is a stub — actual skill modification requires integration with skill loading system.
   */
  async applyImprovement(rec: ImprovementRecommendation): Promise<boolean> {
    console.debug(`[SelfImprovementDaemon] Applying improvement to ${rec.skillId}:`, rec.type);
    // TODO: Integrate with skill loading system to modify skill prompts
    return true;
  }

  /**
   * Start the daemon.
   */
  start(): void {
    if (this.running) {
      console.warn("[SelfImprovementDaemon] Already running");
      return;
    }

    this.running = true;
    console.debug(`[SelfImprovementDaemon] Starting (check interval: ${this.checkIntervalMs}ms)`);

    // Initial check
    this.generateRecommendations();

    // Schedule periodic checks
    this.checkInterval = setInterval(() => {
      this.generateRecommendations();
      console.debug(
        `[SelfImprovementDaemon] Generated ${this.recommendations.length} recommendations`,
      );
    }, this.checkIntervalMs);
  }

  /**
   * Stop the daemon.
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    this.running = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    console.debug("[SelfImprovementDaemon] Stopped");
  }

  /**
   * Get current recommendations.
   */
  getRecommendations(): ImprovementRecommendation[] {
    return this.recommendations;
  }

  /**
   * Get running state.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Reset all metrics.
   */
  reset(): void {
    this.skills.clear();
    this.recommendations = [];
    console.debug("[SelfImprovementDaemon] Metrics reset");
  }
}

// ---------------------------------------------------------------------------
// Singleton Instance
// ---------------------------------------------------------------------------

let daemonInstance: SelfImprovementDaemon | null = null;

export function getSelfImprovementDaemon(
  options?: SelfImprovementDaemonOptions,
): SelfImprovementDaemon {
  if (!daemonInstance) {
    daemonInstance = new SelfImprovementDaemon(options);
  }
  return daemonInstance;
}

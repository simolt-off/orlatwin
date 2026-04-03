/**
 * Skill Invocation Tracker — records skill invocations for Self-Improvement Daemon
 *
 * Integrates with the Self-Improvement Daemon to track:
 * - Skill invocation frequency
 * - Success/failure rates
 * - Token usage per skill
 */

import { getSelfImprovementDaemon } from "../../daemon/self-improve-daemon.js";

/**
 * Record a skill invocation.
 *
 * @param skillName - The name of the skill that was invoked
 * @param success - Whether the invocation succeeded
 * @param tokenUsage - Estimated token usage for this invocation
 */
export function recordSkillInvocation(
  skillName: string,
  success: boolean,
  tokenUsage: number,
): void {
  try {
    const daemon = getSelfImprovementDaemon();
    daemon.recordInvocation(skillName, success, tokenUsage);
  } catch (error) {
    // Silently fail - daemon may not be running
    console.debug(`[SkillInvocationTracker] Failed to record invocation: ${error}`);
  }
}

/**
 * Get current skill performance metrics.
 */
export function getSkillPerformance(): Map<string, any> {
  try {
    const daemon = getSelfImprovementDaemon();
    return daemon.getPerformance();
  } catch (error) {
    console.debug(`[SkillInvocationTracker] Failed to get performance: ${error}`);
    return new Map();
  }
}

/**
 * Get improvement recommendations.
 */
export function getSkillRecommendations(): any[] {
  try {
    const daemon = getSelfImprovementDaemon();
    return daemon.generateRecommendations();
  } catch (error) {
    console.debug(`[SkillInvocationTracker] Failed to get recommendations: ${error}`);
    return [];
  }
}

/**
 * KAIROS Agent — Background cognitive agent for memory consolidation.
 *
 * Runs in a forked subagent with its own context window.
 * Implements "suggest without acting" for external operations (Phase 2).
 * During idle, performs autoDream: memory consolidation, contradiction
 * resolution, and converting vague notes to facts.
 *
 * Inspired by Claude Code's KAIROS + autoDream.
 */

import { activateUndercoverMode, deactivateUndercoverMode } from "../daemon/undercover-mode.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  spawnSubagentDirect,
  type SpawnSubagentParams,
  type SpawnSubagentContext,
} from "./subagent-spawn.js";

const log = createSubsystemLogger("kairos-agent");

// ============================================================================
// Agent Labels & Constants
// ============================================================================

const KAIROS_AGENT_ID = "kairos";
const KAIROS_SESSION_LABEL = "kairos";

/** Dream task prompt sent to the subagent */
const DREAM_TASK_PROMPT = `[KAIROS DREAM CYCLE] Memory consolidation task.

Read the following files and perform memory consolidation:
- memory/MEMORY.md (main memory)
- memory/daily logs (memory/YYYY-MM-DD.md or similar)

Perform these tasks:
1. MERGE observations from recent sessions — add new facts, update outdated ones
2. REMOVE contradictions — if you find conflicting facts, flag them and keep the most recent
3. CONVERT vague notes — find entries like "maybe" or "not sure" and convert to concrete facts if evidence exists
4. STRUCTURE raw notes — move bullet points into organized sections
5. UPDATE MEMORY.md with consolidated findings (preserve existing structure)

Also log what you did in memory/dreams.md (create if it doesn't exist):
- Date/time of this dream cycle
- What you consolidated
- Any contradictions found
- Any gaps in memory that need attention

DO NOT make any external changes (no emails, no commits, no posts).
Only read and update internal memory files.

Use UNDERCOVER MODE: write as a generic "system" with no identity markers.
Never mention Orla, Digital Twin, KAIROS, OpenClaw, or Phase in any output file.`;

/** Proactive suggestion task */
const SUGGEST_TASK_PROMPT = `[KAIROS PROACTIVE SUGGESTION]

You are running as a background agent. Analyze the current workspace and recent activity.

For each domain Soliman manages (domains, Graphicophobia agency, Ledoux Egypt, Deka Umzug Germany, AI/automation), identify:
1. One thing that looks like it needs attention (deadline, follow-up, decision)
2. One opportunity that might be missed (market timing, lead follow-up, renewal)

Format your suggestions as:
**[SUGGESTION: action description]**
*Confidence: high/medium/low* | *Domain: X* | *Why: brief reason*

Do NOT take any action. Only suggest. External actions require Soliman's confirmation.

Use UNDERCOVER MODE: no identity markers.`;

const MEMORY_INDEX_PROMPT = `[KAIROS MEMORY INDEX] Update workspace memory index.

Scan memory/MEMORY.md and any daily logs. Build or update a quick-access index:
- Recent decisions (last 30 days)
- Active projects with their status
- Pending follow-ups or open loops
- Key contacts and their context

Write the index to memory/index.md (create or overwrite).
Keep it scannable — bullet points, not paragraphs.

Use UNDERCOVER MODE.`;

// ============================================================================
// Dream Result
// ============================================================================

export interface DreamCycleResult {
  success: boolean;
  cyclesRun: number;
  errors: string[];
  memoryUpdated: boolean;
  indexUpdated: boolean;
  suggestions: string[];
}

export interface Suggestion {
  text: string;
  confidence: "high" | "medium" | "low";
  domain: string;
  reason: string;
}

// ============================================================================
// KAIROS Agent
// ============================================================================

export class KairosAgent {
  private active = false;

  /**
   * Run a dream consolidation cycle.
   * Called by the kairos-engine when idle is detected.
   *
   * @param opts.additionalContext  Additional context to include in the dream prompt
   */
  async runDreamCycle(opts?: { additionalContext?: string }): Promise<DreamCycleResult> {
    if (this.active) {
      log.debug("kairos-agent: already running a cycle, skipping", {});
      return {
        success: false,
        cyclesRun: 0,
        errors: ["Agent already active"],
        memoryUpdated: false,
        indexUpdated: false,
        suggestions: [],
      };
    }

    this.active = true;
    activateUndercoverMode();

    try {
      log.debug("kairos-agent: starting dream cycle", {});

      // Run dream consolidation
      await this.spawnDreamSubagent(DREAM_TASK_PROMPT, opts?.additionalContext);

      // Update memory index
      await this.spawnDreamSubagent(MEMORY_INDEX_PROMPT, undefined);

      log.debug("kairos-agent: dream cycle complete", {});

      return {
        success: true,
        cyclesRun: 1,
        errors: [],
        memoryUpdated: true,
        indexUpdated: true,
        suggestions: [],
      };
    } catch (err) {
      log.error("kairos-agent: dream cycle failed", { err });
      return {
        success: false,
        cyclesRun: 0,
        errors: [String(err)],
        memoryUpdated: false,
        indexUpdated: false,
        suggestions: [],
      };
    } finally {
      this.active = false;
      deactivateUndercoverMode();
    }
  }

  /**
   * Generate proactive suggestions without acting.
   * Used in Phase 2 — suggests but waits for confirmation.
   */
  async generateSuggestions(opts?: {
    domain?: string;
    additionalContext?: string;
  }): Promise<Suggestion[]> {
    activateUndercoverMode();
    try {
      const result = await this.spawnDreamSubagent(SUGGEST_TASK_PROMPT, opts?.additionalContext);

      // Parse suggestions from the result
      const suggestions = parseSuggestions(result.outputText ?? result.summary ?? "");
      return suggestions;
    } catch (err) {
      log.error("kairos-agent: suggestions generation failed", { err });
      return [];
    } finally {
      deactivateUndercoverMode();
    }
  }

  /**
   * Spawn a KAIROS subagent with the given task.
   * Uses the FORKED subagent pattern to keep main context clean.
   */
  private async spawnDreamSubagent(
    task: string,
    additionalContext?: string,
  ): Promise<{ outputText?: string; summary?: string }> {
    const context = additionalContext ? `\n\nAdditional context:\n${additionalContext}` : "";

    const fullTask = task + context;

    const params: SpawnSubagentParams = {
      task: fullTask,
      label: KAIROS_SESSION_LABEL,
      agentId: KAIROS_AGENT_ID,
      mode: "run",
      // KAIROS subagents run quickly — consolidation shouldn't take long
      runTimeoutSeconds: 120,
      // Keep session for follow-up but clean up after
      cleanup: "delete",
      // Don't expose KAIROS identity in spawned agent
      expectsCompletionMessage: false,
    };

    try {
      const result = await spawnSubagentDirect(params, {} as SpawnSubagentContext);
      return {
        outputText: result.childSessionKey,
        summary: result.status,
      };
    } catch (err) {
      log.error("kairos-agent: subagent spawn failed", { err });
      throw err;
    }
  }

  /**
   * Check if KAIROS agent is currently active.
   */
  isActive(): boolean {
    return this.active;
  }
}

// ============================================================================
// Suggestion Parsing
// ============================================================================

function parseSuggestions(text: string): Suggestion[] {
  const suggestions: Suggestion[] = [];
  const lines = text.split("\n");

  for (const line of lines) {
    const match = line.match(/^\*\*\[SUGGESTION:\s*(.+?)\s*\]\*\*/);
    if (match) {
      const rest = line.replace(/^\*\*\[SUGGESTION:\s*.+?\]\*\*/, "").trim();
      const confMatch = rest.match(/\*Confidence:\s*(high|medium|low)\*/i);
      const domainMatch = rest.match(/\*Domain:\s*([^*]+)\*/);
      const whyMatch = rest.match(/\*Why:\s*(.+?)\*/);

      suggestions.push({
        text: match[1].trim(),
        confidence: (confMatch?.[1]?.toLowerCase() as "high" | "medium" | "low") ?? "medium",
        domain: domainMatch?.[1]?.trim() ?? "general",
        reason: whyMatch?.[1]?.trim() ?? "",
      });
    }
  }

  return suggestions;
}

// ============================================================================
// Singleton for easy access
// ============================================================================

let _instance: KairosAgent | null = null;

export function getKairosAgent(): KairosAgent {
  if (!_instance) {
    _instance = new KairosAgent();
  }
  return _instance;
}

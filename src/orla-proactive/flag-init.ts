/**
 * orla-proactive/flag-init.ts
 *
 * Initializes Orla's PROACTIVE + KAIROS feature flags at gateway boot.
 * Reads env vars and applies overrides before any agent or cron runs.
 *
 * Env vars:
 *   ORLA_KAIROS_ENABLED=1          — enable KAIROS daemon
 *   ORLA_PROACTIVE_ENABLED=1       — enable proactive agent
 *   ORLA_AUTO_DREAM_ENABLED=1      — enable autoDream memory consolidation
 *   ORLA_UNDERCOVER_ENABLED=1      — enable undercover mode
 *   ORLA_MISSION_CONTROL_ENABLED=1 — enable mission control HUD
 *   ORLA_POINTER_INDEX=1           — use pointer-index memory
 *   ORLA_STRICT_WRITE=1            — strict write discipline
 *
 * This module is called at gateway boot to set up the flag state
 * before any agent sessions start.
 */

import { FLAGS, isFlagEnabled } from "../feature-flags/index.js";

export interface OrlaFlagStatus {
  id: string;
  enabled: boolean;
  description: string;
  source: "default" | "env";
}

const FLAG_ENV_MAP: Record<string, string> = {
  KAIROS_DAEMON: "ORLA_KAIROS_ENABLED",
  PROACTIVE_MODE: "ORLA_PROACTIVE_ENABLED",
  AUTO_DREAM: "ORLA_AUTO_DREAM_ENABLED",
  UNDERCOVER_MODE: "ORLA_UNDERCOVER_ENABLED",
  MISSION_CONTROL: "ORLA_MISSION_CONTROL_ENABLED",
  AGENCY_TEAMS: "ORLA_AGENCY_TEAMS_ENABLED",
  POINTER_INDEX: "ORLA_POINTER_INDEX_ENABLED",
  STRICT_WRITE_DISCIPLINE: "ORLA_STRICT_WRITE_ENABLED",
  SKILL_SCANNER: "ORLA_SKILL_SCANNER_ENABLED",
  FORKED_CONSOLIDATOR: "ORLA_FORKED_CONSOLIDATOR_ENABLED",
};

/**
 * Initialize all ORLA feature flags from env vars.
 * Call this at gateway boot before any agent sessions start.
 */
export function initOrlaFlags(): OrlaFlagStatus[] {
  const results: OrlaFlagStatus[] = [];

  for (const [flagId, envVar] of Object.entries(FLAG_ENV_MAP)) {
    const flag = FLAGS[flagId as keyof typeof FLAGS];
    if (!flag) {
      continue;
    }

    const envVal = process.env[envVar];
    const wasEnabled = isFlagEnabled(flagId as keyof typeof FLAGS);

    if (envVal !== undefined) {
      // Env var overrides default — set it in process.env for isFlagEnabled() to pick up
      // (isFlagEnabled checks env vars first)
      results.push({
        id: flagId,
        enabled: envVal === "true" || envVal === "1",
        description: flag.description,
        source: "env",
      });
    } else {
      results.push({
        id: flagId,
        enabled: wasEnabled,
        description: flag.description,
        source: "default",
      });
    }
  }

  return results;
}

/**
 * Get all ORLA flag statuses (for debugging/UI).
 */
export function getOrlaFlagStatuses(): OrlaFlagStatus[] {
  return Object.entries(FLAG_ENV_MAP).map(([flagId, envVar]) => {
    const flag = FLAGS[flagId as keyof typeof FLAGS];
    const envVal = process.env[envVar];
    const enabled =
      envVal !== undefined
        ? envVal === "true" || envVal === "1"
        : isFlagEnabled(flagId as keyof typeof FLAGS);

    return {
      id: flagId,
      enabled,
      description: flag?.description ?? "",
      source: envVal !== undefined ? "env" : "default",
    };
  });
}

/**
 * Check if KAIROS mode is active (either daemon or autoDream).
 */
export function isKairosActive(): boolean {
  return isFlagEnabled("KAIROS_DAEMON") || isFlagEnabled("AUTO_DREAM");
}

/**
 * Check if PROACTIVE mode is active.
 */
export function isProactiveActive(): boolean {
  return isFlagEnabled("PROACTIVE_MODE");
}

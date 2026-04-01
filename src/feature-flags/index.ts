/**
 * Orla's Feature Flags — bun:bundle style
 * Build-time dead-code elimination, zero runtime cost for disabled features.
 * Code inside inactive flags is completely stripped at build time.
 */

import { z } from "zod";

// ─── Flag Schema ─────────────────────────────────────────────────────────────

export const FeatureFlagSchema = z.object({
  id: z.string(),
  description: z.string(),
  defaultEnabled: z.boolean(),
  envVar: z.string().optional(),
  owner: z.string().optional(),
});

export type FeatureFlag = z.infer<typeof FeatureFlagSchema>;

// ─── Flag Registry ───────────────────────────────────────────────────────────

export const FLAGS = {
  /**
   * KAIROS — Always-on background daemon
   * Triggers autoDream when user is idle.
   * Performs memory consolidation without touching main context.
   */
  KAIROS_DAEMON: {
    id: "KAIROS_DAEMON",
    description: "Always-on background memory consolidation daemon (autoDream)",
    defaultEnabled: false,
    envVar: "ORLA_KAIROS_ENABLED",
    owner: "orla",
  },

  /**
   * PROACTIVE — Autonomous agent actions without prompting
   * Agent can ACT on behalf of Abdullah within GREEN-tier boundaries.
   * YELLOW/RED still require confirmation.
   */
  PROACTIVE_MODE: {
    id: "PROACTIVE_MODE",
    description: "Autonomous proactive actions without user prompting (GREEN tier only)",
    defaultEnabled: false,
    envVar: "ORLA_PROACTIVE_ENABLED",
    owner: "orla",
  },

  /**
   * AUTO_DREAM — Memory optimization while idle
   * Triggers memory consolidation when user is away.
   */
  AUTO_DREAM: {
    id: "AUTO_DREAM",
    description: "Memory consolidation during user idle time",
    defaultEnabled: false,
    envVar: "ORLA_AUTO_DREAM_ENABLED",
    owner: "orla",
  },

  /**
   * SKILL_SCANNER — Always-on security scanning
   * Continuously monitors for credential leaks, suspicious patterns.
   */
  SKILL_SCANNER: {
    id: "SKILL_SCANNER",
    description: "Always-on security scanning for credentials and suspicious activity",
    defaultEnabled: true,
    envVar: "ORLA_SKILL_SCANNER_ENABLED",
    owner: "security",
  },

  /**
   * MISSION_CONTROL — Game-like visualization UI
   * Terminal-based Mission Control for SiMolt.
   */
  MISSION_CONTROL: {
    id: "MISSION_CONTROL",
    description: "Game-like Mission Control visualization for agent operations",
    defaultEnabled: false,
    envVar: "ORLA_MISSION_CONTROL_ENABLED",
    owner: "simolt",
  },

  /**
   * AGENCY_TEAMS — Multi-agent team coordination
   * Spawns and coordinates teams of parallel agents.
   */
  AGENCY_TEAMS: {
    id: "AGENCY_TEAMS",
    description: "Multi-agent team spawning and coordination",
    defaultEnabled: false,
    envVar: "ORLA_AGENCY_TEAMS_ENABLED",
    owner: "simolt",
  },

  /**
   * UNDERCOVER_MODE — Stealth operation without attribution
   * No "Orla", no "Digital Twin", no AI markers in output.
   */
  UNDERCOVER_MODE: {
    id: "UNDERCOVER_MODE",
    description: "Stealth mode — strips all identity markers from output",
    defaultEnabled: false,
    envVar: "ORLA_UNDERCOVER_ENABLED",
    owner: "orla",
  },

  /**
   * FORKED_CONSOLIDATOR — Use forked subagent for memory consolidation
   * Keeps main context clean during heavy memory operations.
   */
  FORKED_CONSOLIDATOR: {
    id: "FORKED_CONSOLIDATOR",
    description: "Run memory consolidator in forked subagent (maintains context purity)",
    defaultEnabled: true,
    envVar: "ORLA_FORKED_CONSOLIDATOR_ENABLED",
    owner: "orla",
  },

  /**
   * POINTER_INDEX — Use pointer-index memory architecture
   * Lightweight MEMORY.md pointers + on-demand topic loading.
   */
  POINTER_INDEX: {
    id: "POINTER_INDEX",
    description: "Pointer-index memory architecture (pointer file + topic files)",
    defaultEnabled: true,
    envVar: "ORLA_POINTER_INDEX_ENABLED",
    owner: "orla",
  },

  /**
   * STRICT_WRITE_DISCIPLINE — Update index only after successful write
   * Prevents context pollution from failed operations.
   */
  STRICT_WRITE_DISCIPLINE: {
    id: "STRICT_WRITE_DISCIPLINE",
    description: "Update memory index only after confirmed successful file write",
    defaultEnabled: true,
    envVar: "ORLA_STRICT_WRITE_ENABLED",
    owner: "orla",
  },
} as const satisfies Record<string, FeatureFlag>;

// ─── Flag Resolution ─────────────────────────────────────────────────────────

type FlagId = keyof typeof FLAGS;

export function isFlagEnabled(flagId: FlagId): boolean {
  const flag = FLAGS[flagId];
  if (!flag) {
    return false;
  }

  // Check env var first (allows runtime override without rebuild)
  if (flag.envVar) {
    const envVal = process.env[flag.envVar];
    if (envVal !== undefined) {
      return envVal === "true" || envVal === "1";
    }
  }

  return flag.defaultEnabled;
}

export function getFlag(flagId: FlagId): FeatureFlag | undefined {
  return FLAGS[flagId];
}

export function listFlags(): FeatureFlag[] {
  return Object.values(FLAGS);
}

export function getEnabledFlags(): FeatureFlag[] {
  return Object.values(FLAGS).filter((f) => isFlagEnabled(f.id));
}

// ─── Deferred Import Helper ─────────────────────────────────────────────────

type DeferredModule<T> = () => Promise<{ default: T }>;

export async function importIfFlag<T>(
  flagId: FlagId,
  loader: DeferredModule<T>,
): Promise<T | null> {
  if (!isFlagEnabled(flagId)) {
    return null;
  }
  const mod = await loader();
  return mod.default;
}

// ─── Compile-Time Flag Check ────────────────────────────────────────────────
// Usage in code: if (flag('KAIROS_DAEMON')) { ... }
// The bundler (Vite/esbuild) will tree-shake unreachable branches.

export function flag(id: FlagId): boolean {
  return isFlagEnabled(id);
}

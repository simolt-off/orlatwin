/**
 * Feature flags — build-time dead-code elimination with zero runtime cost.
 *
 * Each flag is a const symbol. The ACTIVE_FLAGS set is the single source of truth
 * for which features are compiled in. Consumers use the typed getters (isEnabled)
 * rather than bare flag membership tests so the Zod schema is the only runtime surface.
 *
 * Inspired by bun:bundle feature flags that completely strip inactive code at build time.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Flag definitions
// ---------------------------------------------------------------------------

/**
 * KAIROS_DAEMON — always-on background memory consolidation daemon.
 * When enabled, a long-lived background process periodically consolidates
 * session memory, prunes stale entries, and optimises the memory store.
 */
export const KAIROS_DAEMON = Symbol("KAIROS_DAEMON");
export type KAIROS_DAEMON = typeof KAIROS_DAEMON;

/**
 * PROACTIVE_MODE — autonomous agent actions without prompting.
 * When enabled, the agent may take initiative and execute actions based on
 * context without waiting for explicit user approval.
 */
export const PROACTIVE_MODE = Symbol("PROACTIVE_MODE");
export type PROACTIVE_MODE = typeof PROACTIVE_MODE;

/**
 * AUTO_DREAM — memory optimisation while idle.
 * When enabled, background processes run consolidation and garbage-collection
 * on the memory store during low-activity periods.
 */
export const AUTO_DREAM = Symbol("AUTO_DREAM");
export type AUTO_DREAM = typeof AUTO_DREAM;

/**
 * SKILL_SCANNER — always-on security scanning for loaded skills.
 * When enabled, every skill module is audited for suspicious imports,
 * dangerous eval patterns, and policy violations before registration.
 */
export const SKILL_SCANNER = Symbol("SKILL_SCANNER");
export type SKILL_SCANNER = typeof SKILL_SCANNER;

/**
 * MISSION_CONTROL — game-like visualisation dashboard.
 * When enabled, a real-time TUI/canvas component renders agent state,
 * active tasks, memory pressure, and session health in a mission-control style.
 */
export const MISSION_CONTROL = Symbol("MISSION_CONTROL");
export type MISSION_CONTROL = typeof MISSION_CONTROL;

/**
 * AGENCY_TEAMS — multi-agent team coordination.
 * When enabled, multiple agent instances can be spawned as a coordinated team,
 * with shared context, role assignments, and intra-team messaging.
 */
export const AGENCY_TEAMS = Symbol("AGENCY_TEAMS");
export type AGENCY_TEAMS = typeof AGENCY_TEAMS;

/**
 * SELF_IMPROVE_DAEMON — monitors skill performance and auto-evolves skills.
 * When enabled, tracks skill invocation metrics, generates improvement recommendations,
 * and can automatically apply skill improvements.
 */
export const SELF_IMPROVE_DAEMON = Symbol("SELF_IMPROVE_DAEMON");
export type SELF_IMPROVE_DAEMON = typeof SELF_IMPROVE_DAEMON;

/**
 * UPSTREAM_WATCHER — monitors upstream sources (GitHub, docs) for updates.
 * When enabled, watches repositories, documentation sites, and package registries
 * for new commits, releases, and updates.
 */
export const UPSTREAM_WATCHER = Symbol("UPSTREAM_WATCHER");
export type UPSTREAM_WATCHER = typeof UPSTREAM_WATCHER;

/**
 * UNDERCOVER_MODE — stealth operation without attribution.
 * When enabled, the agent suppresses all identity signals (name, avatar, branding)
 * and operates with minimal footprint metadata.
 */
export const UNDERCOVER_MODE = Symbol("UNDERCOVER_MODE");
export type UNDERCOVER_MODE = typeof UNDERCOVER_MODE;

// ---------------------------------------------------------------------------
// Flag registry schema (Zod)
// ---------------------------------------------------------------------------

export const FeatureFlagSymbolSchema = z.symbol();
export type FeatureFlagSymbolSchema = z.infer<typeof FeatureFlagSymbolSchema>;

export const FeatureFlagDefinitionSchema = z.object({
  /** Human-readable flag name. */
  name: z.string(),
  /** One-line description of what this flag enables. */
  description: z.string(),
  /** Longer description for documentation / admin UIs. */
  longDescription: z.string().optional(),
  /** URL to design doc or RFC, if any. */
  specUrl: z.string().url().optional(),
  /** Danger level for display purposes. */
  risk: z.enum(["low", "medium", "high", "critical"]).default("low"),
});

export type FeatureFlagDefinition = z.infer<typeof FeatureFlagDefinitionSchema>;

// ---------------------------------------------------------------------------
// All known flags — single source of truth for documentation and tooling
// ---------------------------------------------------------------------------

export const ALL_FLAG_DEFINITIONS: Record<symbol, FeatureFlagDefinition> = {
  [KAIROS_DAEMON]: {
    name: "KAIROS_DAEMON",
    description: "Background memory consolidation daemon.",
    longDescription:
      "Starts a long-lived daemon that periodically prunes stale session memory, consolidates fragmented stores, and optimises embeddings. Keeps the memory subsystem lean without explicit user triggers.",
    risk: "low",
  },
  [PROACTIVE_MODE]: {
    name: "PROACTIVE_MODE",
    description: "Autonomous agent actions without prompting.",
    longDescription:
      "Allows the agent to take initiative — executing tasks, spawning sub-agents, and sending messages without waiting for explicit user approval. Use with caution in high-risk environments.",
    risk: "high",
  },
  [AUTO_DREAM]: {
    name: "AUTO_DREAM",
    description: "Memory optimisation while idle.",
    longDescription:
      "Triggers background memory maintenance during low-activity windows: defragmentation, LRU eviction of embeddings, and session summarisation. Runs only when no user interaction is pending.",
    risk: "low",
  },
  [SKILL_SCANNER]: {
    name: "SKILL_SCANNER",
    description: "Always-on security scanning for loaded skills.",
    longDescription:
      "Before every skill registration, audits the module for dangerous imports (e.g. child_process with shell: true), suspicious eval/string-concatenation patterns, and policy violations. Blocks and logs any hit.",
    risk: "low",
  },
  [MISSION_CONTROL]: {
    name: "MISSION_CONTROL",
    description: "Game-like visualisation dashboard.",
    longDescription:
      "Renders a real-time canvas/TUI panel showing active agents, memory pressure gauges, session timelines, task queues, and flag statuses in a mission-control aesthetic.",
    risk: "low",
  },
  [AGENCY_TEAMS]: {
    name: "AGENCY_TEAMS",
    description: "Multi-agent team coordination.",
    longDescription:
      "Enables the agency subsystem: spawn multiple named agents as a team, assign roles (e.g. researcher, reviewer, executor), share a team memory context, and coordinate via structured messaging protocols.",
    risk: "medium",
  },
  [SELF_IMPROVE_DAEMON]: {
    name: "SELF_IMPROVE_DAEMON",
    description: "Self-improvement daemon for skills.",
    longDescription:
      "Monitors skill performance metrics (success rate, token usage, invocation frequency) and generates improvement recommendations. Can automatically evolve skills based on performance data.",
    risk: "low",
  },
  [UPSTREAM_WATCHER]: {
    name: "UPSTREAM_WATCHER",
    description: "Upstream source watcher.",
    longDescription:
      "Monitors GitHub repositories, documentation sites, and package registries for updates. Triggers notifications for new commits, releases, and breaking changes.",
    risk: "low",
  },
  [UNDERCOVER_MODE]: {
    name: "UNDERCOVER_MODE",
    description: "Stealth operation without attribution.",
    longDescription:
      "Strips identity signals (name, avatar, branding) from all outputs and suppresses metadata headers. The agent still functions normally but leaves minimal identifying footprint. Useful for sensitive operational contexts.",
    risk: "medium",
  },
};

// ---------------------------------------------------------------------------
// Active flags — edit this set to enable/disable features at compile time.
// Build tools (esbuild, bun, rollup) will tree-shake all code guarded by
// isEnabled() checks on flags NOT present in this set.
// ---------------------------------------------------------------------------

/** Compile-time flag set — only these symbols are considered active. */
export const ACTIVE_FLAGS: Set<symbol> = new Set<symbol>([
  // Default: all flags ON for development. Toggle off individual entries
  // before shipping a release build.
  KAIROS_DAEMON,
  PROACTIVE_MODE,
  AUTO_DREAM,
  SKILL_SCANNER,
  MISSION_CONTROL,
  AGENCY_TEAMS,
  SELF_IMPROVE_DAEMON,
  UPSTREAM_WATCHER,
  UNDERCOVER_MODE,
]);

// ---------------------------------------------------------------------------
// Typed getters
// ---------------------------------------------------------------------------

/** Returns true when the given flag is active (compile-time constant). */
export function isEnabled(flag: symbol): boolean {
  return ACTIVE_FLAGS.has(flag);
}

/** Returns the definition for a flag, or undefined if unknown. */
export function getFlagDefinition(flag: symbol): FeatureFlagDefinition | undefined {
  return ALL_FLAG_DEFINITIONS[flag];
}

/** Returns all active flag definitions. */
export function getActiveFlagDefinitions(): FeatureFlagDefinition[] {
  return [...ACTIVE_FLAGS].map((f) => ALL_FLAG_DEFINITIONS[f]).filter(Boolean);
}

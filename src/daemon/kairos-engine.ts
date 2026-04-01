/**
 * KAIROS Engine — Orla's always-on background daemon.
 *
 * Runs in a forked subagent to keep the main context clean.
 * Triggers autoDream during idle periods for memory consolidation.
 *
 * Inspired by Claude Code's KAIROS + autoDream + Undercover Mode.
 */

import { z } from "zod";
import { resolveCronStorePath } from "../cron/store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

// ============================================================================
// Config Schema
// ============================================================================

export const KairosConfigSchema = z.object({
  /** Enable the KAIROS daemon. Default: false (safer — enable via ORLA_KAIROS_ENABLED=1) */
  enabled: z.boolean().optional().default(false),
  /** Minutes of inactivity before triggering autoDream. Default: 5 */
  idleMinutes: z.number().int().min(1).max(120).optional().default(5),
  /** Milliseconds between dream consolidation cycles. Default: 30000 (30s) */
  dreamIntervalMs: z.number().int().min(5000).max(3600000).optional().default(30_000),
  /** Maximum dream cycles per idle session. Default: 20 */
  maxDreamCyclesPerIdle: z.number().int().min(1).max(200).optional().default(20),
  /** Quiet hours: don't dream during these hours (24h format). Default: none */
  quietHoursStart: z.number().int().min(0).max(23).optional(),
  quietHoursEnd: z.number().int().min(0).max(23).optional(),
  /** Session store path for KAIROS state */
  storePath: z.string().optional(),
  /** Maximum age of the dream state before forcing full consolidation (ms) */
  maxDreamStateAgeMs: z.number().int().min(60000).optional().default(3_600_000),
});

export type KairosConfig = z.infer<typeof KairosConfigSchema>;

// ============================================================================
// State
// ============================================================================

interface KairosState {
  config: KairosConfig;
  /** Timestamp of last user activity */
  lastUserActivityMs: number;
  /** Whether we are currently in a dream cycle */
  isDreaming: boolean;
  /** Number of dream cycles in the current idle session */
  dreamCyclesThisIdle: number;
  /** Whether the daemon has been started */
  started: boolean;
  /** Timer handle for idle check */
  idleTimer: NodeJS.Timeout | null;
  /** Timer handle for dream cycle */
  dreamTimer: NodeJS.Timeout | null;
  /** Last dream timestamp */
  lastDreamAtMs: number;
}

const log = createSubsystemLogger("kairos-engine");

// In-memory state (ephemeral between gateway restarts)
let state: KairosState | null = null;

const DEFAULT_STORE: KairosStoreFile = { version: 1, lastConsolidationMs: 0 };

interface KairosStoreFile {
  version: 1;
  lastConsolidationMs: number;
}

// ============================================================================
// Idle Detection
// ============================================================================

function isInQuietHours(config: KairosConfig): boolean {
  const start = config.quietHoursStart;
  const end = config.quietHoursEnd;
  if (start === undefined || end === undefined) {
    return false;
  }
  const now = new Date();
  const hour = now.getHours();
  if (start <= end) {
    return hour >= start && hour < end;
  }
  // Wrap-around case (e.g., 22-06 means 10pm to 6am)
  return hour >= start || hour < end;
}

function isIdle(state: KairosState): boolean {
  const idleMs = state.config.idleMinutes * 60 * 1000;
  return Date.now() - state.lastUserActivityMs >= idleMs;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _getIdleWaitMs(state: KairosState): number {
  return state.config.idleMinutes * 60 * 1000;
}

// ============================================================================
// Dream Cycle Management
// ============================================================================

/**
 * Run a single dream consolidation cycle.
 * This is the "autoDream" core — merges observations, removes contradictions,
 * converts vague notes to facts.
 */
async function runDreamCycle(): Promise<void> {
  if (!state || !state.isDreaming) {
    return;
  }

  const now = Date.now();
  log.debug("kairos: starting dream cycle", { cycle: state.dreamCyclesThisIdle + 1 });

  try {
    // Consolidation tasks:
    // 1. Load memory/MEMORY.md — merge recent observations
    // 2. Load memory/daily logs — convert vague entries to facts
    // 3. Update MEMORY.md with consolidated insights
    // 4. Log dream results to memory/YYYY-MM-DD.md
    await runMemoryConsolidation(state);

    state.dreamCyclesThisIdle++;
    state.lastDreamAtMs = now;

    // Check if we've done enough cycles
    if (state.dreamCyclesThisIdle >= state.config.maxDreamCyclesPerIdle) {
      log.debug("kairos: max dream cycles reached, ending session", {});
      stopDreaming();
    }
  } catch (err) {
    log.error("kairos: dream cycle failed", { err });
    // Continue dreaming but log the error
  }
}

async function runMemoryConsolidation(s: KairosState): Promise<void> {
  // This is called by the KAIROS engine to perform memory consolidation.
  // The actual consolidation work is delegated to the kairos-agent subagent.
  // Here we just record the timestamp.
  const store = await loadKairosStore(s.config.storePath);
  store.lastConsolidationMs = Date.now();
  await saveKairosStore(store, s.config.storePath);
  log.debug("kairos: consolidation recorded", { lastConsolidationMs: store.lastConsolidationMs });
}

async function loadKairosStore(storePath?: string): Promise<KairosStoreFile> {
  const resolved = storePath ?? resolveCronStorePath();
  try {
    const storeFile = resolveKairosStorePath(resolved);
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(storeFile, "utf-8");
    const { parseJsonWithJson5Fallback } = await import("../utils/parse-json-compat.js");
    const parsed = parseJsonWithJson5Fallback(raw);
    if (parsed && typeof parsed === "object" && "version" in parsed) {
      return parsed as KairosStoreFile;
    }
  } catch {
    // File doesn't exist or is invalid — return default
  }
  return { ...DEFAULT_STORE };
}

function resolveKairosStorePath(base: string): string {
  return base.replace(/jobs\.json$/, "kairos-store.json");
}

async function saveKairosStore(store: KairosStoreFile, storePath?: string): Promise<void> {
  const resolved = storePath ?? resolveCronStorePath();
  const storeFile = resolveKairosStorePath(resolved);
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");

  try {
    await mkdir(dirname(storeFile), { recursive: true });
    await writeFile(storeFile, JSON.stringify(store, null, 2), "utf-8");
  } catch (err) {
    log.error("kairos: failed to save store", { err, storeFile });
  }
}

// ============================================================================
// Dream Loop
// ============================================================================

function startDreaming(): void {
  if (!state) {
    return;
  }
  if (state.isDreaming) {
    return;
  }

  if (isInQuietHours(state.config)) {
    log.debug("kairos: quiet hours, skipping dream start", {});
    return;
  }

  state.isDreaming = true;
  state.dreamCyclesThisIdle = 0;
  log.info("kairos: starting dream session", {});

  scheduleNextDream();
}

function scheduleNextDream(): void {
  if (!state || !state.isDreaming) {
    return;
  }

  if (state.dreamTimer) {
    clearTimeout(state.dreamTimer);
    state.dreamTimer = null;
  }

  state.dreamTimer = setTimeout(async () => {
    await runDreamCycle();
    if (state?.isDreaming) {
      scheduleNextDream();
    }
  }, state.config.dreamIntervalMs);
}

function stopDreaming(): void {
  if (!state) {
    return;
  }

  state.isDreaming = false;
  if (state.dreamTimer) {
    clearTimeout(state.dreamTimer);
    state.dreamTimer = null;
  }
  log.debug("kairos: dream session ended", {});
}

// ============================================================================
// Idle Monitor
// ============================================================================

function startIdleMonitor(): void {
  if (!state) {
    return;
  }

  if (state.idleTimer) {
    clearInterval(state.idleTimer);
  }

  // Check idle status every 30 seconds
  state.idleTimer = setInterval(() => {
    if (!state) {
      return;
    }

    if (state.isDreaming) {
      // If user becomes active while dreaming, stop
      // (we detect this via activity being recorded)
      return;
    }

    if (isIdle(state) && !isInQuietHours(state.config)) {
      startDreaming();
    }
  }, 30_000);
}

function stopIdleMonitor(): void {
  if (!state) {
    return;
  }
  if (state.idleTimer) {
    clearInterval(state.idleTimer);
    state.idleTimer = null;
  }
}

// ============================================================================
// Public API — Activity Recording
// ============================================================================

/**
 * Record that the user is active. Call this on any user input.
 * Resets the idle timer and stops dreaming if active.
 */
export function recordUserActivity(): void {
  if (!state) {
    return;
  }

  const _wasIdle = isIdle(state); // TODO: use to track idle-to-active transition
  state.lastUserActivityMs = Date.now();

  if (state.isDreaming) {
    // User came back — end the dream session gracefully
    log.debug("kairos: user activity detected, ending dream session", {});
    stopDreaming();
  }
}

/**
 * Check if KAIROS is currently dreaming.
 */
export function isKairosDreaming(): boolean {
  return state?.isDreaming ?? false;
}

/**
 * Get current KAIROS status snapshot.
 */
export function getKairosStatus(): {
  active: boolean;
  isDreaming: boolean;
  dreamCyclesThisIdle: number;
  idleMs: number;
  lastDreamAtMs: number;
} {
  if (!state) {
    return {
      active: false,
      isDreaming: false,
      dreamCyclesThisIdle: 0,
      idleMs: 0,
      lastDreamAtMs: 0,
    };
  }
  return {
    active: state.started,
    isDreaming: state.isDreaming,
    dreamCyclesThisIdle: state.dreamCyclesThisIdle,
    idleMs: Date.now() - state.lastUserActivityMs,
    lastDreamAtMs: state.lastDreamAtMs,
  };
}

// ============================================================================
// Lifecycle
// ============================================================================

/**
 * Initialize and start the KAIROS daemon.
 */
export async function startKairosDaemon(config?: Partial<KairosConfig>): Promise<void> {
  if (state?.started) {
    log.warn("kairos: already started", {});
    return;
  }

  const parsed = KairosConfigSchema.safeParse(config ?? {});
  if (!parsed.success) {
    log.error("kairos: invalid config", { errors: parsed.error.flatten() });
    return;
  }

  const fullConfig = parsed.data;

  if (!fullConfig.enabled) {
    log.info("kairos: disabled by config", {});
    return;
  }

  state = {
    config: fullConfig,
    lastUserActivityMs: Date.now(),
    isDreaming: false,
    dreamCyclesThisIdle: 0,
    started: false,
    idleTimer: null,
    dreamTimer: null,
    lastDreamAtMs: 0,
  };

  startIdleMonitor();
  state.started = true;

  log.info("kairos: daemon started", {
    idleMinutes: fullConfig.idleMinutes,
    dreamIntervalMs: fullConfig.dreamIntervalMs,
    maxDreamCyclesPerIdle: fullConfig.maxDreamCyclesPerIdle,
  });
}

/**
 * Stop the KAIROS daemon.
 */
export function stopKairosDaemon(): void {
  if (!state) {
    return;
  }

  stopIdleMonitor();
  stopDreaming();
  state.started = false;

  log.info("kairos: daemon stopped", {});
}

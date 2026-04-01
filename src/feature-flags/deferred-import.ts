/**
 * deferred-import.ts
 *
 * Deferred / lazy import helpers for feature-flag-gated modules.
 * Uses string-based flag IDs with env-var awareness from index.ts.
 *
 * Usage:
 * ```ts
 * const kairos = await importKairosDaemon();
 * if (kairos) await kairos.start();
 * ```
 */

import { FLAGS, isFlagEnabled } from "./index.js";

// ---------------------------------------------------------------------------
// Deferred module map — string-based flag IDs (not Symbols)
// ---------------------------------------------------------------------------

type DeferredModule<T> = {
  flagId: string;
  importFn: () => Promise<T>;
  loaded: boolean;
  handle?: T;
};

const DEFERRED_MODULES: DeferredModule<unknown>[] = [
  {
    flagId: "KAIROS_DAEMON",
    importFn: () => import("../daemon/kairos-daemon.js"),
    loaded: false,
  },
  {
    flagId: "PROACTIVE_MODE",
    importFn: () => import("../agents/proactive-agent.js"),
    loaded: false,
  },
  {
    flagId: "AUTO_DREAM",
    importFn: () => import("./modules/auto-dream.js"),
    loaded: false,
  },
  {
    flagId: "SKILL_SCANNER",
    importFn: () => import("./modules/skill-scanner.js"),
    loaded: false,
  },
  {
    flagId: "MISSION_CONTROL",
    importFn: () => import("./modules/mission-control.js"),
    loaded: false,
  },
  {
    flagId: "AGENCY_TEAMS",
    importFn: () => import("./modules/agency-teams.js"),
    loaded: false,
  },
  {
    flagId: "UNDERCOVER_MODE",
    importFn: () => import("../daemon/undercover-mode.js"),
    loaded: false,
  },
];

// ---------------------------------------------------------------------------
// Core deferred import function — env-aware flag checking
// ---------------------------------------------------------------------------

async function importDeferred<T>(entry: DeferredModule<T>): Promise<T | undefined> {
  // Use env-aware flag check from index.ts
  if (!isFlagEnabled(entry.flagId as keyof typeof FLAGS)) {
    return undefined;
  }
  // Only use cache if we previously loaded a real module (not null/undefined)
  if (entry.loaded) {
    return entry.handle as T;
  }
  const mod = await entry.importFn();
  if (mod != null) {
    entry.handle = mod as T;
    entry.loaded = true;
  }
  return mod as T;
}

function preloadDeferred<T>(entry: DeferredModule<T>): void {
  if (!isFlagEnabled(entry.flagId as keyof typeof FLAGS)) {
    return;
  }
  if (entry.loaded) {
    return;
  } // already preloaded
  entry.importFn().then(
    (mod) => {
      if (mod != null) {
        entry.handle = mod as T;
        entry.loaded = true;
      }
    },
    () => {
      /* noop */
    },
  );
}

// ---------------------------------------------------------------------------
// Typed accessors
// ---------------------------------------------------------------------------

export async function importKairosDaemon(): Promise<unknown> {
  const entry = DEFERRED_MODULES.find((e) => e.flagId === "KAIROS_DAEMON");
  if (!entry) {
    return undefined;
  }
  return importDeferred(entry);
}

export function preloadKairosDaemon(): void {
  const entry = DEFERRED_MODULES.find((e) => e.flagId === "KAIROS_DAEMON");
  if (entry) {
    preloadDeferred(entry);
  }
}

export async function importProactiveAgent(): Promise<unknown> {
  const entry = DEFERRED_MODULES.find((e) => e.flagId === "PROACTIVE_MODE");
  if (!entry) {
    return undefined;
  }
  return importDeferred(entry);
}

export function preloadProactiveAgent(): void {
  const entry = DEFERRED_MODULES.find((e) => e.flagId === "PROACTIVE_MODE");
  if (entry) {
    preloadDeferred(entry);
  }
}

export async function importAutoDream(): Promise<unknown> {
  const entry = DEFERRED_MODULES.find((e) => e.flagId === "AUTO_DREAM");
  if (!entry) {
    return undefined;
  }
  return importDeferred(entry);
}

export async function importSkillScanner(): Promise<unknown> {
  const entry = DEFERRED_MODULES.find((e) => e.flagId === "SKILL_SCANNER");
  if (!entry) {
    return undefined;
  }
  return importDeferred(entry);
}

export async function importMissionControl(): Promise<unknown> {
  const entry = DEFERRED_MODULES.find((e) => e.flagId === "MISSION_CONTROL");
  if (!entry) {
    return undefined;
  }
  return importDeferred(entry);
}

export async function importAgencyTeams(): Promise<unknown> {
  const entry = DEFERRED_MODULES.find((e) => e.flagId === "AGENCY_TEAMS");
  if (!entry) {
    return undefined;
  }
  return importDeferred(entry);
}

export async function importUndercoverMode(): Promise<unknown> {
  const entry = DEFERRED_MODULES.find((e) => e.flagId === "UNDERCOVER_MODE");
  if (!entry) {
    return undefined;
  }
  return importDeferred(entry);
}

// ---------------------------------------------------------------------------
// Bulk utilities
// ---------------------------------------------------------------------------

export function preloadAllActiveModules(): void {
  for (const entry of DEFERRED_MODULES) {
    preloadDeferred(entry);
  }
}

export function listLoadedModules(): string[] {
  return DEFERRED_MODULES.filter((e) => e.loaded).map((e) => e.flagId);
}

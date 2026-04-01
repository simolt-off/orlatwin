/**
 * Feature flag registry — dynamic registration and runtime flag state.
 *
 * Provides a mutable runtime registry for flags that need to be registered
 * dynamically (e.g. plugin-provided flags). The compile-time static registry
 * lives in flags.ts and drives tree-shaking.
 *
 * The rule: static flags (in flags.ts) are always the source of truth for
 * build-time elimination. Dynamic registration is additive only and does NOT
 * affect tree-shaking — it exists so plugins can contribute their own flags
 * at runtime without requiring a rebuild.
 */

import { z } from "zod";
import {
  ALL_FLAG_DEFINITIONS,
  FeatureFlagSymbolSchema,
  type FeatureFlagDefinition,
} from "./flags.js";

// ---------------------------------------------------------------------------
// Dynamic registry
// ---------------------------------------------------------------------------

type RegisteredFlag = {
  definition: FeatureFlagDefinition;
  /** Runtime-only metadata — not part of the static flag definition. */
  meta: {
    /** Set to true by the plugin that registered this flag. */
    sourcePlugin?: string;
    /** Unix ms timestamp of registration. */
    registeredAt: number;
    /** Whether the flag is currently enabled at runtime (may differ from build-time). */
    runtimeEnabled: boolean;
  };
};

const _dynamicRegistry = new Map<symbol, RegisteredFlag>();

/**
 * Register a new flag dynamically (typically called by a plugin at boot).
 * Idempotent — updating an already-registered flag preserves `registeredAt`.
 */
export function registerFlag(
  flag: symbol,
  definition: FeatureFlagDefinition,
  sourcePlugin?: string,
): void {
  const existing = _dynamicRegistry.get(flag);
  _dynamicRegistry.set(flag, {
    definition,
    meta: {
      sourcePlugin: sourcePlugin ?? existing?.meta.sourcePlugin,
      registeredAt: existing?.meta.registeredAt ?? Date.now(),
      runtimeEnabled: definition !== undefined,
    },
  });
}

/**
 * Un-register a dynamically registered flag.
 * Returns true if the flag was found and removed.
 */
export function unregisterFlag(flag: symbol): boolean {
  return _dynamicRegistry.delete(flag);
}

/**
 * Get the runtime registration record for a flag.
 * Returns undefined if the flag was never registered.
 */
export function getRegisteredFlag(
  flag: symbol,
): (RegisteredFlag & { dynamic: true }) | (undefined & { dynamic: undefined }) {
  const rec = _dynamicRegistry.get(flag);
  if (rec === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return undefined as any;
  }
  return { ...rec, dynamic: true as const };
}

/**
 * Returns all dynamically registered flags.
 */
export function listDynamicFlags(): Array<{
  flag: symbol;
  definition: FeatureFlagDefinition;
  sourcePlugin?: string;
  registeredAt: number;
}> {
  return [..._dynamicRegistry.entries()].map(([flag, rec]) => ({
    flag,
    definition: rec.definition,
    sourcePlugin: rec.meta.sourcePlugin,
    registeredAt: rec.meta.registeredAt,
  }));
}

/**
 * Set the runtime-enabled state of a dynamically registered flag.
 * Has no effect on compile-time ACTIVE_FLAGS — use only for temporary overrides.
 */
export function setRuntimeFlagEnabled(flag: symbol, enabled: boolean): boolean {
  const rec = _dynamicRegistry.get(flag);
  if (!rec) {
    return false;
  }
  rec.meta.runtimeEnabled = enabled;
  return true;
}

// ---------------------------------------------------------------------------
// Resolved registry — merges static and dynamic flags
// ---------------------------------------------------------------------------

/**
 * Returns all flags (static + dynamic) as a merged map.
 * Static flags take priority; dynamic flags are additive.
 */
export function getAllResolvedFlags(): Map<symbol, RegisteredFlag["definition"]> {
  const result = new Map<symbol, RegisteredFlag["definition"]>();

  // Static flags first
  for (const [flag, def] of Object.entries(ALL_FLAG_DEFINITIONS)) {
    result.set(Number(flag) as unknown as symbol, def as FeatureFlagDefinition);
  }

  // Dynamic flags overlay
  for (const [flag, rec] of _dynamicRegistry) {
    result.set(flag, rec.definition);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Schema helpers for config serialization
// ---------------------------------------------------------------------------

/**
 * Zod schema for serialising a set of active flag symbols to config JSON.
 * Use this when persisting the active flag set to openclaw.json.
 */
export const ActiveFlagsSchema = z.array(FeatureFlagSymbolSchema);
export type ActiveFlagsSchema = z.infer<typeof ActiveFlagsSchema>;

// Re-export for use in config schemas
export { FeatureFlagSymbolSchema } from "./flags.js";

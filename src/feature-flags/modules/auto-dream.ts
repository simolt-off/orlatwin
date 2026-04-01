/**
 * AutoDream module — memory optimisation while idle.
 * Activated when AUTO_DREAM flag is enabled.
 *
 * @module auto-dream
 */

export interface AutoDreamModule {
  startIdleMaintenance: (options?: IdleMaintenanceOptions) => void;
  stopIdleMaintenance: () => void;
  triggerMaintenanceNow: () => Promise<void>;
}

export interface IdleMaintenanceOptions {
  /** Minimum idle seconds before triggering maintenance. Default: 60. */
  idleThresholdSeconds?: number;
  /** Interval between maintenance runs in ms. Default: 5 minutes. */
  intervalMs?: number;
}

/**
 * Start idle-triggered memory maintenance.
 * Does nothing if called when the AUTO_DREAM flag is not active.
 */
export async function startIdleMaintenance(_options?: IdleMaintenanceOptions): Promise<void> {
  // TODO: implement actual maintenance loop
  // - Prune session memory entries older than retention window
  // - Defragment embedding store
  // - Summarise stale long-session transcripts
  console.debug("[AutoDream] Idle maintenance started");
}

/**
 * Stop the idle maintenance loop.
 */
export function stopIdleMaintenance(): void {
  // TODO: cancel timers/intervals
  console.debug("[AutoDream] Idle maintenance stopped");
}

/**
 * Trigger maintenance immediately regardless of idle state.
 */
export async function triggerMaintenanceNow(): Promise<void> {
  // TODO: run maintenance synchronously
  console.debug("[AutoDream] Immediate maintenance triggered");
}

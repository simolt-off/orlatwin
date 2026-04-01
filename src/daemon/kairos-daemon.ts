/**
 * KAIROS Engine — Always-On Background Memory Daemon
 * Inspired by Claude Code's KAIROS + autoDream.
 *
 * Runs in a forked subagent to keep main context clean.
 * Monitors idle time and triggers memory consolidation when user is away.
 */

import { z } from "zod";
import { isFlagEnabled } from "../feature-flags/index.js";

// ─── Config ─────────────────────────────────────────────────────────────────

export const KairosConfigSchema = z.object({
  enabled: z.boolean().default(false),
  idleMinutes: z.number().min(1).max(60).default(5),
  dreamIntervalMs: z.number().min(10000).max(300000).default(30000),
  maxDreamCycles: z.number().min(1).max(10).default(3),
  consolidationEnabled: z.boolean().default(true),
  autoDreamEnabled: z.boolean().default(true),
});

export type KairosConfig = z.infer<typeof KairosConfigSchema>;

// ─── WAL (Write-Ahead Log) for memory operations ──────────────────────────────

// Lightweight WAL to ensure strict write discipline:
// - All memory writes go to WAL first
// - Checkpointer confirms writes before they are committed
// - On crash, WAL replay recovers state

export interface WalEntry {
  id: string;
  op: "write" | "update" | "delete" | "consolidate";
  target: string; // pointer key or topic path
  payload?: string;
  timestamp: number;
  status: "pending" | "confirmed" | "failed";
  cycleId?: string;
}

class WriteAheadLog {
  private entries: WalEntry[] = [];
  private walPath = "/home/soliman/.openclaw/workspace/memory/.wal.jsonl";
  private confirmedUpTo = 0;

  async init(): Promise<void> {
    // Load existing WAL on startup
    // In production: read from walPath, replay pending entries
    this.confirmedUpTo = this.entries.filter((e) => e.status === "confirmed").length;
  }

  async append(entry: Omit<WalEntry, "id" | "timestamp" | "status">): Promise<string> {
    const full: WalEntry = {
      ...entry,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      status: "pending",
    };
    this.entries.push(full);
    // TODO: flush to walPath
    return full.id;
  }

  async confirm(id: string): Promise<void> {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) {
      return;
    }
    entry.status = "confirmed";
    this.confirmedUpTo++;
    // TODO: fsync to walPath
  }

  async markFailed(id: string): Promise<void> {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) {
      return;
    }
    entry.status = "failed";
    // TODO: alert / notify
  }

  async getPending(cycleId?: string): Promise<WalEntry[]> {
    return this.entries.filter((e) => {
      if (e.status !== "pending") {
        return false;
      }
      if (cycleId && e.cycleId !== cycleId) {
        return false;
      }
      return true;
    });
  }

  async replay(): Promise<void> {
    // Replay all pending entries after crash
    const pending = await this.getPending();
    for (const _entry of pending) {
      // Re-apply the operation
      // If it succeeds, confirm; if it fails, mark failed
    }
  }
}

// ─── Idle Detector ───────────────────────────────────────────────────────────

class IdleDetector {
  private lastActivity = Date.now();
  private listeners: Array<(idle: boolean) => void> = [];

  updateActivity(): void {
    this.lastActivity = Date.now();
    this.listeners.forEach((l) => l(false));
  }

  onIdleChange(callback: (idle: boolean) => void): () => void {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== callback);
    };
  }

  isIdle(idleMinutes: number): boolean {
    return Date.now() - this.lastActivity > idleMinutes * 60 * 1000;
  }

  getIdleMs(): number {
    return Date.now() - this.lastActivity;
  }
}

// ─── Dream Cycle ─────────────────────────────────────────────────────────────

interface DreamResult {
  cycleId: string;
  observationsProcessed: number;
  contradictionsRemoved: number;
  vagueNotesFixed: number;
  indexUpdated: boolean;
  durationMs: number;
}

class DreamCycle {
  constructor(
    public readonly cycleId: string,
    private config: KairosConfig,
    private wal: WriteAheadLog,
  ) {}

  async run(): Promise<DreamResult> {
    const start = Date.now();
    const observationsProcessed = 0;
    const contradictionsRemoved = 0;
    const vagueNotesFixed = 0;

    // 1. Gather all observations from recent sessions
    // 2. Load pointer index
    // 3. Identify contradictions (same fact stated differently)
    // 4. Fix vague notes (convert "sometime" → actual date, etc.)
    // 5. Update pointer index ONLY after confirmed writes (strict discipline)

    // This runs in a FORKED subagent — main context stays clean

    return {
      cycleId: this.cycleId,
      observationsProcessed,
      contradictionsRemoved,
      vagueNotesFixed,
      indexUpdated: false,
      durationMs: Date.now() - start,
    };
  }
}

// ─── KAIROS Engine ────────────────────────────────────────────────────────────

export class KairosEngine {
  private config: KairosConfig;
  private wal: WriteAheadLog;
  private idleDetector: IdleDetector;
  private isRunning = false;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private dreamTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<KairosConfig> = {}) {
    this.config = KairosConfigSchema.parse(config);
    this.wal = new WriteAheadLog();
    this.idleDetector = new IdleDetector();
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      console.debug("[KAIROS] Disabled — set kairos.enabled=true to activate");
      return;
    }

    if (!isFlagEnabled("KAIROS_DAEMON")) {
      console.debug("[KAIROS] KAIROS_DAEMON flag is off");
      return;
    }

    this.isRunning = true;
    await this.wal.init();

    // Monitor idle state
    this.idleTimer = setInterval(() => {
      if (this.idleDetector.isIdle(this.config.idleMinutes)) {
        this.onIdle();
      }
    }, 10000); // check every 10s

    // Periodic dream cycles when enabled
    if (this.config.autoDreamEnabled) {
      this.dreamTimer = setInterval(() => {
        if (this.idleDetector.isIdle(this.config.idleMinutes)) {
          void this.triggerAutoDream();
        }
      }, this.config.dreamIntervalMs);
    }

    console.debug("[KAIROS] Engine started", this.config);
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
    }
    if (this.dreamTimer) {
      clearInterval(this.dreamTimer);
    }
    console.debug("[KAIROS] Engine stopped");
  }

  private onIdle(): void {
    if (!this.isRunning) {
      return;
    }
    // Could emit an event or notification here
    console.debug("[KAIROS] User idle — entering dormant mode");
  }

  private async triggerAutoDream(): Promise<void> {
    if (!this.isRunning || !this.config.autoDreamEnabled) {
      return;
    }

    console.debug("[KAIROS] Triggering autoDream...");

    for (let i = 0; i < this.config.maxDreamCycles; i++) {
      const cycle = new DreamCycle(`dream-${Date.now()}-${i}`, this.config, this.wal);
      const result = await cycle.run();
      console.debug("[KAIROS] Dream cycle complete", result);

      if (!result.indexUpdated) {
        break;
      } // stop if nothing to update
    }
  }

  // Called by main agent when user is active
  recordActivity(): void {
    this.idleDetector.updateActivity();
  }

  getStatus(): { running: boolean; idleMs: number; config: KairosConfig } {
    return {
      running: this.isRunning,
      idleMs: this.idleDetector.getIdleMs(),
      config: this.config,
    };
  }

  // Strict write discipline: write to WAL, then confirm after success
  async strictWrite(op: WalEntry["op"], target: string, payload?: string): Promise<string> {
    const entryId = await this.wal.append({ op, target, payload });

    try {
      // Perform the actual write operation here
      // ... (topic file write, pointer update, etc.)

      // Only confirm after actual write succeeds
      await this.wal.confirm(entryId);
      return entryId;
    } catch (err) {
      await this.wal.markFailed(entryId);
      throw err;
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let kairosInstance: KairosEngine | null = null;

export function getKairosEngine(config?: Partial<KairosConfig>): KairosEngine {
  if (!kairosInstance) {
    kairosInstance = new KairosEngine(config);
  }
  return kairosInstance;
}

/**
 * orla-proactive/wal.ts
 *
 * Write-Ahead Log for Orla's PROACTIVE + KAIROS memory operations.
 * Ensures strict write discipline: writes go to WAL first, confirmed after success.
 * On crash, WAL replay recovers state without corruption.
 *
 * This is a LOCAL implementation for Orla's memory — isolated from OpenClaw's
 * own memory manager. It manages the POINTER-INDEX and TOPIC-FILES only.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface WalEntry {
  id: string;
  op: "write" | "update" | "delete" | "consolidate" | "archive";
  target: string; // pointer key or topic path
  payload?: string; // JSON-serialized content
  timestamp: number;
  status: "pending" | "confirmed" | "failed";
  cycleId?: string; // links entries to a dream cycle
}

const WAL_DIR = "/home/soliman/.openclaw/workspace/memory/.wal";
const WAL_PATH = join(WAL_DIR, "wal.jsonl");
const WAL_META = join(WAL_DIR, "wal.meta.json");

interface WalMeta {
  lastConfirmedId: string | null;
  lastConsolidatedAt: number;
  totalEntries: number;
}

// ─── WAL Management ─────────────────────────────────────────────────────────

function ensureWalDir(): void {
  if (!existsSync(WAL_DIR)) {
    mkdirSync(WAL_DIR, { recursive: true, mode: 0o700 });
  }
}

function readMeta(): WalMeta {
  try {
    if (existsSync(WAL_META)) {
      return JSON.parse(readFileSync(WAL_META, "utf-8"));
    }
  } catch {
    // Corrupt meta — start fresh
  }
  return { lastConfirmedId: null, lastConsolidatedAt: 0, totalEntries: 0 };
}

function writeMeta(meta: WalMeta): void {
  ensureWalDir();
  writeFileSync(WAL_META, JSON.stringify(meta, null, 2), { mode: 0o600 });
}

function readAllEntries(): WalEntry[] {
  try {
    if (!existsSync(WAL_PATH)) {
      return [];
    }
    const raw = readFileSync(WAL_PATH, "utf-8");
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as WalEntry);
  } catch {
    return [];
  }
}

function appendEntry(entry: WalEntry): void {
  ensureWalDir();
  const line = JSON.stringify(entry) + "\n";
  // Append to WAL
  const existing = existsSync(WAL_PATH) ? readFileSync(WAL_PATH, "utf-8") : "";
  writeFileSync(WAL_PATH, existing + line, { mode: 0o600 });
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Append a pending WAL entry. Entry starts as 'pending'.
 */
export function walAppend(entry: Omit<WalEntry, "id" | "timestamp" | "status">): string {
  const full: WalEntry = {
    ...entry,
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    status: "pending",
  };
  appendEntry(full);

  const meta = readMeta();
  meta.totalEntries++;
  writeMeta(meta);

  return full.id;
}

/**
 * Mark a WAL entry as confirmed (write succeeded).
 */
export function walConfirm(id: string): void {
  const entries = readAllEntries();
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) {
    return;
  }

  entries[idx] = { ...entries[idx], status: "confirmed" };

  // Rewrite WAL (append-only would be better with a real DB)
  const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(WAL_PATH, lines, { mode: 0o600 });

  const meta = readMeta();
  meta.lastConfirmedId = id;
  writeMeta(meta);
}

/**
 * Mark a WAL entry as failed.
 */
export function walFail(id: string, error?: string): void {
  const entries = readAllEntries();
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) {
    return;
  }

  entries[idx] = { ...entries[idx], status: "failed", payload: error ?? entries[idx].payload };

  const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(WAL_PATH, lines, { mode: 0o600 });
}

/**
 * Get all pending entries (for a given cycle or all).
 */
export function walGetPending(cycleId?: string): WalEntry[] {
  const entries = readAllEntries();
  return entries.filter((e) => {
    if (e.status !== "pending") {
      return false;
    }
    if (cycleId && e.cycleId !== cycleId) {
      return false;
    }
    return true;
  });
}

/**
 * Replay pending entries after crash — returns list of entries that need re-application.
 */
export function walReplayPending(): WalEntry[] {
  return walGetPending();
}

/**
 * Get last confirmed entry ID (for recovery).
 */
export function walGetLastConfirmed(): string | null {
  return readMeta().lastConfirmedId;
}

/**
 * Get WAL statistics.
 */
export function walStats(): { total: number; pending: number; confirmed: number; failed: number } {
  const entries = readAllEntries();
  return {
    total: entries.length,
    pending: entries.filter((e) => e.status === "pending").length,
    confirmed: entries.filter((e) => e.status === "confirmed").length,
    failed: entries.filter((e) => e.status === "failed").length,
  };
}

/**
 * Compact WAL — remove all confirmed entries older than the last confirmed.
 * Call after successful consolidation cycle.
 */
export function walCompact(): void {
  const meta = readMeta();
  const entries = readAllEntries();

  // Keep only pending + most recent confirmed
  const compacted = entries.filter((e) => {
    if (e.status === "pending") {
      return true;
    }
    if (e.id === meta.lastConfirmedId) {
      return true;
    }
    return false;
  });

  if (compacted.length === entries.length) {
    return;
  } // Nothing to compact

  const lines = compacted.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(WAL_PATH, lines, { mode: 0o600 });

  meta.totalEntries = compacted.length;
  writeMeta(meta);
}

/**
 * Full WAL reset — for testing or major consolidation events.
 */
export function walReset(): void {
  const meta = readMeta();
  meta.lastConfirmedId = null;
  meta.totalEntries = 0;
  writeMeta(meta);

  if (existsSync(WAL_PATH)) {
    writeFileSync(WAL_PATH, "", { mode: 0o600 });
  }
}

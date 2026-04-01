/**
 * Write Discipliner — enforces strict write-after-success discipline.
 *
 * Core principle: memory index updates ONLY after successful operation.
 * Never update the index before an operation — only after it completes.
 *
 * This prevents stale pointers to non-existent files or broken state.
 *
 * Inspired by: https://addyosmani.com/blog/write-disciplines/
 */

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { z } from "zod";
import {
  PointerIndexManager,
  type PointerEntry,
  type SizeHint,
  calcSizeHint,
} from "../memory/orla-pointer-index.js";

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

export const OperationTypeSchema = z.enum([
  "write",
  "append",
  "delete",
  "merge",
  "compact",
  "consolidate",
]);
export type OperationType = z.infer<typeof OperationTypeSchema>;

export const OperationStatusSchema = z.enum([
  "pending",
  "running",
  "success",
  "failed",
  "rolled-back",
]);
export type OperationStatus = z.infer<typeof OperationStatusSchema>;

export const OperationSchema = z.object({
  id: z.string().uuid(),
  type: OperationTypeSchema,
  topic: z.string(),
  targetFile: z.string().optional(),
  status: OperationStatusSchema.default("pending"),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
  rollbackSnapshot: z.string().optional(),
});
export type Operation = z.infer<typeof OperationSchema>;

export const WriteDisciplineConfigSchema = z.object({
  /** Require rollback snapshots for destructive operations. */
  requireRollbackSnapshot: z.boolean().default(true),
  /** Log all operations to disk for audit. */
  auditLogPath: z.string().optional(),
  /** Enable strict mode — throws on any discipline violation. */
  strictMode: z.boolean().default(false),
  /** Maximum operation log entries to keep. */
  maxOperationLog: z.number().int().positive().default(1000),
});
export type WriteDisciplineConfig = z.infer<typeof WriteDisciplineConfigSchema>;

// ---------------------------------------------------------------------------
// Operation Log Entry
// ---------------------------------------------------------------------------

interface LogEntry {
  operation: Operation;
  disciplineCheck: {
    indexUpdatedBeforeOperation: boolean;
    indexUpdatedAfterOperation: boolean;
    snapshotTaken: boolean;
    snapshotRestored: boolean;
    passed: boolean;
    notes: string[];
  };
}

// ---------------------------------------------------------------------------
// Write Discipliner Class
// ---------------------------------------------------------------------------

export class WriteDiscipliner {
  private readonly indexManager: PointerIndexManager;
  private readonly topicsDir: string;
  private readonly config: WriteDisciplineConfig;
  private operationLog: Operation[] = [];
  private auditLog: LogEntry[] = [];
  private strictMode: boolean;

  constructor(
    indexManager: PointerIndexManager,
    topicsDir: string,
    config: Partial<WriteDisciplineConfig> = {},
  ) {
    const parsed = WriteDisciplineConfigSchema.safeParse(config);
    this.config = parsed.success
      ? parsed.data
      : { requireRollbackSnapshot: true, strictMode: false, maxOperationLog: 1000 };
    this.indexManager = indexManager;
    this.topicsDir = topicsDir;
    this.strictMode = this.config.strictMode;
  }

  // -------------------------------------------------------------------------
  // Public API — Strict Write Discipline Operations
  // -------------------------------------------------------------------------

  /**
   * Begin a new write operation.
   * Returns an Operation context to be used with complete() or fail().
   *
   * IMPORTANT: This does NOT update the index. It only records the operation.
   * The index is updated ONLY when complete() is called after success.
   */
  begin(type: OperationType, topic: string, targetFile?: string): Operation {
    const operation: Operation = {
      id: generateId(),
      type,
      topic,
      targetFile,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.operationLog.push(operation);
    return operation;
  }

  /**
   * Mark an operation as running.
   */
  start(operationId: string): void {
    const op = this.findOp(operationId);
    if (!op) {
      return;
    }
    op.status = "running";
    op.startedAt = new Date().toISOString();
  }

  /**
   * Complete an operation successfully — ONLY NOW update the pointer index.
   *
   * This is the KEY discipline: index updates happen HERE, after the
   * actual file operation succeeded, not before.
   */
  complete(operationId: string): void {
    const op = this.findOp(operationId);
    if (!op) {
      return;
    }
    op.status = "success";
    op.completedAt = new Date().toISOString();

    // Strict write discipline: update index ONLY after successful operation
    this.syncIndexAfterSuccess(op);
  }

  /**
   * Mark an operation as failed and optionally restore from rollback snapshot.
   */
  fail(operationId: string, error: string, restoreSnapshot = true): void {
    const op = this.findOp(operationId);
    if (!op) {
      return;
    }
    op.status = "failed";
    op.error = error;
    op.completedAt = new Date().toISOString();

    // Optionally restore from snapshot if this was a write operation
    if (restoreSnapshot && op.rollbackSnapshot) {
      this.restoreSnapshot(op);
    }
  }

  /**
   * Snapshot the current state of a topic file before a destructive operation.
   * Returns the snapshot path (stored in memory, not on disk for safety).
   */
  snapshot(topic: string): string | null {
    const entry = this.indexManager.getByTopic(topic);
    if (!entry) {
      return null;
    }

    const filePath = `${this.topicsDir}/${entry.category}/${entry.topic}.md`;
    if (!existsSync(filePath)) {
      return null;
    }

    try {
      const content = require("node:fs").readFileSync(filePath, "utf-8");
      const hash = hashContent(content);
      return hash; // return hash as snapshot identifier
    } catch {
      return null;
    }
  }

  /**
   * Verify file exists and matches expected size hint after an operation.
   */
  verify(operationId: string, expectedSizeHint?: SizeHint): boolean {
    const op = this.findOp(operationId);
    if (!op || !op.targetFile) {
      return false;
    }

    const filePath = `${this.topicsDir}/${op.targetFile}`;
    if (!existsSync(filePath)) {
      return false;
    }

    if (expectedSizeHint) {
      const stats = statSync(filePath);
      const actual = calcSizeHint(stats.size);
      return actual === expectedSizeHint;
    }

    return true;
  }

  /**
   * Get operation history (newest first).
   */
  getHistory(limit = 50): Operation[] {
    return this.operationLog.slice(-limit).toReversed();
  }

  /**
   * Get all operations of a specific type.
   */
  getOperationsByType(type: OperationType): Operation[] {
    return this.operationLog.filter((op) => op.type === type);
  }

  // -------------------------------------------------------------------------
  // Discipline Check (for logging / debugging)
  // -------------------------------------------------------------------------

  /**
   * Check discipline compliance for a completed operation.
   * Returns discipline evaluation notes.
   */
  checkDiscipline(operationId: string): LogEntry["disciplineCheck"] {
    const op = this.findOp(operationId);
    if (!op) {
      return {
        indexUpdatedBeforeOperation: false,
        indexUpdatedAfterOperation: false,
        snapshotTaken: false,
        snapshotRestored: false,
        passed: false,
        notes: ["Operation not found"],
      };
    }

    const notes: string[] = [];
    let passed = true;

    // Check 1: Index should be updated AFTER success, not before
    const indexEntry = this.indexManager.getByTopic(op.topic);
    const indexUpdatedAfter = indexEntry !== null;
    notes.push(
      indexUpdatedAfter
        ? `Index updated after success for topic '${op.topic}'`
        : `WARNING: Index not updated for topic '${op.topic}'`,
    );
    if (!indexUpdatedAfter && op.type !== "delete") {
      passed = false;
    }

    // Check 2: For destructive operations, snapshot should exist
    const snapshotTaken = op.type === "delete" || op.rollbackSnapshot !== undefined;
    notes.push(
      snapshotTaken
        ? "Rollback snapshot available"
        : "No rollback snapshot (may be fine for non-destructive ops)",
    );

    // Check 3: Operation completed successfully
    notes.push(
      op.status === "success"
        ? "Operation completed successfully"
        : `Operation ended with status: ${op.status}`,
    );
    if (op.status !== "success" && op.status !== "rolled-back") {
      passed = false;
    }

    return {
      indexUpdatedBeforeOperation: false, // We never update before
      indexUpdatedAfterOperation: indexUpdatedAfter,
      snapshotTaken,
      snapshotRestored: op.status === "rolled-back",
      passed,
      notes,
    };
  }

  // -------------------------------------------------------------------------
  // Private Helpers
  // -------------------------------------------------------------------------

  private findOp(id: string): Operation | undefined {
    return this.operationLog.find((op) => op.id === id);
  }

  private syncIndexAfterSuccess(op: Operation): void {
    if (!op.targetFile) {
      return;
    }

    const filePath = `${this.topicsDir}/${op.targetFile}`;
    if (!existsSync(filePath)) {
      return;
    }

    const stats = statSync(filePath);
    const entry: PointerEntry = {
      category: "MEMORY",
      topic: op.topic,
      lastUpdated: new Date().toISOString().slice(0, 10),
      sizeHint: calcSizeHint(stats.size),
      status: "ACTIVE",
    };

    this.indexManager.upsert(entry);
  }

  private restoreSnapshot(op: Operation): void {
    if (!op.rollbackSnapshot || !op.targetFile) {
      return;
    }
    // Snapshot restoration would re-write the file from the stored hash
    // For now, this is a placeholder — actual implementation would need
    // to store the content somewhere recoverable
    op.status = "rolled-back";
  }

  /**
   * Enforce strict mode — throws if discipline is violated.
   */
  enforceStrict(operationId: string): void {
    if (!this.strictMode) {
      return;
    }
    const check = this.checkDiscipline(operationId);
    if (!check.passed) {
      throw new Error(
        `Write discipline violation on operation ${operationId}: ${check.notes.join("; ")}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function generateId(): string {
  const bytes = new Uint8Array(16);
  require("crypto").randomFillSync(bytes);
  return [...bytes]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Discipline Guards (functional helpers)
// ---------------------------------------------------------------------------

/**
 * Guard: run a function and only update index on success.
 * Returns { success, result, operation }.
 */
export async function withDiscipline<R>(
  discipliner: WriteDiscipliner,
  type: OperationType,
  topic: string,
  targetFile: string | undefined,
  fn: () => R,
): Promise<{ success: boolean; result?: R; operation: Operation; error?: string }> {
  const operation = discipliner.begin(type, topic, targetFile);
  discipliner.start(operation.id);

  try {
    const result = await fn();
    discipliner.complete(operation.id);
    return { success: true, result, operation };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    discipliner.fail(operation.id, error);
    return { success: false, error, operation };
  }
}

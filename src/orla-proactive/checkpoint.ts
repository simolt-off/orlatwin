/**
 * orla-proactive/checkpoint.ts
 *
 * WAL-backed task checkpoint system for crash recovery.
 * Before any complex multi-step task, call checkpoint() to write progress.
 * On restart, readCheckpoint() restores context and you resume.
 *
 * Format: memory/.checkpoint.md
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { walAppend, walConfirm } from "./wal.js";

export interface Checkpoint {
  id: string;
  task: string; // Human-readable task name
  step: number; // Current step number
  totalSteps: number; // Total planned steps
  description: string; // What was being done
  filesModified: string[]; // Files touched so far
  notes: string; // Next action / what needs to happen
  createdAt: string; // ISO timestamp
}

const CHECKPOINT_PATH = ".checkpoint.md";

function getWorkspaceDir(): string {
  return process.env.ORLA_WORKSPACE ?? "/home/soliman/.openclaw/workspace";
}

function checkpointToMarkdown(cp: Checkpoint): string {
  const lines = [
    "# Task Checkpoint",
    "",
    `**Task:** ${cp.task}`,
    `**Progress:** step ${cp.step}/${cp.totalSteps}`,
    `**Description:** ${cp.description}`,
    `**Files:** ${cp.filesModified.length > 0 ? cp.filesModified.join(", ") : "(none)"}`,
    `**Next:** ${cp.notes}`,
    `**Saved:** ${cp.createdAt}`,
    "",
    "---",
    `*Checkpoint ID: ${cp.id}*`,
  ];
  return lines.join("\n");
}

function parseCheckpoint(content: string): Checkpoint | null {
  const task = /\*\*Task:\*\* (.+)/.exec(content)?.[1] ?? "";
  const stepMatch = /\*\*Progress:\*\* step (\d+)\/(\d+)/.exec(content);
  const step = parseInt(stepMatch?.[1] ?? "0");
  const totalSteps = parseInt(stepMatch?.[2] ?? "0");
  const description = /\*\*Description:\*\* (.+)/.exec(content)?.[1] ?? "";
  const files = /\*\*Files:\*\* (.+)/.exec(content)?.[1] ?? "";
  const next = /\*\*Next:\*\* (.+)/.exec(content)?.[1] ?? "";
  const saved = /\*\*Saved:\*\* (.+)/.exec(content)?.[1] ?? "";
  const idMatch = /Checkpoint ID: (.+)/.exec(content)?.[1] ?? "";

  if (!task) {
    return null;
  }
  return {
    id: idMatch,
    task,
    step,
    totalSteps,
    description,
    filesModified: files.split(", ").filter(Boolean),
    notes: next,
    createdAt: saved,
  };
}

/**
 * Write a task checkpoint (WAL-backed for crash safety).
 * Returns the checkpoint ID for later confirmation.
 */
export async function checkpoint(
  task: string,
  step: number,
  totalSteps: number,
  description: string,
  filesModified: string[],
  next: string,
): Promise<string> {
  const id = crypto.randomUUID();
  const cp: Checkpoint = {
    id,
    task,
    step,
    totalSteps,
    description,
    filesModified,
    notes: next,
    createdAt: new Date().toISOString(),
  };

  const walId = walAppend({
    op: "write",
    target: CHECKPOINT_PATH,
    payload: JSON.stringify(cp),
  });

  // Also write direct for fast reads (WAL is backup)
  const workspace = getWorkspaceDir();
  const checkpointPath = join(workspace, CHECKPOINT_PATH);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(checkpointPath, checkpointToMarkdown(cp), "utf-8");
  walConfirm(walId);

  return id;
}

/**
 * Read the latest checkpoint (returns null if none).
 */
export function readCheckpoint(): Checkpoint | null {
  const workspace = getWorkspaceDir();
  const checkpointPath = join(workspace, CHECKPOINT_PATH);
  if (!existsSync(checkpointPath)) {
    return null;
  }
  const content = readFileSync(checkpointPath, "utf-8");
  return parseCheckpoint(content);
}

/**
 * Clear checkpoint when task is fully complete.
 */
export function clearCheckpoint(): void {
  const workspace = getWorkspaceDir();
  const checkpointPath = join(workspace, CHECKPOINT_PATH);
  if (existsSync(checkpointPath)) {
    writeFileSync(
      checkpointPath,
      `# Task Complete\n\nCleared at ${new Date().toISOString()}\n`,
      "utf-8",
    );
  }
}

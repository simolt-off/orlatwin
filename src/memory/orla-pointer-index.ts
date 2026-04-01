/**
 * Pointer Index Manager for Orla's proactive memory architecture.
 *
 * Design principles (inspired by Claude Code's 3-layer leak):
 * 1. Pointer Index — lightweight ~150 char/line entries, always in context
 * 2. Topic Files — full knowledge loaded on-demand, never in main context
 * 3. Strict Write Discipline — index updates ONLY after successful operation
 *
 * Format: FILE|TOPIC|LAST-UPDATED|SIZE-HINT
 * Size-hint: XS(<1KB) | S(<10KB) | M(<100KB) | L(<1MB) | XL(>1MB)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

export const SizeHintSchema = z.enum(["XS", "S", "M", "L", "XL"]);
export type SizeHint = z.infer<typeof SizeHintSchema>;

export const PointerEntrySchema = z.object({
  category: z.string().min(1), // MEMORY, SIMOLT, DOMAINS, KAIROS, etc.
  topic: z.string().min(1), // human-readable topic name
  lastUpdated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sizeHint: SizeHintSchema, // XS S M L XL
  status: z.enum(["ACTIVE", "ARCHIVED", "STALE"]).default("ACTIVE"),
});
export type PointerEntry = z.infer<typeof PointerEntrySchema>;

export const PointerIndexSchema = z.array(PointerEntrySchema);
export type PointerIndex = z.infer<typeof PointerIndexSchema>;

// ---------------------------------------------------------------------------
// Size Hint Calculator
// ---------------------------------------------------------------------------

export function calcSizeHint(byteSize: number): SizeHint {
  if (byteSize < 1_000) {
    return "XS";
  }
  if (byteSize < 10_000) {
    return "S";
  }
  if (byteSize < 100_000) {
    return "M";
  }
  if (byteSize < 1_000_000) {
    return "L";
  }
  return "XL";
}

// ---------------------------------------------------------------------------
// Parse / Serialize
// ---------------------------------------------------------------------------

function parseLine(line: string): PointerEntry | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }
  const parts = trimmed.split("|");
  // Accept both 4-field (legacy) and 5-field (current) formats
  if (parts.length < 4) {
    return null;
  }
  const [category, topic, lastUpdated, sizeHint] = parts;
  const status = parts[4] ?? "ACTIVE";
  const parsed = PointerEntrySchema.safeParse({ category, topic, lastUpdated, sizeHint, status });
  return parsed.success ? parsed.data : null;
}

export function parsePointerIndex(content: string): PointerIndex {
  return content
    .split("\n")
    .map(parseLine)
    .filter((entry): entry is PointerEntry => entry !== null);
}

function serializeEntry(entry: PointerEntry): string {
  return `${entry.category}|${entry.topic}|${entry.lastUpdated}|${entry.sizeHint}|${entry.status}`;
}

export function serializePointerIndex(entries: PointerEntry[]): string {
  const lines = [
    "# Pointer Index — Orla's Memory",
    "# Format: CATEGORY|Topic|LastUpdated|SizeHint|Status",
    "# SizeHint: XS(<1KB) S(<10KB) M(<100KB) L(>100KB)",
    "# Status: ACTIVE ARCHIVED STALE",
    "",
  ];
  for (const entry of entries) {
    lines.push(serializeEntry(entry));
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Pointer Index Manager Class
// ---------------------------------------------------------------------------

export class PointerIndexManager {
  private readonly indexPath: string;
  private cache: PointerIndex | null = null;
  private cacheContent: string = "";

  constructor(indexPath: string) {
    this.indexPath = indexPath;
  }

  /** Read and parse the index file from disk. */
  read(): PointerIndex {
    if (!existsSync(this.indexPath)) {
      return [];
    }
    const content = readFileSync(this.indexPath, "utf-8");
    if (content === this.cacheContent && this.cache !== null) {
      return this.cache;
    }
    this.cacheContent = content;
    this.cache = parsePointerIndex(content);
    return this.cache;
  }

  /** Get the raw index file content (for embedding in context). */
  readRaw(): string {
    if (!existsSync(this.indexPath)) {
      return "";
    }
    return readFileSync(this.indexPath, "utf-8");
  }

  /** Get a specific entry by topic. */
  getByTopic(topic: string): PointerEntry | null {
    const entries = this.read();
    return entries.find((e) => e.topic === topic) ?? null;
  }

  /** Get entries by category. */
  getByCategory(category: string): PointerEntry[] {
    const entries = this.read();
    return entries.filter((e) => e.category === category);
  }

  /** Upsert an entry — replaces existing entry for same topic, or appends. */
  upsert(entry: PointerEntry): void {
    const entries = this.read();
    const existingIdx = entries.findIndex((e) => e.topic === entry.topic);
    if (existingIdx >= 0) {
      entries[existingIdx] = entry;
    } else {
      entries.push(entry);
    }
    this.writeAll(entries);
  }

  /** Remove an entry by topic. */
  removeByTopic(topic: string): boolean {
    const entries = this.read();
    const before = entries.length;
    const filtered = entries.filter((e) => e.topic !== topic);
    if (filtered.length === before) {
      return false;
    }
    this.writeAll(filtered);
    return true;
  }

  /** Remove all entries in a category. */
  removeByCategory(category: string): boolean {
    const entries = this.read();
    const before = entries.length;
    const filtered = entries.filter((e) => e.category !== category);
    if (filtered.length === before) {
      return false;
    }
    this.writeAll(filtered);
    return true;
  }

  /** Write the full index — use only after successful operation (write discipliner). */
  writeAll(entries: PointerIndex): void {
    const content = serializePointerIndex(entries);
    writeFileSync(this.indexPath, content, "utf-8");
    this.cache = entries;
    this.cacheContent = content;
  }

  /** Invalidate cache — next read will hit disk. */
  invalidateCache(): void {
    this.cache = null;
    this.cacheContent = "";
  }

  /** Get all topics. */
  listTopics(): string[] {
    return this.read().map((e) => e.topic);
  }

  /** Check if a topic exists. */
  hasTopic(topic: string): boolean {
    return this.read().some((e) => e.topic === topic);
  }

  /** Get entries updated after a given date. */
  getUpdatedSince(date: string): PointerEntry[] {
    return this.read().filter((e) => e.lastUpdated >= date);
  }

  /** Resolve a topic to its file path (absolute). */
  resolveTopicFile(topic: string, topicsDir: string): string | null {
    const entry = this.getByTopic(topic);
    if (!entry) {
      return null;
    }
    return resolve(topicsDir, `${entry.topic}.md`);
  }
}

/**
 * memory-consolidator.ts
 *
 * Implements the memory consolidation task that runs as a forked subagent.
 *
 * This module does NOT run in the main agent context — it is executed by a
 * ForkedSubagentHandle so it cannot corrupt or bloat the parent's context.
 *
 * Responsibilities:
 * 1. Load raw memory notes from the workspace
 * 2. Merge disparate observations into coherent facts
 * 3. Detect and remove logical contradictions
 * 4. Convert vague notes ("maybe X", "I think Y") into absolute facts where confidence is high
 * 5. Update the pointer index only AFTER successful write (strict discipline)
 * 6. Return a structured consolidation report
 *
 * Output format (via <<<FORK_RESULT>>> markers):
 * {
 *   consolidatedCount: number,
 *   contradictionsResolved: number,
 *   vagueConverted: number,
 *   pointerIndexUpdated: boolean,
 *   facts: Fact[],
 *   warnings: string[],
 * }
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const FactSchema = z.object({
  id: z.string(),
  content: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
  sourceFiles: z.array(z.string()).default([]),
  /** ISO date string when this fact was first observed */
  firstSeen: z.string(),
  /** ISO date string of last update */
  lastUpdated: z.string(),
  tags: z.array(z.string()).default([]),
  /** Set to true once this fact has been written to the pointer index */
  indexed: z.boolean().default(false),
});

export const ConsolidationReportSchema = z.object({
  consolidatedCount: z.number().int().min(0),
  contradictionsResolved: z.number().int().min(0),
  vagueConverted: z.number().int().min(0),
  pointerIndexUpdated: z.boolean(),
  facts: z.array(FactSchema),
  warnings: z.array(z.string()),
  durationMs: z.number(),
  memoryFilesProcessed: z.number().int().min(0),
});

export type Fact = z.infer<typeof FactSchema>;
export type ConsolidationReport = z.infer<typeof ConsolidationReportSchema>;

// ---------------------------------------------------------------------------
// Memory file locations (workspace-relative)
// ---------------------------------------------------------------------------

const MEMORY_DIR = "memory";
const POINTER_INDEX_FILE = "memory/pointer-index.json";
const CONSOLIDATION_LOG_FILE = "memory/consolidation-log.jsonl";

// ---------------------------------------------------------------------------
// Vague-phrase patterns that indicate low-confidence notes
// ---------------------------------------------------------------------------

const VAGUE_PATTERNS = [
  /\bmaybe\b/i,
  /\bI think\b/i,
  /\bprobably\b/i,
  /\bmight be\b/i,
  /\bseems like\b/i,
  /\bpossibly\b/i,
  /\bperhaps\b/i,
  /\bnot sure\b/i,
  /\bnot certain\b/i,
  /\bnot sure if\b/i,
  /\bI recall\b/i,
  /\bif I remember\b/i,
  /\broughly\b/i,
  /\bapproximately\b/i,
  /\babout\b.*\bor so\b/i,
  /\bsomewhat\b/i,
  /\bkinda\b/i,
  /\bsort of\b/i,
];

const HIGH_CONFIDENCE_INDICATORS = [
  /\bexplicitly\b/,
  /\bstated\b/,
  /\bnamed\b/,
  /\bdefined\b/,
  /\bconfirmed\b/,
  /\bdocumented\b/,
  /\bspecifically\b/,
  /\bdecided\b/,
  /\bagreed\b/,
  /\bcontract\b/,
  /\bsigned\b/,
  /\bpaid\b/,
  /\bcompleted\b/,
  /\bfinished\b/,
  /\bdelivered\b/,
  /\bdeployed\b/,
];

// ---------------------------------------------------------------------------
// Fact extraction & merging
// ---------------------------------------------------------------------------

function extractFactsFromContent(content: string, sourceFile: string): Fact[] {
  const facts: Fact[] = [];
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const now = new Date().toISOString();

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines, headers, and dividers
    if (!trimmed || /^#{1,6}\s/.test(trimmed) || /^---$/.test(trimmed)) {
      continue;
    }

    // Skip bullet list markers and checkboxes for fact extraction
    const text = trimmed
      .replace(/^[-*+]\s*/, "")
      .replace(/^\[[ x]\]\s*/i, "")
      .trim();
    if (!text || text.length < 3) {
      continue;
    }

    // Determine confidence
    const isVague = VAGUE_PATTERNS.some((p) => p.test(text));
    const isHighConfidence = HIGH_CONFIDENCE_INDICATORS.some((p) => p.test(text));

    const confidence: Fact["confidence"] = isVague ? "low" : isHighConfidence ? "high" : "medium";

    const tags = detectTags(text);

    facts.push({
      id: `fact:${Buffer.from(text.slice(0, 80)).toString("base64url")}`,
      content: text,
      confidence,
      sourceFiles: [sourceFile],
      firstSeen: now,
      lastUpdated: now,
      tags,
      indexed: false,
    });
  }

  return facts;
}

function detectTags(text: string): string[] {
  const tags: string[] = [];
  // Extract #tag patterns
  const tagMatches = text.match(/#[a-zA-Z][a-zA-Z0-9_-]*/g);
  if (tagMatches) {
    tags.push(...tagMatches.map((t) => t.slice(1).toLowerCase()));
  }
  // Detect domain keywords
  const domainKeywords = ["domain", "investing", "portfolio", "renewal", "expiry", "sale"];
  for (const kw of domainKeywords) {
    if (text.toLowerCase().includes(kw)) {
      tags.push(kw);
    }
  }
  const projectKeywords = ["project", "client", "agency", "invoice", "payment"];
  for (const kw of projectKeywords) {
    if (text.toLowerCase().includes(kw)) {
      tags.push(kw);
    }
  }
  return [...new Set(tags)].slice(0, 10);
}

// ---------------------------------------------------------------------------
// Contradiction detection
// ---------------------------------------------------------------------------

interface Contradiction {
  factA: Fact;
  factB: Fact;
  resolution: string;
}

function detectContradictions(facts: Fact[]): Contradiction[] {
  const contradictions: Contradiction[] = [];
  const byContent = new Map<string, Fact[]>();

  // Normalize for comparison
  for (const fact of facts) {
    const key = normalizeForComparison(fact.content);
    const existing = byContent.get(key) ?? [];
    existing.push(fact);
    byContent.set(key, existing);
  }

  // Check for negation patterns between facts
  const factArray = [...byContent.entries()];
  for (let i = 0; i < factArray.length; i++) {
    for (let j = i + 1; j < factArray.length; j++) {
      const [keyA, groupA] = factArray[i];
      const [keyB, groupB] = factArray[j];
      if (areNegations(keyA, keyB)) {
        const higherConfidence = groupA[0].confidence === "high" ? groupA[0] : groupB[0];
        const _lowerConfidence = groupA[0].confidence === "high" ? groupB[0] : groupA[0];
        contradictions.push({
          factA: groupA[0],
          factB: groupB[0],
          resolution: `Resolved in favor of higher-confidence note (${higherConfidence.confidence}): "${higherConfidence.content.slice(0, 60)}..."`,
        });
      }
    }
  }

  return contradictions;
}

function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

const NEGATION_PATTERNS = [
  // "X" vs "not X"
  /^(.+)not (.+)$/,
  // "is X" vs "is not/never/no longer X"
  /\bnot\b/,
  /\bnever\b/,
  /\bno longer\b/,
  /\bdoesn't\b/,
  /\bdoes not\b/,
  /\bdidn't\b/,
  /\bwon't\b/,
  /\bwouldn't\b/,
  /\bcan't\b/,
  /\bcannot\b/,
  /\bhasn't\b/,
  /\bhaven't\b/,
];

function areNegations(textA: string, textB: string): boolean {
  const hasNegation = (t: string) => NEGATION_PATTERNS.some((p) => p.test(t));
  return hasNegation(textA) !== hasNegation(textB);
}

// ---------------------------------------------------------------------------
// Merge facts (deduplicate, combine sources, upgrade confidence)
// ---------------------------------------------------------------------------

function mergeFacts(facts: Fact[]): Fact[] {
  const byKey = new Map<string, Fact>();

  for (const fact of facts) {
    const key = normalizeForComparison(fact.content);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...fact });
    } else {
      // Merge: combine source files, keep latest timestamp, upgrade confidence
      const sources = [...new Set([...existing.sourceFiles, ...fact.sourceFiles])];
      const confidenceOrder = ["low", "medium", "high"] as const;
      const existingIdx = confidenceOrder.indexOf(existing.confidence);
      const newIdx = confidenceOrder.indexOf(fact.confidence);
      const mergedConfidence = newIdx > existingIdx ? fact.confidence : existing.confidence;
      const latestUpdated =
        fact.lastUpdated > existing.lastUpdated ? fact.lastUpdated : existing.lastUpdated;
      byKey.set(key, {
        ...existing,
        sourceFiles: sources,
        confidence: mergedConfidence,
        lastUpdated: latestUpdated,
        tags: [...new Set([...existing.tags, ...fact.tags])].slice(0, 10),
      });
    }
  }

  return Array.from(byKey.values());
}

// ---------------------------------------------------------------------------
// Convert vague notes to facts where possible
// ---------------------------------------------------------------------------

function convertVagueToAbsolute(facts: Fact[]): { facts: Fact[]; converted: number } {
  let converted = 0;
  const result = facts.map((fact) => {
    if (fact.confidence !== "low") {
      return fact;
    }

    const text = fact.content;

    // Heuristic: if the note has multiple corroborating facts with same tag,
    // upgrade its confidence
    const relatedCount = facts.filter(
      (f) =>
        f.id !== fact.id && f.confidence === "high" && f.tags.some((t) => fact.tags.includes(t)),
    ).length;

    if (relatedCount >= 2) {
      converted++;
      return {
        ...fact,
        confidence: "medium" as const,
        content: text
          .replace(/\bmaybe\b/gi, "")
          .replace(/\bprobably\b/gi, "")
          .trim(),
      };
    }

    return fact;
  });

  return { facts: result, converted };
}

// ---------------------------------------------------------------------------
// Pointer index update (strict: only after successful write)
// ---------------------------------------------------------------------------

async function _loadPointerIndex(workspaceDir: string): Promise<Map<string, Fact>> {
  const indexPath = path.join(workspaceDir, POINTER_INDEX_FILE);
  try {
    const raw = await fs.readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw);
    const map = new Map<string, Fact>();
    if (Array.isArray(parsed.facts)) {
      for (const f of parsed.facts) {
        map.set(f.id, FactSchema.parse(f));
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

async function savePointerIndex(
  workspaceDir: string,
  facts: Fact[],
): Promise<{ success: boolean; error?: string }> {
  const indexPath = path.join(workspaceDir, POINTER_INDEX_FILE);
  const tempPath = `${indexPath}.tmp.${Date.now()}`;

  try {
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      facts: facts.map((f) => ({ ...f, indexed: true })),
    };

    // Write to temp file first (atomic write discipline)
    await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");

    // Ensure parent dir exists
    await fs.mkdir(path.dirname(indexPath), { recursive: true });

    // Rename to final location (atomic on POSIX)
    await fs.rename(tempPath, indexPath);

    return { success: true };
  } catch (err) {
    // Clean up temp file if it exists
    try {
      await fs.unlink(tempPath);
    } catch {
      // Best-effort
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Consolidation log
// ---------------------------------------------------------------------------

async function appendConsolidationLog(
  workspaceDir: string,
  report: ConsolidationReport,
): Promise<void> {
  const logPath = path.join(workspaceDir, CONSOLIDATION_LOG_FILE);
  try {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...report,
    });
    await fs.appendFile(logPath, line + "\n", "utf8");
  } catch {
    // Best-effort: logging failure should not fail the consolidation
  }
}

// ---------------------------------------------------------------------------
// Main consolidation function (called by forked subagent)
// ---------------------------------------------------------------------------

export interface ConsolidateMemoryOptions {
  workspaceDir: string;
  /** Glob pattern for memory files to process (default: memory subdirectory glob) */
  filePattern?: string;
  /** Only process files modified since this ISO date */
  since?: string;
  /** Custom VAGUE_PATTERNS override */
  vaguePatterns?: RegExp[];
}

export async function consolidateMemory(
  opts: ConsolidateMemoryOptions,
): Promise<ConsolidationReport> {
  const start = Date.now();
  const { workspaceDir, filePattern = "**/*.md", since, vaguePatterns } = opts;

  const _effectiveVaguePatterns = vaguePatterns ?? VAGUE_PATTERNS;

  const warnings: string[] = [];
  const allFacts: Fact[] = [];
  let memoryFilesProcessed = 0;

  // Find all memory files
  let memoryFiles: string[];
  try {
    const { glob } = await import("tinyglobby");
    memoryFiles = await glob(filePattern, {
      cwd: workspaceDir,
      ignore: ["**/node_modules/**"],
    });
  } catch {
    // Fallback: manual scan
    try {
      const dir = path.join(workspaceDir, MEMORY_DIR);
      const entries = await fs.readdir(dir, { withFileTypes: true });
      memoryFiles = entries
        .filter((e) => e.isFile() && e.name.endsWith(".md"))
        .map((e) => path.join(MEMORY_DIR, e.name));
    } catch {
      warnings.push("Could not access memory directory");
      memoryFiles = [];
    }
  }

  // Process each file
  for (const relFile of memoryFiles) {
    const absFile = path.join(workspaceDir, relFile);
    try {
      const stat = await fs.stat(absFile);
      if (since) {
        const sinceDate = new Date(since);
        if (stat.mtime < sinceDate) {
          continue;
        }
      }
      const content = await fs.readFile(absFile, "utf8");
      const facts = extractFactsFromContent(content, relFile);
      allFacts.push(...facts);
      memoryFilesProcessed++;
    } catch (err) {
      warnings.push(`Failed to read ${relFile}: ${String(err)}`);
    }
  }

  // Step 1: Merge duplicates and related facts
  const merged = mergeFacts(allFacts);

  // Step 2: Detect and resolve contradictions
  const contradictions = detectContradictions(merged);
  const resolvedFacts = merged.filter((f) => {
    // Keep higher-confidence version of contradiction pairs
    for (const c of contradictions) {
      if (f.id === c.factA.id || f.id === c.factB.id) {
        // Keep the one with higher confidence
        const keep =
          f.id === c.factA.id
            ? c.factA.confidence === "high" ||
              (c.factA.confidence !== "low" && c.factB.confidence === "low")
            : c.factB.confidence === "high" ||
              (c.factB.confidence !== "low" && c.factA.confidence === "low");
        if (!keep) {
          return false;
        }
      }
    }
    return true;
  });

  // Step 3: Convert vague notes to absolute facts
  const { facts: convertedFacts, converted } = convertVagueToAbsolute(resolvedFacts);

  // Step 4: Sort by confidence then recency
  const confidenceOrder = ["high", "medium", "low"] as const;
  convertedFacts.sort((a, b) => {
    const confDiff = confidenceOrder.indexOf(a.confidence) - confidenceOrder.indexOf(b.confidence);
    if (confDiff !== 0) {
      return confDiff;
    }
    return b.lastUpdated.localeCompare(a.lastUpdated);
  });

  // Step 5: Update pointer index (strict: only after successful write)
  const indexUpdated = await savePointerIndex(workspaceDir, convertedFacts);
  if (!indexUpdated.success) {
    warnings.push(`Pointer index update failed: ${indexUpdated.error}`);
  }

  // Step 6: Log consolidation run
  const report: ConsolidationReport = {
    consolidatedCount: convertedFacts.length,
    contradictionsResolved: contradictions.length,
    vagueConverted: converted,
    pointerIndexUpdated: indexUpdated.success,
    facts: convertedFacts,
    warnings,
    durationMs: Date.now() - start,
    memoryFilesProcessed,
  };

  await appendConsolidationLog(workspaceDir, report);

  return report;
}

// ---------------------------------------------------------------------------
// CLI / direct-run support (for testing outside a subagent session)
// ---------------------------------------------------------------------------

export async function runConsolidationFromArgs(): Promise<void> {
  const workspaceDir = process.argv[2] ?? process.cwd();
  const report = await consolidateMemory({ workspaceDir });

  // Emit structured result for ForkedSubagentHandle parsing
  const resultPayload = {
    consolidatedCount: report.consolidatedCount,
    contradictionsResolved: report.contradictionsResolved,
    vagueConverted: report.vagueConverted,
    pointerIndexUpdated: report.pointerIndexUpdated,
    facts: report.facts.slice(0, 50), // Don't bloat parent context with full fact list
    warnings: report.warnings,
    durationMs: report.durationMs,
    memoryFilesProcessed: report.memoryFilesProcessed,
  };

  // Write to stdout in a parseable way
  console.log("\n<<<FORK_RESULT>>>");
  console.log(JSON.stringify(resultPayload, null, 2));
  console.log("<<<FORK_RESULT_END>>>\n");
  console.log(
    `Memory consolidation complete: ${report.consolidatedCount} facts, ${report.contradictionsResolved} contradictions resolved, ${report.vagueConverted} vague notes upgraded.`,
  );
}

// Allow direct execution: npx tsx src/agents/memory-consolidator.ts <workspaceDir>
runConsolidationFromArgs().catch((err) => {
  console.error("Consolidation failed:", err);
  process.exit(1);
});

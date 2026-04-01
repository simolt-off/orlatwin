/**
 * Topic Loader — loads full topic files on-demand.
 *
 * Topic files are stored in memory/topics/ and are NEVER kept in main context.
 * They are loaded only when a specific topic is needed.
 */

import { readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { PointerIndexManager, calcSizeHint, type SizeHint } from "./orla-pointer-index.js";

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

export const TopicFrontmatterSchema = z.object({
  topic: z.string().min(1),
  created: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  updated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tags: z.array(z.string()).default([]),
  summary: z.string().max(300).optional(),
});
export type TopicFrontmatter = z.infer<typeof TopicFrontmatterSchema>;

export interface LoadedTopic {
  frontmatter: TopicFrontmatter;
  content: string;
  filePath: string;
  byteSize: number;
  sizeHint: SizeHint;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

function parseFrontmatter(raw: string): { frontmatter: TopicFrontmatter; content: string } {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    // No frontmatter — treat entire content as raw
    return {
      frontmatter: {
        topic: "unknown",
        created: new Date().toISOString().slice(0, 10),
        updated: new Date().toISOString().slice(0, 10),
        tags: [],
      },
      content: raw,
    };
  }

  const yamlBlock = match[1];
  const content = match[2];
  const meta = yamlBlockToRecord(yamlBlock);

  const parsed = TopicFrontmatterSchema.safeParse(meta);
  const frontmatter = parsed.success
    ? parsed.data
    : {
        topic: typeof meta.topic === "string" ? meta.topic : "unknown",
        created:
          typeof meta.created === "string" ? meta.created : new Date().toISOString().slice(0, 10),
        updated: new Date().toISOString().slice(0, 10),
        tags: [] as string[],
        summary: typeof meta.summary === "string" ? meta.summary : "",
      };

  return { frontmatter, content };
}

function yamlBlockToRecord(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const line of yaml.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) {
      continue;
    }
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key === "tags") {
      // Handle inline YAML array: [tag1, tag2]
      const arrayMatch = value.match(/^\[([\s\S]*)\]$/);
      if (arrayMatch) {
        result[key] = arrayMatch[1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        continue;
      }
      result[key] = [];
    } else {
      result[key] = value.replace(/^['"]|['"]$/g, "");
    }
  }
  return result;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Topic Loader Class
// ---------------------------------------------------------------------------

export class TopicLoader {
  private readonly topicsDir: string;
  private readonly indexManager: PointerIndexManager;
  private loaded: Map<string, LoadedTopic> = new Map();

  constructor(topicsDir: string, indexPath: string) {
    this.topicsDir = topicsDir;
    this.indexManager = new PointerIndexManager(indexPath);
  }

  /**
   * Load a topic file by topic name.
   * Returns null if topic is not registered in the pointer index.
   */
  load(topic: string): LoadedTopic | null {
    const cached = this.loaded.get(topic);
    if (cached) {
      return cached;
    }

    const entry = this.indexManager.getByTopic(topic);
    if (!entry) {
      return null;
    }

    const filePath = resolve(this.topicsDir, entry.category, `${entry.topic}.md`);
    if (!existsSync(filePath)) {
      return null;
    }

    const raw = readFileSync(filePath, "utf-8");
    const stats = statSync(filePath);
    const { frontmatter, content } = parseFrontmatter(raw);

    const loaded: LoadedTopic = {
      frontmatter,
      content,
      filePath,
      byteSize: stats.size,
      sizeHint: calcSizeHint(stats.size),
    };

    this.loaded.set(topic, loaded);
    return loaded;
  }

  /**
   * Load multiple topics at once.
   */
  loadMany(topics: string[]): Map<string, LoadedTopic | null> {
    const results = new Map<string, LoadedTopic | null>();
    for (const topic of topics) {
      results.set(topic, this.load(topic));
    }
    return results;
  }

  /**
   * Get content only — skips frontmatter parsing for callers that don't need it.
   */
  loadContent(topic: string): string | null {
    const loaded = this.load(topic);
    return loaded?.content ?? null;
  }

  /**
   * Write or update a topic file.
   * NOTE: This does NOT update the pointer index — caller must do so AFTER success.
   * This is intentional: strict write discipline (index updated only after success).
   */
  write(
    topic: string,
    content: string,
    opts?: {
      tags?: string[];
      summary?: string;
      fileName?: string;
    },
  ): { frontmatter: TopicFrontmatter; filePath: string } {
    const fileName = opts?.fileName ?? `${topic}.md`;
    const filePath = resolve(this.topicsDir, fileName);

    // Ensure topics dir exists
    mkdirSync(this.topicsDir, { recursive: true });

    const now = today();
    const existing = this.indexManager.getByTopic(topic);

    const frontmatter: TopicFrontmatter = {
      topic,
      created: existing?.lastUpdated.slice(0, 10) ?? now, // preserve created if re-writing
      updated: now,
      tags: opts?.tags ?? [],
      summary: opts?.summary,
    };

    const fileContent = `---\ntopic: ${topic}\ncreated: ${frontmatter.created}\nupdated: ${frontmatter.updated}\ntags: [${frontmatter.tags.join(", ")}]\nsummary: ${frontmatter.summary ?? ""}\n---\n\n${content}`;
    writeFileSync(filePath, fileContent, "utf-8");

    // Invalidate cache
    this.loaded.delete(topic);
    this.indexManager.invalidateCache();

    return { frontmatter, filePath };
  }

  /**
   * Append to an existing topic file.
   * Returns false if topic doesn't exist.
   */
  append(topic: string, newContent: string): boolean {
    const loaded = this.load(topic);
    if (!loaded) {
      return false;
    }

    const updatedContent = loaded.content + "\n\n" + newContent;
    const filePath = resolve(this.topicsDir, topic + ".md");

    // Read raw, preserve frontmatter
    const raw = readFileSync(filePath, "utf-8");
    const { frontmatter } = parseFrontmatter(raw);
    frontmatter.updated = today();

    const fileContent = `---\ntopic: ${topic}\ncreated: ${frontmatter.created}\nupdated: ${frontmatter.updated}\ntags: [${frontmatter.tags.join(", ")}]\nsummary: ${frontmatter.summary ?? ""}\n---\n\n${updatedContent}`;
    writeFileSync(filePath, fileContent, "utf-8");

    // Invalidate cache
    this.loaded.delete(topic);
    this.indexManager.invalidateCache();

    return true;
  }

  /**
   * Delete a topic file and remove it from the index.
   */
  delete(topic: string): boolean {
    const entry = this.indexManager.getByTopic(topic);
    if (!entry) {
      return false;
    }

    const filePath = resolve(this.topicsDir, entry.category, `${entry.topic}.md`);
    if (existsSync(filePath)) {
      // Note: we don't actually delete the file here to be safe.
      // Mark as deleted in index instead.
    }

    this.indexManager.removeByTopic(topic);
    this.loaded.delete(topic);
    return true;
  }

  /** Get the index manager for pointer operations. */
  getIndexManager(): PointerIndexManager {
    return this.indexManager;
  }

  /** Get list of all registered topics. */
  listTopics(): string[] {
    return this.indexManager.listTopics();
  }

  /** Clear the in-memory cache (forces re-read from disk next load). */
  clearCache(): void {
    this.loaded.clear();
  }
}

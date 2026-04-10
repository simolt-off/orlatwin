/**
 * orla-proactive/jobs-init.ts
 *
 * Initializes Orla cron jobs from HEARTBEAT.md at gateway boot.
 * Jobs are defined in HEARTBEAT.md YAML section:
 *
 * ```yaml
 * jobs:
 *   - id: domain-drops-check
 *     every: 1h
 *     action: Check ExpiredDomains for .ai/.com drops
 * ```
 *
 * Env vars:
 *   ORLATWIN_JOBS_ENABLED=1 — enable self-configuring jobs
 */

import * as fs from "node:fs";
import type { CronService } from "../cron/service.js";
import type { RegisterKairosJobsResult } from "./kairos-cron.js";

const DURATION_MAP: Record<string, number> = {
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
};

export interface HeartbeatJob {
  id: string;
  every: string;
  action: string;
  channel?: string;
  enabled?: boolean;
}

export function parseDurationMs(every: string): number | null {
  const match = every.match(/^(\d+)([mhd])$/);
  if (!match) {
    return null;
  }
  const num = parseInt(match[1], 10);
  const unit = match[2] as "m" | "h" | "d";
  return num * DURATION_MAP[unit];
}

export function parseJobsFromMarkdown(markdown: string): HeartbeatJob[] {
  const match = markdown.match(/```ya?ml\n([\s\S]*?)```/);
  if (!match) {
    return [];
  }
  try {
    // Simple YAML parsing without yaml dependency
    const yaml = match[1];
    const jobs: HeartbeatJob[] = [];
    let current: Partial<HeartbeatJob> = {};

    for (const line of yaml.split("\n")) {
      const idMatch = line.match(/^\s*-\s*id:\s*(.+)/);
      const everyMatch = line.match(/^\s*every:\s*(.+)/);
      const actionMatch = line.match(/^\s*action:\s*(.+)/);

      if (idMatch) {
        if (current.id) {
          jobs.push(current as HeartbeatJob);
        }
        current = { id: idMatch[1].trim(), enabled: true };
      }
      if (everyMatch && current.id) {
        current.every = everyMatch[1].trim();
      }
      if (actionMatch && current.id) {
        current.action = actionMatch[1].trim();
      }
    }
    if (current.id) {
      jobs.push(current as HeartbeatJob);
    }
    return jobs.filter((j) => j.id && j.every && j.action);
  } catch {
    return [];
  }
}

export async function initJobsFromHeartbeat(
  heartbeatPath: string,
  cron: CronService,
): Promise<RegisterKairosJobsResult> {
  try {
    const markdown = await fs.promises.readFile(heartbeatPath, "utf-8");
    const jobs = parseJobsFromMarkdown(markdown);
    const registered: string[] = [];

    for (const job of jobs) {
      if (job.enabled === false) {
        continue;
      }
      const everyMs = parseDurationMs(job.every);
      if (!everyMs) {
        continue;
      }

      await cron.add({
        name: `heartbeat-${job.id}`,
        schedule: { kind: "every", everyMs },
        payload: { kind: "agentTurn", message: job.action },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        enabled: true,
        description: `From HEARTBEAT.md: ${job.action}`,
      });
      registered.push(job.id);
    }

    return { registered, errors: [], skipped: [] };
  } catch (err) {
    return { registered: [], errors: [(err as Error).message], skipped: [] };
  }
}

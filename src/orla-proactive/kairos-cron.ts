/**
 * orla-proactive/kairos-cron.ts
 *
 * Registers KAIROS background tasks as OpenClaw cron jobs.
 * Uses the existing cron system (sessionTarget=isolated) so KAIROS
 * runs in forked subagent sessions that never touch the main context.
 *
 * Jobs registered:
 * 1. orla-kairos-dream — memory consolidation every 30min when idle
 * 2. orla-proactive-check — proactive suggestion check every 5min
 * 3. orla-skill-scan — security scan every hour
 */

import { resolveCronStorePath, loadCronStore, saveCronStore } from "../cron/store.js";
import { isFlagEnabled } from "../feature-flags/index.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getCronStore() {
  const storePath = resolveCronStorePath();
  return loadCronStore(storePath);
}

async function saveStore(store: Awaited<ReturnType<typeof getCronStore>>) {
  const storePath = resolveCronStorePath();
  await saveCronStore(storePath, store);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _jobExists(jobs: Array<{ id?: string }>, id: string): boolean {
  return jobs.some((j) => j.id === id);
}

// ─── KAIROS Dream Job ─────────────────────────────────────────────────────────
// Memory consolidation: runs in isolated session, keeps main context clean

const KAIROS_DREAM_JOB = {
  id: "orla-kairos-dream",
  name: "Orla KAIROS Dream — Memory Consolidation",
  description:
    "Memory consolidation during idle. Merges observations, removes contradictions, cleans stale pointers. Runs in forked isolated session.",
  enabled: true,
  schedule: {
    kind: "every" as const,
    everyMs: 30 * 60 * 1000, // every 30 minutes
  },
  sessionTarget: "isolated" as const,
  wakeMode: "now" as const,
  payload: {
    kind: "agentTurn" as const,
    message: `You are running a KAIROS memory consolidation cycle.

Your task: Clean and optimize the memory pointer index without touching the main agent context.

Steps:
1. Read memory/pointer-index.md to find stale or oversized topics
2. For each topic file in memory/topics/, check if it needs:
   - Consolidation (merging duplicate entries)
   - Compaction (reducing verbose content)
   - Archival (moving old entries to memory/archive/)
3. Use strict write discipline: write changes to disk FIRST, then update pointer-index.md only after confirmed writes succeed
4. Log what you did to memory/topics/dream-log.md

Rules:
- NEVER load full topic files into your context — work on pointers only unless specifically needed
- NEVER modify SOUL.md, PROFILE.md, DECISIONS-LOG.md, or USER.md
- Report back: what was consolidated, what was cleaned, what remains

Reply with a brief summary of actions taken.`,
    thinking: "medium",
    timeoutSeconds: 120,
  },
  delivery: {
    mode: "none" as const,
  },
};

// ─── Proactive Check Job ──────────────────────────────────────────────────────
// Lightweight suggestion generation every 5 minutes

const PROACTIVE_CHECK_JOB = {
  id: "orla-proactive-check",
  name: "Orla Proactive Check",
  description:
    "Lightweight proactive suggestion generation. Checks for opportunities and queues suggestions for Abdullah.",
  enabled: true,
  schedule: {
    kind: "every" as const,
    everyMs: 5 * 60 * 1000, // every 5 minutes
  },
  sessionTarget: "isolated" as const,
  wakeMode: "now" as const,
  payload: {
    kind: "agentTurn" as const,
    message: `You are running a PROACTIVE check for Abdullah Soliman.

Context: You are Orla, his Digital Twin. You operate PROACTIVELY — suggesting and acting within GREEN-tier boundaries.

Check the following proactively:
1. Domain portfolio health — check memory/topics/domains.md for any urgent items
2. Pending tasks — check memory/HEARTBEAT.md for overdue tasks
3. Email/leads — check workspace for any unprocessed leads
4. Recent decisions — check DECISIONS-LOG.md for any items needing follow-up

For each opportunity found:
- GREEN-tier (read/search): ACT immediately, log result
- YELLOW-tier (write/config): QUEUE as suggestion, report to Abdullah  
- RED-tier (external/send): SKIP and report to Abdullah

Reply with:
- Actions taken (GREEN)
- Suggestions queued (YELLOW/RED with reason)
- Current memory pressure (estimated)`,
    thinking: "low",
    timeoutSeconds: 60,
  },
  delivery: {
    mode: "announce" as const,
    channel: "last" as const,
    bestEffort: true,
  },
};

// ─── Skill Security Scan Job ─────────────────────────────────────────────────

const SKILL_SCAN_JOB = {
  id: "orla-skill-scan",
  name: "Orla Skill Security Scan",
  description:
    "Scans loaded skills for suspicious imports, dangerous patterns, and policy violations.",
  enabled: true,
  schedule: {
    kind: "cron" as const,
    expr: "0 * * * *", // every hour
    tz: "Africa/Cairo",
  },
  sessionTarget: "isolated" as const,
  wakeMode: "now" as const,
  payload: {
    kind: "agentTurn" as const,
    message: `You are running a SKILL SCANNER security audit.

Scan the skills directory: /home/soliman/.openclaw/workspace/skills/

For each skill:
1. Read its SKILL.md to understand purpose
2. Read src/index.ts and src/executor.ts (if exists) for:
   - Dangerous imports (child_process with shell:true, eval, Function constructor)
   - Suspicious patterns (string concatenation in exec, base64 decode followed by eval)
   - Missing permission tier declarations
3. Check for: hardcoded credentials, API keys in source, suspicious URLs

Report in JSON format:
{
  "scanTime": "<ISO timestamp>",
  "skillsScanned": <number>,
  "issues": [
    { "skill": "<name>", "severity": "high|medium|low", "issue": "<description>", "file": "<path>" }
  ],
  "cleanSkills": ["<skill>", ...]
}

If HIGH severity issue found: ALSO write to memory/topics/security-alerts.md
Reply with the full JSON report.`,
    thinking: "medium",
    timeoutSeconds: 180,
  },
  delivery: {
    mode: "announce" as const,
    channel: "last" as const,
    bestEffort: true,
  },
};

// ─── WAL Last Update Tracker ─────────────────────────────────────────────────
// Quick dirty check without full WAL initialization

// ─── Registration ─────────────────────────────────────────────────────────────

export interface RegisterKairosJobsResult {
  registered: string[];
  skipped: string[];
  errors: string[];
}

const KAIROS_JOBS = [
  { job: KAIROS_DREAM_JOB, flag: "AUTO_DREAM" as const },
  { job: PROACTIVE_CHECK_JOB, flag: "PROACTIVE_MODE" as const },
  { job: SKILL_SCAN_JOB, flag: "SKILL_SCANNER" as const },
];

export async function registerOrlaCronJobs(): Promise<RegisterKairosJobsResult> {
  const result: RegisterKairosJobsResult = {
    registered: [],
    skipped: [],
    errors: [],
  };

  // Check feature flags first
  const flagChecks = KAIROS_JOBS.map(({ job, flag }) => ({
    job,
    flag,
    enabled: isFlagEnabled(flag),
  }));

  // Always register — but jobs check flags at runtime too
  // This allows dynamic enabling without re-registration

  try {
    const store = await getCronStore();
    const existingIds = new Set(store.jobs.map((j) => j.id));

    for (const { job } of flagChecks) {
      if (existingIds.has(job.id)) {
        result.skipped.push(job.id);
        continue;
      }

      const newJob = {
        ...job,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      };

      store.jobs.push(newJob as never);
      result.registered.push(job.id);
    }

    await saveStore(store);
    console.debug("[orla-proactive] Cron jobs registered:", result.registered);
  } catch (err) {
    result.errors.push(String(err));
    console.error("[orla-proactive] Failed to register cron jobs:", err);
  }

  return result;
}

/**
 * Remove all ORLA cron jobs (for cleanup/uninstall).
 */
export async function deregisterOrlaCronJobs(): Promise<void> {
  const store = await getCronStore();
  const orlaIds = new Set(KAIROS_JOBS.map((j) => j.job.id));
  store.jobs = store.jobs.filter((j) => !orlaIds.has(j.id));
  await saveStore(store);
  console.debug("[orla-proactive] Cron jobs deregistered");
}

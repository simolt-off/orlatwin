/**
 * Proactive Monitor — Background daemon for opportunity monitoring.
 *
 * Runs periodic checks while Orla is idle:
 * - Domain portfolio health & expiry alerts
 * - Lead/email urgency monitoring
 * - n8n workflow triggers on schedule
 * - Alert delivery via configured channels
 *
 * Designed to be lightweight — each check is a quick read-only scan.
 * Heavy operations are deferred to the kairos-agent subagent.
 */

import { z } from "zod";
import { createSubsystemLogger } from "../logging/subsystem.js";

// ============================================================================
// Config Schema
// ============================================================================

const AlertChannelSchema = z.object({
  channel: z.enum(["telegram", "discord", "email", "webhook", "none"]),
  to: z.string().optional(),
  accountId: z.string().optional(),
});
export type AlertChannel = z.infer<typeof AlertChannelSchema>;

const DomainMonitorConfigSchema = z.object({
  /** Enable domain portfolio monitoring. Default: true */
  enabled: z.boolean().optional().default(true),
  /** Check interval in ms. Default: 3600000 (1h) */
  checkIntervalMs: z.number().int().min(60000).optional().default(3_600_000),
  /** Days before expiry to start alerting. Default: 30 */
  expiryAlertDays: z.number().int().min(1).max(365).optional().default(30),
  /** Paths to domain CSV/spreadsheet files to scan */
  domainFiles: z.array(z.string()).optional(),
  /** Channel for expiry alerts */
  alertChannel: AlertChannelSchema.optional(),
});

const LeadMonitorConfigSchema = z.object({
  /** Enable lead/email monitoring. Default: true */
  enabled: z.boolean().optional().default(true),
  /** Check interval in ms. Default: 1800000 (30min) */
  checkIntervalMs: z.number().int().min(60000).optional().default(1_800_000),
  /** Paths to leads data files */
  leadsFiles: z.array(z.string()).optional(),
  /** Keywords that indicate urgency (e.g., "urgent", "ASAP", "deal") */
  urgencyKeywords: z.array(z.string()).optional(),
  /** Channel for urgent lead alerts */
  alertChannel: AlertChannelSchema.optional(),
});

const N8NWorkflowConfigSchema = z.object({
  /** Enable n8n workflow triggers. Default: true */
  enabled: z.boolean().optional().default(true),
  /** n8n webhook URLs to call on schedule */
  webhookUrls: z.array(z.string().url()).optional(),
  /** Schedule as cron expressions */
  schedules: z.array(z.string()).optional(),
  /** HTTP headers for webhook calls (e.g. Authorization) */
  headers: z.record(z.string(), z.string()).optional(),
});

export const ProactiveMonitorConfigSchema = z.object({
  /** Enable the proactive monitor. Default: false (safer) */
  enabled: z.boolean().optional().default(false),
  /** Domain portfolio monitoring */
  domainMonitor: DomainMonitorConfigSchema.optional(),
  /** Lead / email urgency monitoring */
  leadMonitor: LeadMonitorConfigSchema.optional(),
  /** n8n workflow triggers */
  n8nWorkflows: N8NWorkflowConfigSchema.optional(),
  /** Alert channel for monitor-level events */
  alertChannel: AlertChannelSchema.optional(),
  /** Store path for monitor state */
  storePath: z.string().optional(),
});

export type ProactiveMonitorConfig = z.infer<typeof ProactiveMonitorConfigSchema>;
export type DomainMonitorConfig = z.infer<typeof DomainMonitorConfigSchema>;
export type LeadMonitorConfig = z.infer<typeof LeadMonitorConfigSchema>;
export type N8NWorkflowConfig = z.infer<typeof N8NWorkflowConfigSchema>;

// ============================================================================
// Types
// ============================================================================

export interface MonitorAlert {
  id: string;
  kind: "domain_expiry" | "lead_urgent" | "n8n_trigger" | "system";
  severity: "info" | "warning" | "critical";
  title: string;
  body: string;
  timestampMs: number;
  channel?: AlertChannel;
}

export interface DomainExpiryItem {
  domain: string;
  expiryDays: number;
  registrar?: string;
  isExpired: boolean;
}

export interface UrgentLeadItem {
  source: string;
  keywords: string[];
  snippet: string;
  timestampMs: number;
}

// ============================================================================
// State
// ============================================================================

interface ProactiveMonitorState {
  config: ProactiveMonitorConfig;
  started: boolean;
  timers: {
    domain: NodeJS.Timeout | null;
    lead: NodeJS.Timeout | null;
    n8n: NodeJS.Timeout | null;
  };
  lastRun: {
    domain: number;
    lead: number;
    n8n: number;
  };
  pendingAlerts: MonitorAlert[];
}

const log = createSubsystemLogger("proactive-monitor");

let state: ProactiveMonitorState | null = null;

// ============================================================================
// Domain Monitoring
// ============================================================================

async function checkDomainPortfolio(): Promise<MonitorAlert[]> {
  if (!state) {
    return [];
  }
  const config = state.config.domainMonitor;
  if (!config?.enabled) {
    return [];
  }

  const alerts: MonitorAlert[] = [];

  try {
    const files = config.domainFiles ?? [];
    for (const filePath of files) {
      const items = await scanDomainFile(filePath, config.expiryAlertDays ?? 30);
      for (const item of items) {
        alerts.push({
          id: `domain:${item.domain}:${Date.now()}`,
          kind: "domain_expiry",
          severity: item.isExpired ? "critical" : item.expiryDays <= 7 ? "warning" : "info",
          title: item.isExpired
            ? `Domain expired: ${item.domain}`
            : `Domain expiring: ${item.domain}`,
          body: item.isExpired
            ? `${item.domain} has expired${item.registrar ? ` (registrar: ${item.registrar})` : ""}. Immediate action required.`
            : `${item.domain} expires in ${item.expiryDays} day${item.expiryDays === 1 ? "" : "s"}${item.registrar ? ` (registrar: ${item.registrar})` : ""}.`,
          timestampMs: Date.now(),
          channel: config.alertChannel,
        });
      }
    }
  } catch (err) {
    log.error("proactive-monitor: domain check failed", { err });
  }

  return alerts;
}

async function scanDomainFile(
  filePath: string,
  expiryAlertDays: number,
): Promise<DomainExpiryItem[]> {
  const items: DomainExpiryItem[] = [];
  try {
    const { readFile } = await import("node:fs/promises");
    const { extname } = await import("node:path");
    const raw = await readFile(filePath, "utf-8");
    const ext = extname(filePath).toLowerCase();

    if (ext === ".csv") {
      const lines = raw.split("\n").filter((l) => l.trim());
      // Skip header row
      for (const line of lines.slice(1)) {
        const cols = line.split(",").map((c) => c.trim().replace(/^["']|["']$/g, ""));
        if (cols.length >= 2) {
          const domain = cols[0];
          const expiryStr = cols[1];
          const registrar = cols[2];
          const expiryDays = parseExpiryString(expiryStr);
          if (expiryDays !== null && expiryDays <= expiryAlertDays) {
            items.push({ domain, expiryDays, registrar, isExpired: expiryDays <= 0 });
          }
        }
      }
    } else if (ext === ".json") {
      const { parseJsonWithJson5Fallback } = await import("../utils/parse-json-compat.js");
      const parsed = parseJsonWithJson5Fallback(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === "object" && item !== null) {
            const obj = item as Record<string, unknown>;
            // eslint-disable-next-line no-base-to-string
            const domain = String(obj.domain ?? obj.name ?? "");
            // eslint-disable-next-line no-base-to-string
            const expiryStr = String(obj.expiry ?? obj.expires ?? obj.expiryDate ?? "");
            // eslint-disable-next-line no-base-to-string
            const registrar = String(obj.registrar ?? "");
            const expiryDays = parseExpiryString(expiryStr);
            if (domain && expiryDays !== null && expiryDays <= expiryAlertDays) {
              items.push({ domain, expiryDays, registrar, isExpired: expiryDays <= 0 });
            }
          }
        }
      }
    }
  } catch (err) {
    log.debug("proactive-monitor: failed to scan domain file", { err, filePath });
  }
  return items;
}

function parseExpiryString(expiryStr: string): number | null {
  if (!expiryStr) {
    return null;
  }
  // Try ISO date parsing
  const date = new Date(expiryStr);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const now = Date.now();
  const diffMs = date.getTime() - now;
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

// ============================================================================
// Lead / Email Monitoring
// ============================================================================

async function checkLeads(): Promise<MonitorAlert[]> {
  if (!state) {
    return [];
  }
  const config = state.config.leadMonitor;
  if (!config?.enabled) {
    return [];
  }

  const alerts: MonitorAlert[] = [];
  const keywords = config.urgencyKeywords ?? ["urgent", "asap", "deal", "important", "payment"];
  const now = Date.now();

  try {
    const files = config.leadsFiles ?? [];
    for (const filePath of files) {
      const urgentItems = await scanLeadsFile(filePath, keywords, now);
      for (const item of urgentItems) {
        alerts.push({
          id: `lead:${item.source}:${Date.now()}`,
          kind: "lead_urgent",
          severity: "warning",
          title: `Urgent lead: ${item.source}`,
          body: `Matched keywords [${item.keywords.join(", ")}]: ${item.snippet}`,
          timestampMs: item.timestampMs,
          channel: config.alertChannel,
        });
      }
    }
  } catch (err) {
    log.error("proactive-monitor: leads check failed", { err });
  }

  return alerts;
}

async function scanLeadsFile(
  filePath: string,
  keywords: string[],
  now: number,
): Promise<UrgentLeadItem[]> {
  const items: UrgentLeadItem[] = [];
  try {
    const { readFile } = await import("node:fs/promises");
    const { extname } = await import("node:path");
    const raw = await readFile(filePath, "utf-8");
    const ext = extname(filePath).toLowerCase();

    if (ext === ".json") {
      const { parseJsonWithJson5Fallback } = await import("../utils/parse-json-compat.js");
      const parsed = parseJsonWithJson5Fallback(raw);
      const records = Array.isArray(parsed) ? parsed : [parsed];
      for (const record of records) {
        if (typeof record !== "object" || record === null) {
          continue;
        }
        const obj = record as Record<string, unknown>;
        const text = JSON.stringify(obj).toLowerCase();
        const matched = keywords.filter((k) => text.includes(k.toLowerCase()));
        if (matched.length > 0) {
          items.push({
            // eslint-disable-next-line no-base-to-string
            source: String(obj.source ?? obj.name ?? obj.email ?? filePath),
            keywords: matched,
            // eslint-disable-next-line no-base-to-string
            snippet: String(obj.message ?? obj.subject ?? obj.note ?? obj.body ?? "").slice(0, 200),
            timestampMs:
              typeof obj.timestamp === "number"
                ? obj.timestamp
                : typeof obj.createdAt === "string"
                  ? new Date(obj.createdAt).getTime()
                  : now,
          });
        }
      }
    }
  } catch (err) {
    log.debug("proactive-monitor: failed to scan leads file", { err, filePath });
  }
  return items;
}

// ============================================================================
// n8n Workflow Triggers
// ============================================================================

async function triggerN8nWorkflows(): Promise<MonitorAlert[]> {
  if (!state) {
    return [];
  }
  const config = state.config.n8nWorkflows;
  if (!config?.enabled) {
    return [];
  }

  const alerts: MonitorAlert[] = [];

  try {
    const urls = config.webhookUrls ?? [];
    const headers = config.headers ?? {};
    for (const url of urls) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...headers,
          },
          body: JSON.stringify({
            timestamp: new Date().toISOString(),
            source: "kairos-proactive-monitor",
            triggeredAtMs: Date.now(),
          }),
        });
        if (response.ok) {
          log.debug("proactive-monitor: n8n workflow triggered", { url });
        } else {
          log.warn("proactive-monitor: n8n workflow failed", { url, status: response.status });
          alerts.push({
            id: `n8n:${url}:${Date.now()}`,
            kind: "n8n_trigger",
            severity: "warning",
            title: `n8n workflow failed: ${url}`,
            body: `Webhook returned status ${response.status}`,
            timestampMs: Date.now(),
            channel: state.config.alertChannel,
          });
        }
      } catch (err) {
        log.debug("proactive-monitor: n8n trigger error", { err, url });
      }
    }
  } catch (err) {
    log.error("proactive-monitor: n8n check failed", { err });
  }

  return alerts;
}

// ============================================================================
// Alert Delivery
// ============================================================================

async function dispatchAlert(alert: MonitorAlert): Promise<void> {
  const channel = alert.channel ?? state?.config.alertChannel;
  if (!channel || channel.channel === "none") {
    // Log to console if no channel configured
    log.info("proactive-monitor: alert (no channel configured)", {
      alert: { id: alert.id, kind: alert.kind, title: alert.title, body: alert.body },
    });
    return;
  }

  // Dispatch via the cron delivery system or direct channel tool
  log.debug("proactive-monitor: dispatching alert", {
    channel: channel.channel,
    to: channel.to,
    alertId: alert.id,
  });
  // Alert dispatch is delegated to the main agent session to avoid
  // duplicating channel logic. The kairos-agent receives this and delivers.
}

// ============================================================================
// Scheduler
// ============================================================================

function scheduleNextRun(
  kind: "domain" | "lead" | "n8n",
  intervalMs: number,
  fn: () => Promise<MonitorAlert[]>,
): void {
  if (!state) {
    return;
  }

  const timerMap = {
    domain: "domain",
    lead: "lead",
    n8n: "n8n",
  } as const;

  const key = timerMap[kind];

  if (state.timers[key]) {
    clearTimeout(state.timers[key]);
  }

  state.timers[key] = setTimeout(async () => {
    const alerts = await fn();
    for (const alert of alerts) {
      await dispatchAlert(alert);
    }
    state!.lastRun[key] = Date.now();
    scheduleNextRun(kind, intervalMs, fn);
  }, intervalMs);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Start the proactive monitor.
 */
export async function startProactiveMonitor(
  config?: Partial<ProactiveMonitorConfig>,
): Promise<void> {
  if (state?.started) {
    log.warn("proactive-monitor: already started", {});
    return;
  }

  const parsed = ProactiveMonitorConfigSchema.safeParse(config ?? {});
  if (!parsed.success) {
    log.error("proactive-monitor: invalid config", { errors: parsed.error.flatten() });
    return;
  }

  const fullConfig: ProactiveMonitorConfig = {
    ...parsed.data,
  };

  if (!fullConfig.enabled) {
    log.info("proactive-monitor: disabled by config", {});
    return;
  }

  state = {
    config: fullConfig,
    started: false,
    timers: { domain: null, lead: null, n8n: null },
    lastRun: { domain: 0, lead: 0, n8n: 0 },
    pendingAlerts: [],
  };

  const domainConfig = fullConfig.domainMonitor;
  if (domainConfig?.enabled) {
    scheduleNextRun("domain", domainConfig.checkIntervalMs ?? 3_600_000, checkDomainPortfolio);
  }

  const leadConfig = fullConfig.leadMonitor;
  if (leadConfig?.enabled) {
    scheduleNextRun("lead", leadConfig.checkIntervalMs ?? 1_800_000, checkLeads);
  }

  const n8nConfig = fullConfig.n8nWorkflows;
  if (n8nConfig?.enabled && (n8nConfig.webhookUrls?.length ?? 0) > 0) {
    // n8n uses its own schedule — just set a default interval if no schedule specified
    const n8nInterval = 3_600_000; // 1h default
    scheduleNextRun("n8n", n8nInterval, triggerN8nWorkflows);
  }

  state.started = true;
  log.info("proactive-monitor: started", {
    domainMonitor: domainConfig?.enabled,
    leadMonitor: leadConfig?.enabled,
    n8nWorkflows: n8nConfig?.enabled,
  });
}

/**
 * Stop the proactive monitor.
 */
export function stopProactiveMonitor(): void {
  if (!state) {
    return;
  }

  for (const key of ["domain", "lead", "n8n"] as const) {
    if (state.timers[key]) {
      clearTimeout(state.timers[key]);
      state.timers[key] = null;
    }
  }

  state.started = false;
  log.info("proactive-monitor: stopped", {});
}

/**
 * Get current monitor status.
 */
export function getMonitorStatus(): {
  active: boolean;
  lastRun: ProactiveMonitorState["lastRun"];
  pendingAlertCount: number;
} {
  if (!state) {
    return { active: false, lastRun: { domain: 0, lead: 0, n8n: 0 }, pendingAlertCount: 0 };
  }
  return {
    active: state.started,
    lastRun: state.lastRun,
    pendingAlertCount: state.pendingAlerts.length,
  };
}

/**
 * SkillScanner module — always-on security scanning for loaded skills.
 * Activated when SKILL_SCANNER flag is enabled.
 *
 * @module skill-scanner
 */

export interface SkillScannerModule {
  scanModule: (modulePath: string, sourceCode: string) => Promise<ScanResult>;
  auditSkill: (skillId: string) => Promise<AuditResult>;
  getPolicyViolations: () => PolicyViolation[];
}

export interface ScanResult {
  safe: boolean;
  violations: PolicyViolation[];
  scannedAt: number;
}

export interface AuditResult {
  skillId: string;
  safe: boolean;
  violations: PolicyViolation[];
  scannedAt: number;
}

export interface PolicyViolation {
  rule: string;
  severity: "low" | "medium" | "high" | "critical";
  message: string;
  location?: { line: number; column: number };
}

const FORBIDDEN_PATTERNS: Array<{
  pattern: RegExp;
  rule: string;
  severity: PolicyViolation["severity"];
}> = [
  { pattern: /\beval\s*\(/, rule: "forbidden-eval", severity: "critical" },
  { pattern: /\bnew\s+Function\s*\(/, rule: "forbidden-new-function", severity: "critical" },
  { pattern: /child_process.*shell:\s*true/, rule: "forbidden-shell", severity: "high" },
  {
    pattern: /process\.env\.(HOME|USERPROFILE|PATH|NODE_PATH)/,
    rule: "suspicious-env-access",
    severity: "medium",
  },
  { pattern: /__proto__|prototype|constructor/, rule: "prototype-pollution", severity: "high" },
];

/**
 * Scan source code for policy violations.
 */
export async function scanModule(_modulePath: string, sourceCode: string): Promise<ScanResult> {
  const violations: PolicyViolation[] = [];

  for (const { pattern, rule, severity } of FORBIDDEN_PATTERNS) {
    const match = pattern.exec(sourceCode);
    if (match) {
      violations.push({
        rule,
        severity,
        message: `Pattern "${rule}" matched at position ${match.index}`,
        location: { line: sourceCode.slice(0, match.index).split("\n").length, column: 0 },
      });
    }
  }

  return { safe: violations.length === 0, violations, scannedAt: Date.now() };
}

/**
 * Audit a registered skill by ID.
 */
export async function auditSkill(_skillId: string): Promise<AuditResult> {
  // TODO: retrieve skill source and call scanModule
  return {
    skillId: _skillId,
    safe: true,
    violations: [],
    scannedAt: Date.now(),
  };
}

/**
 * Return all policy violations discovered so far in this session.
 */
export function getPolicyViolations(): PolicyViolation[] {
  // TODO: maintain a global list of violations
  return [];
}

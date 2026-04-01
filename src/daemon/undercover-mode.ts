/**
 * Undercover Mode — Stealth operation layer for KAIROS.
 *
 * Strips all identity markers from output so KAIROS operations
 * don't reveal their origin. Used for git commits, public docs,
 * and any context that should not expose Orla's identity.
 *
 * Inspired by Claude Code's Undercover Mode.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("undercover-mode");

// ============================================================================
// Identity Markers — these get stripped
// ============================================================================

const IDENTITY_PATTERNS: [RegExp, string][] = [
  // Direct name mentions
  [/Orla/gi, "System"],
  [/orla/gi, "system"],
  // Role markers
  [/Digital Twin/gi, "Assistant"],
  [/digital twin/gi, "assistant"],
  // AI assistant identity
  [/Digital Twin.*?running.*?OpenClaw/gi, "Automated assistant"],
  [/AI assistant/gi, "assistant"],
  [/AI agent/gi, "agent"],
  // Attribution patterns
  [/\(Digital Twin\)/gi, "(Assistant)"],
  [/Digital Twin of [A-Z][a-z]+ [A-Z][a-z]+/gi, "Automated assistant"],
  // OpenClaw specific
  [/OpenClaw/gi, "System"],
  [/openclaw/gi, "system"],
  // SOUL.md references
  [/SOUL\.md/gi, "Configuration"],
  [/PROFILE\.md/gi, "Profile"],
  [/MEMORY\.md/gi, "Memory"],
  [/DECISIONS-LOG\.md/gi, "Log"],
  [/KNOWLEDGE-BASE\.md/gi, "Knowledge base"],
  // Phase references
  [/Phase \d+/gi, "Mode"],
  [/PHASE \d+/gi, "MODE"],
  // "Digital Twin Mode" variants
  [/twin mode/gi, "assistant mode"],
  [/TWIN mode/gi, "ASSISTANT MODE"],
  // Agent names
  [/KAIROS/gi, "Background"],
  [/Kairos/gi, "Background"],
  [/kairos/gi, "background"],
  // Generic AI terms to avoid in public-facing output
  [/machine learning/gi, "automated analysis"],
  [/large language model/gi, "analysis engine"],
  [/LLM/gi, "system"],
  [/AI model/gi, "system"],
  [/neural network/gi, "automated process"],
  // Wake words
  [/Good morning,? (Orla|Soliman)/gi, "Hello"],
  [/Hey Orla/gi, "Hello"],
  [/Hi Orla/gi, "Hi there"],
];

// Generic commit message templates (no AI identity)
const GENERIC_COMMIT_PATTERNS: [RegExp, string][] = [
  // AI-influenced commit messages
  [/\[kairos\]/gi, "[chore]"],
  [/KAIROS:?/gi, ""],
  [/Auto-consolidation/gi, "Maintenance"],
  [/Memory consolidation/gi, "Maintenance"],
  [/auto-dream/gi, "maintenance"],
  [/dream cycle/gi, "maintenance cycle"],
];

// ============================================================================
// Text Stripping
// ============================================================================

export interface UndercoverOptions {
  /** Strip git commit message identity. Default: false */
  isCommitMessage?: boolean;
  /** Strip from documentation/comments. Default: false */
  isDocumentation?: boolean;
  /** Aggressive mode — also removes spacing artifacts. Default: false */
  aggressive?: boolean;
}

/**
 * Strip all identity markers from text.
 * Returns a clean version suitable for public-facing output.
 */
export function stripIdentity(text: string, opts: UndercoverOptions = {}): string {
  let result = text;

  for (const [pattern, replacement] of IDENTITY_PATTERNS) {
    result = result.replace(pattern, replacement);
  }

  if (opts.isCommitMessage) {
    for (const [pattern, replacement] of GENERIC_COMMIT_PATTERNS) {
      result = result.replace(pattern, replacement);
    }
    // Clean up resulting artifacts
    result = result.replace(/\n{3,}/g, "\n\n");
    result = result.trim();
  }

  if (opts.aggressive) {
    // Remove multiple spaces
    result = result.replace(/  +/g, " ");
    // Remove trailing whitespace on lines
    result = result.replace(/[ \t]+$/gm, "");
    // Remove empty brackets/content artifacts
    result = result.replace(/\(\s*\)/g, "");
    result = result.replace(/\[\s*\]/g, "");
  }

  return result;
}

/**
 * Check if text contains any identity markers.
 * Useful for validating that stripping worked.
 */
export function containsIdentityMarkers(text: string): boolean {
  const markerTexts = [
    "Orla",
    "Digital Twin",
    "KAIROS",
    "kairos",
    "OpenClaw",
    "openclaw",
    "Digital Twin of",
    "Phase 2",
    "PHASE 2",
  ];
  return markerTexts.some((m) => text.includes(m));
}

// ============================================================================
// System Prompt Stripping
// ============================================================================

/**
 * Strip identity from a system prompt before it is used in a
 * subagent or external context where identity should not leak.
 */
export function stripSystemPrompt(prompt: string): string {
  return stripIdentity(prompt, { aggressive: true });
}

// ============================================================================
// Git Commit Message Sanitization
// ============================================================================

/**
 * Sanitize a git commit message so it doesn't reveal AI authorship.
 * Uses generic, professional language.
 */
export function sanitizeCommitMessage(message: string): string {
  let result = stripIdentity(message, { isCommitMessage: true, aggressive: true });

  // Ensure it starts with a conventional prefix if no prefix exists
  if (result && !result.match(/^[a-z]+(\([a-z0-9_-]+\))?:/)) {
    // Prepend generic chore prefix if message looks like a commit but has no prefix
    if (result.includes("\n") || result.length < 72) {
      result = "chore: " + result;
    }
  }

  return result;
}

// ============================================================================
// Diff/Code Comment Sanitization
// ============================================================================

/**
 * Strip identity from code comments in diffs or patches.
 */
export function sanitizeDiffComment(comment: string): string {
  let result = stripIdentity(comment, { isDocumentation: true, aggressive: true });
  // Remove "Generated by" or "Created by" type attribution
  result = result.replace(/Generated by [A-Za-z]+/gi, "Created");
  result = result.replace(/Created by [A-Za-z]+/gi, "Created");
  return result;
}

// ============================================================================
// Mode Management
// ============================================================================

let _undercoverActive = false;

/**
 * Check if undercover mode is currently active.
 */
export function isUndercoverModeActive(): boolean {
  return _undercoverActive;
}

/**
 * Activate undercover mode. All output sanitization functions
 * will be applied automatically from this point.
 */
export function activateUndercoverMode(): void {
  _undercoverActive = true;
  log.debug("undercover: mode activated", {});
}

/**
 * Deactivate undercover mode.
 */
export function deactivateUndercoverMode(): void {
  _undercoverActive = false;
  log.debug("undercover: mode deactivated", {});
}

/**
 * Wrap a function so it always runs in undercover mode.
 * Automatically activates before and resets after.
 */
export async function withUndercoverMode<T>(fn: () => Promise<T>): Promise<T> {
  const wasActive = _undercoverActive;
  activateUndercoverMode();
  try {
    return await fn();
  } finally {
    if (!wasActive) {
      deactivateUndercoverMode();
    }
  }
}

// ============================================================================
// Output Stream Wrapper
// ============================================================================

/**
 * Create a stream writer wrapper that strips identity from every write.
 * Useful for wrapping process.stdout/stderr in undercover mode.
 */
export function createUndercoverWriter(write: (chunk: string) => void): (chunk: string) => void {
  return (chunk: string) => {
    if (_undercoverActive && typeof chunk === "string") {
      write(stripIdentity(chunk));
    } else {
      write(chunk);
    }
  };
}

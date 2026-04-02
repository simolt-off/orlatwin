/**
 * Upstream Watcher — monitors upstream sources (GitHub, docs) for updates.
 *
 * Monitors:
 * - GitHub repositories for new commits/PRs
 * - Documentation sites for updates
 * - Package registries for new versions
 *
 * Triggers:
 * - New commits (configurable branches)
 * - New releases
 * - Breaking changes
 * - Security advisories
 *
 * @module upstream-watcher
 */

// import { z } from "zod";

// ---------------------------------------------------------------------------
// Upstream Source Types
// ---------------------------------------------------------------------------

export interface GitHubRepo {
  type: "github";
  owner: string;
  repo: string;
  branches: string[];
  pollIntervalMinutes: number;
  includePRs: boolean;
  includeCommits: boolean;
}

export interface DocSite {
  type: "docsite";
  url: string;
  pollIntervalMinutes: number;
  selectors?: string[];
}

export interface PackageRegistry {
  type: "package";
  registry: "npm" | "pypi" | "cargo" | "gem";
  packageNames: string[];
  pollIntervalMinutes: number;
}

export type UpstreamSource = GitHubRepo | DocSite | PackageRegistry;

// ---------------------------------------------------------------------------
// Update Events
// ---------------------------------------------------------------------------

export interface GitHubCommit {
  type: "commit";
  sourceId: string;
  owner: string;
  repo: string;
  sha: string;
  message: string;
  author: {
    name: string;
    email: string;
  };
  committedAt: number;
}

export interface GitHubPR {
  type: "pr";
  sourceId: string;
  owner: string;
  repo: string;
  prNumber: number;
  title: string;
  author: {
    name: string;
    login: string;
  };
  state: "open" | "closed" | "merged";
  createdAt: number;
  mergedAt?: number;
}

export interface Release {
  type: "release";
  sourceId: string;
  name: string;
  version: string;
  publishedAt: number;
  changelog?: string;
}

export type UpdateEvent = GitHubCommit | GitHubPR | Release;

// ---------------------------------------------------------------------------
// Upstream Watcher
// ---------------------------------------------------------------------------

interface WatcherEntry {
  source: UpstreamSource;
  lastChecked: number;
  lastCommitSha?: string;
  lastPrNumber?: number;
  lastVersion?: string;
  error?: string;
}

export class UpstreamWatcher {
  private sources: Map<string, WatcherEntry> = new Map();
  private watchers: Map<string, NodeJS.Timeout> = new Map();
  private running = false;

  /**
   * Register an upstream source to watch.
   */
  register(source: UpstreamSource): void {
    const sourceId = this.sourceId(source);
    this.sources.set(sourceId, {
      source,
      lastChecked: Date.now(),
    });
    console.debug(`[UpstreamWatcher] Registered: ${sourceId}`);
  }

  /**
   * Unregister an upstream source.
   */
  unregister(source: UpstreamSource): void {
    const sourceId = this.sourceId(source);
    this.stopWatcher(sourceId);
    this.sources.delete(sourceId);
    console.debug(`[UpstreamWatcher] Unregistered: ${sourceId}`);
  }

  /**
   * Start all watchers.
   */
  start(): void {
    if (this.running) {
      console.warn("[UpstreamWatcher] Already running");
      return;
    }

    this.running = true;
    console.debug(`[UpstreamWatcher] Starting (${this.sources.size} sources)`);

    for (const [sourceId] of this.sources.entries()) {
      this.startWatcher(sourceId);
    }
  }

  /**
   * Stop all watchers.
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    this.running = false;
    for (const [sourceId] of this.watchers.entries()) {
      clearInterval(sourceId);
    }
    this.watchers.clear();
    console.debug("[UpstreamWatcher] Stopped");
  }

  /**
   * Get registered sources.
   */
  getSources(): UpstreamSource[] {
    return Array.from(this.sources.values()).map((entry) => entry.source);
  }

  /**
   * Get source status.
   */
  getStatus(sourceId: string): WatcherEntry | undefined {
    return this.sources.get(sourceId);
  }

  /**
   * Check a specific source immediately.
   */
  async checkSource(sourceId: string): Promise<UpdateEvent[]> {
    const entry = this.sources.get(sourceId);
    if (!entry) {
      return [];
    }

    entry.lastChecked = Date.now();
    let events: UpdateEvent[] = [];

    try {
      switch (entry.source.type) {
        case "github":
          events = await this.checkGitHub(entry.source, entry);
          break;
        case "docsite":
          events = await this.checkDocSite(entry.source, entry);
          break;
        case "package":
          events = await this.checkPackage(entry.source, entry);
          break;
      }
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
      console.error(`[UpstreamWatcher] Error checking ${sourceId}:`, err);
    }

    return events;
  }

  /**
   * Check GitHub repository.
   */
  private async checkGitHub(source: GitHubRepo, entry: WatcherEntry): Promise<UpdateEvent[]> {
    const events: UpdateEvent[] = [];

    try {
      // Check commits
      if (source.includeCommits) {
        const commits = await this.fetchGitHubCommits(source, entry.lastCommitSha);
        for (const commit of commits) {
          events.push(commit);
          entry.lastCommitSha = commit.sha;
        }
      }

      // Check PRs
      if (source.includePRs) {
        const prs = await this.fetchGitHubPRs(source, entry.lastPrNumber);
        for (const pr of prs) {
          events.push(pr);
          entry.lastPrNumber = pr.prNumber;
        }
      }
    } catch (err) {
      console.error(
        `[UpstreamWatcher] GitHub check failed for ${source.owner}/${source.repo}:`,
        err,
      );
    }

    return events;
  }

  /**
   * Fetch GitHub commits.
   */
  private async fetchGitHubCommits(
    _source: GitHubRepo,
    _sinceSha?: string,
  ): Promise<GitHubCommit[]> {
    // TODO: Implement actual GitHub API call
    // const response = await fetch(`https://api.github.com/repos/${source.owner}/${source.repo}/commits?sha=${sinceSha || ''}`);
    // const data = await response.json();
    // return data.map((commit: any) => ({
    //   type: 'commit' as const,
    //   sourceId: this.sourceId(source),
    //   owner: source.owner,
    //   repo: source.repo,
    //   sha: commit.sha,
    //   message: commit.commit.message,
    //   author: commit.author,
    //   committedAt: Date.parse(commit.commit.author.date),
    // }));

    console.warn("[UpstreamWatcher] GitHub commit fetching not implemented (needs GitHub token)");
    return [];
  }

  /**
   * Fetch GitHub PRs.
   */
  private async fetchGitHubPRs(_source: GitHubRepo, _sincePrNumber?: number): Promise<GitHubPR[]> {
    // TODO: Implement actual GitHub API call
    console.warn("[UpstreamWatcher] GitHub PR fetching not implemented (needs GitHub token)");
    return [];
  }

  /**
   * Check documentation site.
   */
  private async checkDocSite(_source: DocSite, _entry: WatcherEntry): Promise<UpdateEvent[]> {
    // TODO: Implement actual doc site checking (HTML scraping, diffing, etc.)
    console.warn("[UpstreamWatcher] Doc site checking not implemented");
    return [];
  }

  /**
   * Check package registry.
   */
  private async checkPackage(_source: PackageRegistry, _entry: WatcherEntry): Promise<Release[]> {
    // TODO: Implement actual package registry checking
    console.warn("[UpstreamWatcher] Package registry checking not implemented");
    return [];
  }

  /**
   * Start watcher for a specific source.
   */
  private startWatcher(sourceId: string): void {
    if (this.watchers.has(sourceId)) {
      return;
    }

    const entry = this.sources.get(sourceId);
    if (!entry) {
      return;
    }

    const interval = entry.source.pollIntervalMinutes * 60 * 1000;
    const watcher = setInterval(() => {
      void this.checkSource(sourceId);
    }, interval);

    this.watchers.set(sourceId, watcher);
    console.debug(
      `[UpstreamWatcher] Started watcher for ${sourceId} (${entry.source.pollIntervalMinutes}min)`,
    );
  }

  /**
   * Stop watcher for a specific source.
   */
  private stopWatcher(sourceId: string): void {
    const watcher = this.watchers.get(sourceId);
    if (watcher) {
      clearInterval(watcher);
      this.watchers.delete(sourceId);
      console.debug(`[UpstreamWatcher] Stopped watcher for ${sourceId}`);
    }
  }

  /**
   * Generate source ID.
   */
  private sourceId(source: UpstreamSource): string {
    switch (source.type) {
      case "github":
        return `github:${source.owner}/${source.repo}`;
      case "docsite":
        return `docsite:${source.url}`;
      case "package":
        return `package:${source.registry}:${source.packageNames.join(",")}`;
    }
  }

  /**
   * Get running state.
   */
  isRunning(): boolean {
    return this.running;
  }
}

// ---------------------------------------------------------------------------
// Singleton Instance
// ---------------------------------------------------------------------------

let watcherInstance: UpstreamWatcher | null = null;

export function getUpstreamWatcher(): UpstreamWatcher {
  if (!watcherInstance) {
    watcherInstance = new UpstreamWatcher();
  }
  return watcherInstance;
}

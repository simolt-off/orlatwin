/**
 * Agency Teams Module — Multi-agent team coordination
 *
 * Enables spawning multiple named agents as a coordinated team:
 * - Shared team memory context
 * - Role assignments (researcher, reviewer, executor)
 * - Intra-team structured messaging
 * - Result aggregation
 * - Lifecycle management
 *
 * Inspired by: github.com/777genius/claude_agent_teams_ui
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Team Types
// ---------------------------------------------------------------------------

export const AgentRoleSchema = z.enum([
  "coordinator",
  "researcher",
  "reviewer",
  "executor",
  "reporter",
  "analyst",
  "strategist",
  "developer",
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const TeamMemberSchema = z.object({
  id: z.string(),
  role: AgentRoleSchema,
  name: z.string(),
  status: z.enum(["idle", "busy", "done", "error", "waiting"]),
  currentTask: z.string().optional(),
  result: z.string().optional(),
  error: z.string().optional(),
});

export const TeamSchema = z.object({
  id: z.string(),
  name: z.string(),
  members: z.array(TeamMemberSchema),
  sharedMemory: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.number(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  status: z.enum(["idle", "active", "completed", "failed"]),
});

export type Team = z.infer<typeof TeamSchema>;
export type TeamMember = z.infer<typeof TeamMemberSchema>;

// ---------------------------------------------------------------------------
// Message Types
// ---------------------------------------------------------------------------

export const TeamMessageSchema = z.object({
  type: z.enum(["task", "result", "broadcast", "request", "error", "status"]),
  senderId: z.string(),
  senderRole: AgentRoleSchema,
  timestamp: z.number(),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type TeamMessage = z.infer<typeof TeamMessageSchema>;

// ---------------------------------------------------------------------------
// Result Types
// ---------------------------------------------------------------------------

export const TeamResultSchema = z.object({
  teamId: z.string(),
  teamName: z.string(),
  completedAt: z.number(),
  memberResults: z.record(z.string(), z.unknown()),
  summary: z.string().optional(),
  qualityScore: z.number().optional(), // 0-1
});

export type TeamResult = z.infer<typeof TeamResultSchema>;

// ---------------------------------------------------------------------------
// Agency Teams Engine
// ---------------------------------------------------------------------------

let _activeTeams: Map<string, Team> = new Map();

export class AgencyTeams {
  private teams: Map<string, Team> = new Map();

  /**
   * Create a new team.
   */
  async createTeam(
    name: string,
    memberDefs: Array<{ role: AgentRole; name: string }>,
  ): Promise<Team> {
    const team: Team = {
      id: crypto.randomUUID(),
      name,
      members: memberDefs.map((def) => ({
        id: crypto.randomUUID(),
        role: def.role,
        name: def.name,
        status: "idle" as const,
      })),
      createdAt: Date.now(),
      status: "idle",
    };

    this.teams.set(team.id, team);
    console.debug("[AgencyTeams] Created team:", team.name, team.members.length, "members");
    return team;
  }

  /**
   * Start a team and spawn all agents.
   */
  async startTeam(teamId: string): Promise<Team> {
    const team = this.teams.get(teamId);
    if (!team) {
      throw new Error(`Team ${teamId} not found`);
    }

    if (team.status === "active") {
      console.warn("[AgencyTeams] Team already active");
      return team;
    }

    team.status = "active";
    team.startedAt = Date.now();

    console.debug("[AgencyTeams] Starting team:", team.name);

    // Spawn agents (would integrate with OpenClaw's agent spawning API)
    await this.spawnTeamAgents(team);

    return team;
  }

  /**
   * Spawn agents for all team members.
   */
  private async spawnTeamAgents(team: Team): Promise<void> {
    for (const member of team.members) {
      if (member.status === "busy") {
        continue;
      }

      member.status = "busy";
      member.currentTask = "Initializing agent...";

      // TODO: Integrate with OpenClaw's subagent spawning API
      // This would look something like:
      // const subagent = await spawnSubagent({
      //   label: `${team.name}-${member.role}-${member.id}`,
      //   task: `You are ${member.role} in team ${team.name}. ${getRolePrompt(member.role)}`,
      //   sharedMemory: team.sharedMemory,
      // });

      console.debug(`[AgencyTeams] Spawned agent:`, member.name, `(${member.role})`);
    }
  }

  /**
   * Send a message to a specific team member.
   */
  async sendToAgent(
    teamId: string,
    memberId: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const team = this.teams.get(teamId);
    if (!team) {
      throw new Error(`Team ${teamId} not found`);
    }

    const member = team.members.find((m) => m.id === memberId);
    if (!member) {
      throw new Error(`Member ${memberId} not found in team ${teamId}`);
    }

    if (member.status === "idle" || member.status === "done") {
      member.status = "busy";
      member.currentTask = message;
    }

    // TODO: Send actual message to agent
    // This would integrate with OpenClaw's messaging system
    console.debug(`[AgencyTeams] Message to ${member.name} (${member.role}):`, message);

    // Store in shared memory
    if (!team.sharedMemory) {
      team.sharedMemory = {};
    }
    team.sharedMemory[`message_to_${memberId}`] = {
      content: message,
      timestamp: Date.now(),
      metadata,
    };
  }

  /**
   * Broadcast a message to all team members.
   */
  async broadcastToTeam(
    teamId: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const team = this.teams.get(teamId);
    if (!team) {
      throw new Error(`Team ${teamId} not found`);
    }

    console.debug(`[AgencyTeams] Broadcast to team ${team.name}:`, message);

    for (const member of team.members) {
      if (member.status === "idle" || member.status === "done") {
        member.status = "busy";
        member.currentTask = message;
      }

      // TODO: Send actual message to agent
      console.debug(`[AgencyTeams] Broadcast to ${member.name}:`, message);
    }

    // Store broadcast in shared memory
    if (!team.sharedMemory) {
      team.sharedMemory = {};
    }
    team.sharedMemory[`broadcast_to_${teamId}`] = {
      content: message,
      timestamp: Date.now(),
      metadata,
    };
  }

  /**
   * Receive a result from a team member.
   */
  async receiveResult(teamId: string, memberId: string, result: string): Promise<void> {
    const team = this.teams.get(teamId);
    if (!team) {
      throw new Error(`Team ${teamId} not found`);
    }

    const member = team.members.find((m) => m.id === memberId);
    if (!member) {
      throw new Error(`Member ${memberId} not found in team ${teamId}`);
    }

    member.status = "done";
    member.result = result;
    member.currentTask = undefined;

    // Store result in shared memory
    if (!team.sharedMemory) {
      team.sharedMemory = {};
    }
    team.sharedMemory[`result_${memberId}`] = {
      content: result,
      timestamp: Date.now(),
    };

    console.debug(`[AgencyTeams] Result from ${member.name}:`, result.slice(0, 100), "...");

    // Check if all members are done
    const allDone = team.members.every((m) => m.status === "done");
    if (allDone) {
      await this.completeTeam(teamId);
    }
  }

  /**
   * Receive an error from a team member.
   */
  async receiveError(teamId: string, memberId: string, error: string): Promise<void> {
    const team = this.teams.get(teamId);
    if (!team) {
      throw new Error(`Team ${teamId} not found`);
    }

    const member = team.members.find((m) => m.id === memberId);
    if (!member) {
      throw new Error(`Member ${memberId} not found in team ${teamId}`);
    }

    member.status = "error";
    member.error = error;
    member.currentTask = undefined;

    console.error(`[AgencyTeams] Error from ${member.name}:`, error);

    // Store error in shared memory
    if (!team.sharedMemory) {
      team.sharedMemory = {};
    }
    team.sharedMemory[`error_${memberId}`] = {
      content: error,
      timestamp: Date.now(),
    };
  }

  /**
   * Complete a team when all members are done.
   */
  private async completeTeam(teamId: string): Promise<void> {
    const team = this.teams.get(teamId);
    if (!team) {
      return;
    }

    team.status = "completed";
    team.completedAt = Date.now();

    // Generate summary
    const summary = this.generateTeamSummary(team);

    console.debug("[AgencyTeams] Team completed:", team.name);
    console.debug("[AgencyTeams] Summary:", summary);

    // TODO: Return result to caller
    // This would integrate with OpenClaw's result handling
  }

  /**
   * Generate a summary of team results.
   */
  private generateTeamSummary(team: Team): string {
    const results: Record<string, string> = {};

    for (const member of team.members) {
      if (member.result) {
        results[member.name] = member.result;
      }
    }

    return JSON.stringify(results, null, 2);
  }

  /**
   * Get a team by ID.
   */
  getTeam(teamId: string): Team | undefined {
    return this.teams.get(teamId);
  }

  /**
   * Get all active teams.
   */
  getAllTeams(): Team[] {
    return Array.from(this.teams.values());
  }

  /**
   * Get teams by status.
   */
  getTeamsByStatus(status: Team["status"]): Team[] {
    return this.getAllTeams().filter((t) => t.status === status);
  }

  /**
   * Get team members.
   */
  getTeamMembers(teamId: string): TeamMember[] | undefined {
    const team = this.teams.get(teamId);
    return team?.members;
  }

  /**
   * Get team member by ID.
   */
  getTeamMember(teamId: string, memberId: string): TeamMember | undefined {
    const team = this.teams.get(teamId);
    return team?.members.find((m) => m.id === memberId);
  }

  /**
   * Get team member status.
   */
  getTeamMemberStatus(teamId: string, memberId: string): TeamMember["status"] | null {
    const member = this.getTeamMember(teamId, memberId);
    return member?.status ?? null;
  }

  /**
   * Update team member status.
   */
  updateTeamMemberStatus(
    teamId: string,
    memberId: string,
    status: TeamMember["status"],
    currentTask?: string,
  ): boolean {
    const member = this.getTeamMember(teamId, memberId);
    if (!member) {
      return false;
    }

    member.status = status;
    if (currentTask) {
      member.currentTask = currentTask;
    }

    return true;
  }

  /**
   * Get shared memory for a team.
   */
  getTeamSharedMemory(teamId: string): Record<string, unknown> | undefined {
    const team = this.teams.get(teamId);
    return team?.sharedMemory;
  }

  /**
   * Update shared memory for a team.
   */
  updateTeamSharedMemory(teamId: string, key: string, value: unknown): boolean {
    const team = this.teams.get(teamId);
    if (!team || !team.sharedMemory) {
      return false;
    }

    team.sharedMemory[key] = value;
    return true;
  }

  /**
   * Delete a team.
   */
  async deleteTeam(teamId: string): Promise<boolean> {
    const team = this.teams.get(teamId);
    if (!team) {
      return false;
    }

    // Stop all agents (would integrate with OpenClaw)
    for (const member of team.members) {
      if (member.status === "busy") {
        // TODO: Stop agent
      }
    }

    this.teams.delete(teamId);
    console.debug("[AgencyTeams] Deleted team:", team.name);
    return true;
  }

  /**
   * Get team statistics.
   */
  getTeamStatistics(): {
    totalTeams: number;
    activeTeams: number;
    completedTeams: number;
    totalMembers: number;
    activeMembers: number;
  } {
    const teams = this.getAllTeams();

    return {
      totalTeams: teams.length,
      activeTeams: teams.filter((t) => t.status === "active").length,
      completedTeams: teams.filter((t) => t.status === "completed").length,
      totalMembers: teams.reduce((acc, t) => acc + t.members.length, 0),
      activeMembers: teams.reduce(
        (acc, t) => acc + t.members.filter((m) => m.status === "busy").length,
        0,
      ),
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton Instance
// ---------------------------------------------------------------------------

let agencyTeamsInstance: AgencyTeams | null = null;

export function getAgencyTeams(): AgencyTeams {
  if (!agencyTeamsInstance) {
    agencyTeamsInstance = new AgencyTeams();
  }
  return agencyTeamsInstance;
}

// ---------------------------------------------------------------------------
// Legacy Functions (for backward compatibility)
// ---------------------------------------------------------------------------

let activeTeam: Team | null = null;

export async function createTeamLegacy(
  name: string,
  memberDefs: Array<{ role: AgentRole; name: string }>,
): Promise<Team> {
  const agencyTeams = getAgencyTeams();
  return agencyTeams.createTeam(name, memberDefs);
}

export async function spawnTeamAgentsLegacy(team: Team): Promise<void> {
  const agencyTeams = getAgencyTeams();
  await agencyTeams.startTeam(team.id);
}

export async function sendToAgentLegacy(agentId: string, message: string): Promise<void> {
  // TODO: Need teamId - this is a limitation of the legacy API
  console.debug("[AgencyTeams] Legacy sendToAgent:", agentId, ":", message);
}

export async function broadcastToTeamLegacy(message: string): Promise<void> {
  // TODO: Need teamId - this is a limitation of the legacy API
  console.debug("[AgencyTeams] Legacy broadcastToTeam:", message);
}

export function getActiveTeamLegacy(): Team | null {
  return activeTeam;
}

export function getTeamMemberStatusLegacy(memberId: string): TeamMember["status"] | null {
  if (!activeTeam) {
    return null;
  }
  const member = activeTeam.members.find((m) => m.id === memberId);
  return member?.status ?? null;
}

/**
 * Agency Teams Module — Multi-agent team coordination
 *
 * Enables spawning multiple named agents as a coordinated team:
 * - Shared team memory context
 * - Role assignments (researcher, reviewer, executor)
 * - Intra-team structured messaging
 * - Result aggregation
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
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const TeamMemberSchema = z.object({
  id: z.string(),
  role: AgentRoleSchema,
  name: z.string(),
  status: z.enum(["idle", "busy", "done", "error"]),
  currentTask: z.string().optional(),
});

export const TeamSchema = z.object({
  id: z.string(),
  name: z.string(),
  members: z.array(TeamMemberSchema),
  sharedMemory: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.number(),
});

export type Team = z.infer<typeof TeamSchema>;
export type TeamMember = z.infer<typeof TeamMemberSchema>;

// ---------------------------------------------------------------------------
// Agency Teams Engine
// ---------------------------------------------------------------------------

let activeTeam: Team | null = null;

export async function createTeam(
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
  };
  activeTeam = team;
  console.debug("[AgencyTeams] Created team:", team.name, team.members.length, "members");
  return team;
}

export async function spawnTeamAgents(team: Team): Promise<void> {
  // In production: would use OpenClaw's agent spawning API
  // For each member, spawn a subagent with their role prompt
  console.debug("[AgencyTeams] Spawning agents for team:", team.name);
}

export async function sendToAgent(agentId: string, message: string): Promise<void> {
  // Would send structured message to specific team member
  console.debug("[AgencyTeams] Message to", agentId, ":", message);
}

export async function broadcastToTeam(message: string): Promise<void> {
  // Would broadcast to all team members
  console.debug("[AgencyTeams] Broadcast:", message);
}

export function getActiveTeam(): Team | null {
  return activeTeam;
}

export function getTeamMemberStatus(memberId: string): TeamMember["status"] | null {
  if (!activeTeam) {
    return null;
  }
  const member = activeTeam.members.find((m) => m.id === memberId);
  return member?.status ?? null;
}

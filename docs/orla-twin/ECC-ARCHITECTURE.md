# OrlaTwin Architecture — Inspired by everything-claude-code

## Source
- ECC: https://github.com/affaan-m/everything-claude-code (50K+ stars)
- Adapted for OrlaTwin's Digital Twin mission

---

## Key Patterns from ECC

### 1. Continuous Learning (Session End)

ECC runs pattern extraction at **Stop hook**:

```
Session End → evaluate-session.sh → learned_skills/
```

**OrlaTwin adaptation:**
```
Session End → KairosAgent.runDreamCycle() → memory/consolidated/
```

### 2. Confidence Scoring

ECC instincts have confidence scores (0.3-0.9):

```json
{
  "confidence": 0.7,
  "domain": "domain-investing",
  "pattern": " outreach timing"
}
```

**OrlaTwin:** Add confidence to memory entries.

### 3. Hook System

| Hook | ECC Purpose | OrlaTwin Purpose |
|------|-------------|------------------|
| PreToolUse | Security checks | Pre-execution guard |
| PostToolUse | Observation | Pattern capture |
| Stop | Extract patterns | Memory consolidate |

### 4. Skill Extraction Types

ECC detects:
- `error_resolution` — How errors were fixed
- `user_corrections` — User feedback patterns
- `workarounds` — Framework quirks
- `debugging_techniques` — Effective debugging
- `project_specific` — Project conventions

**OrlaTwin:** Same types + domain-investing specific.

---

## Implementation Plan

### Phase 1: Integrate KairosAgent
- [x] KairosAgent exists in OpenClaw
- [ ] Configure Stop hook to trigger dream cycle
- [ ] Memory index updates automatically

### Phase 2: Add Confidence Scoring
- [ ] Score memory entries 0-1
- [ ] Decay old patterns
- [ ] Cluster related instincts

### Phase 3: Multi-Agent Coordination
- [ ] ForkedSubagentHandle for background tasks
- [ ] ProactiveAgent for autonomous GREEN actions
- [ ] OrlaTwin = Coordinator + Specialists

---

## Key Files Referenced

- `src/agents/proactive-agent.ts` — Tier-based action control
- `src/agents/kairos-agent.ts` — Memory consolidation
- `src/agents/forked-subagent.ts` — Background isolation
- `src/orla-proactive/checkpoint.ts` — State persistence

---

## ECC Resources

- Continuous Learning: `skills/continuous-learning/SKILL.md`
- Hooks: `hooks/hooks.json`
- Agents: `agents/*.md`

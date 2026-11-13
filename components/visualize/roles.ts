/** What kind of agent a robot is; picks its silhouette (head, antenna, accessory). */
export type AgentRole =
  | "lead"
  | "worker"
  | "scout"
  | "reviewer"
  | "guard"
  | "sprinter"
  | "oracle"
  | "planner"
  | "designer"
  | "helper";

const EXACT: Record<string, AgentRole> = {
  task: "worker",
  scout: "scout",
  explore: "scout",
  reviewer: "reviewer",
  "security-reviewer": "guard",
  sonic: "sprinter",
  seance: "oracle",
  plan: "planner",
  planner: "planner",
  designer: "designer",
};

/** Subagent definition name (SubagentSnapshot.agent) → role. Exact names first, then substrings; unknown → "helper". */
export function roleOf(agentName: string | undefined): AgentRole {
  const name = agentName?.trim().toLowerCase();
  if (!name) return "helper";
  const exact = EXACT[name];
  if (exact) return exact;
  if (name.includes("security")) return "guard";
  if (name.includes("review")) return "reviewer";
  if (name.includes("scout") || name.includes("explore")) return "scout";
  if (name.includes("plan")) return "planner";
  if (name.includes("design")) return "designer";
  if (name.includes("sonic") || name.includes("fast")) return "sprinter";
  if (name.includes("seance")) return "oracle";
  if (name.includes("task")) return "worker";
  return "helper";
}

/** Human name and one-line job description per role. Card agents are always "lead". */
export const ROLE_INFO: Record<AgentRole, { label: string; description: string }> = {
  lead: { label: "Lead", description: "Card agent: owns the card, plans and delegates" },
  worker: { label: "Builder", description: "Task agent: reads, edits and runs code" },
  scout: { label: "Scout", description: "Read-only explorer: maps the code and reports back" },
  reviewer: { label: "Reviewer", description: "Reviews changes for bugs and quality" },
  guard: { label: "Security", description: "Hunts for security holes" },
  sprinter: { label: "Sprinter", description: "Fast agent for quick mechanical edits" },
  oracle: { label: "Medium", description: "Reads past sessions to answer questions" },
  planner: { label: "Planner", description: "Breaks the work into a plan" },
  designer: { label: "Designer", description: "Shapes the interface and visuals" },
  helper: { label: "Helper", description: "Specialist helper for anything else" },
};

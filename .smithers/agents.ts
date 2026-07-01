// smithers-source: generated
import { type AgentLike, ClaudeCodeAgent as SmithersClaudeCodeAgent } from "smithers-orchestrator";
import { ClaudeCodeAgent } from "./agents/claude-code";

export { ClaudeCodeAgent } from "./agents/claude-code";

export const providers = {
  claude: ClaudeCodeAgent,
  claudeOpus: new SmithersClaudeCodeAgent({ model: "claude-opus-4-8", cwd: process.cwd() }),
  claudeSonnet: new SmithersClaudeCodeAgent({ model: "claude-sonnet-4-6", cwd: process.cwd() }),
} as const;

export const agents = {
  cheapFast: [providers.claudeSonnet],
  smart: [providers.claude, providers.claudeOpus],
  smartTool: [providers.claude, providers.claudeOpus],
} as const satisfies Record<string, AgentLike[]>;

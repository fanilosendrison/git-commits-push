export type ExecutionAgentName =
	| "antigravity"
	| "pi"
	| "codex"
	| "claude"
	| "test"
	| "cli";

export interface ExecutionIdentity {
	readonly agentName: ExecutionAgentName;
	readonly callerName: string;
	readonly sessionId?: string;
}

/** Resolve the active harness identity from one process environment. */
export function resolveExecutionIdentity(
	environment: NodeJS.ProcessEnv = process.env,
): ExecutionIdentity {
	if (environment.ANTIGRAVITY_AGENT === "1") {
		return {
			agentName: "antigravity",
			callerName: "Antigravity Agent",
			...(environment.ANTIGRAVITY_TRAJECTORY_ID
				? { sessionId: environment.ANTIGRAVITY_TRAJECTORY_ID }
				: {}),
		};
	}
	if (environment.PI_AGENT === "1" || environment.PI_SESSION_ID) {
		return {
			agentName: "pi",
			callerName: "Pi Agent",
			...(environment.PI_SESSION_ID
				? { sessionId: environment.PI_SESSION_ID }
				: {}),
		};
	}
	if (environment.CODEX_THREAD_ID) {
		return {
			agentName: "codex",
			callerName: "Codex",
			sessionId: environment.CODEX_THREAD_ID,
		};
	}
	if (environment.CLAUDE_CODE === "1") {
		return { agentName: "claude", callerName: "Claude Code" };
	}
	if (
		environment.NODE_ENV === "test" ||
		environment.PI_SKILL_STATS_MODE === "test"
	) {
		return { agentName: "test", callerName: "Test" };
	}
	return {
		agentName: "cli",
		callerName: environment.USER || "CLI/User",
	};
}

import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { createEventSink } from "@fanilosendrison/event-sink";
import { resolveExecutionIdentity } from "../core/execution-identity.ts";
import {
	LEGACY_QUEUED_REQUEST_ENV_KEY,
	REQUEST_ENV_KEYS,
} from "../orders/types.ts";

export function getAgentName(): string {
	return resolveExecutionIdentity().agentName;
}

export function getActiveSessionId(): string | undefined {
	return resolveExecutionIdentity().sessionId;
}

let sink: ReturnType<typeof createEventSink> | null = null;
let lastSinkKey: string | undefined;

function getStatsDir(): string {
	return (
		process.env.PI_SKILL_STATS_DIR ??
		path.join(
			os.homedir(),
			"neelopedia",
			"stats",
			getAgentName(),
			"git-commits-push",
		)
	);
}

function getSink(): ReturnType<typeof createEventSink> {
	const statsDir = getStatsDir();
	const agentName = getAgentName();
	const sessionId = getActiveSessionId();
	const sinkKey = `${statsDir}:${agentName}:${sessionId ?? ""}:${process.cwd()}`;
	if (!sink || sinkKey !== lastSinkKey) {
		lastSinkKey = sinkKey;
		sink = createEventSink({
			statsDir,
			agent: agentName,
			namespace: "git-commits-push",
			...(sessionId ? { sessionId } : {}),
			workspace: process.cwd(),
		});
	}
	return sink;
}

let secretSink: ReturnType<typeof createEventSink> | null = null;
let lastSecretSinkKey: string | undefined;

export function getSecretSink(): ReturnType<typeof createEventSink> {
	const agentName = getAgentName();
	let statsDir = process.env.SECRET_SCANNER_STATS_DIR;
	if (!statsDir) {
		statsDir = process.env.PI_SKILL_STATS_DIR
			? path.join(process.env.PI_SKILL_STATS_DIR, "..", "secret-scanner")
			: path.join(
					os.homedir(),
					"neelopedia",
					"stats",
					agentName,
					"secret-scanner",
				);
	}
	const sinkKey = `${statsDir}:${agentName}`;
	if (!secretSink || sinkKey !== lastSecretSinkKey) {
		lastSecretSinkKey = sinkKey;
		secretSink = createEventSink({
			statsDir,
			agent: agentName,
			namespace: "secret-scanner",
		});
	}
	return secretSink;
}

function getRequestTelemetryContext(): Record<string, unknown> {
	const requestId = process.env[REQUEST_ENV_KEYS.requestId];
	const originSessionId = process.env[REQUEST_ENV_KEYS.originSessionId];
	const originAgent = process.env[REQUEST_ENV_KEYS.originAgent];
	const callerName = process.env[REQUEST_ENV_KEYS.callerName];
	const executorSessionId = getActiveSessionId();
	const isQueuedOrder = process.env[LEGACY_QUEUED_REQUEST_ENV_KEY] === "1";

	return {
		...(requestId ? { orderId: requestId } : {}),
		...(originSessionId ? { orderOriginSessionId: originSessionId } : {}),
		...(originAgent ? { orderOriginAgent: originAgent } : {}),
		...(callerName ? { orderCallerName: callerName } : {}),
		...(executorSessionId ? { executorSessionId } : {}),
		isQueuedOrder,
	};
}

export function parseSecretDetails(details: string): Array<{
	name: string;
	line: string;
	lineNumber: number;
}> {
	return details
		.split(", ")
		.filter(Boolean)
		.map((detail) => {
			const match = detail.match(/^(.*) at line (\d+)$/u);
			if (match) {
				return {
					name: match[1] || "",
					line: "",
					lineNumber: Number.parseInt(match[2] || "0", 10),
				};
			}
			return { name: detail, line: "", lineNumber: 0 };
		});
}

export function appendEvent(
	eventType: string,
	details: Record<string, unknown>,
	timestamp?: string,
): void {
	if (process.env.PI_SKILL_STATS_MODE === "test") return;
	getSink().append(
		eventType,
		{
			...getRequestTelemetryContext(),
			...details,
			cycleId: crypto.randomUUID(),
		},
		{ ...(timestamp ? { timestamp } : {}) },
	);
}

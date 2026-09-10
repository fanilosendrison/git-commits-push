export const EXECUTION_CONTROL_PROTOCOL_VERSION = 1;

export interface PrepareExecutionMessage {
	readonly type: "PREPARE";
	readonly version: typeof EXECUTION_CONTROL_PROTOCOL_VERSION;
	readonly token: string;
}

export interface StartExecutionMessage {
	readonly type: "START";
	readonly version: typeof EXECUTION_CONTROL_PROTOCOL_VERSION;
	readonly token: string;
}

export type LauncherExecutionMessage =
	| PrepareExecutionMessage
	| StartExecutionMessage;

export interface ExecutionReadyMessage {
	readonly type: "READY";
	readonly version: typeof EXECUTION_CONTROL_PROTOCOL_VERSION;
	readonly token: string;
	readonly pid: number;
	readonly processIdentity: string;
	readonly groupId: number;
}

export interface ExecutionStartedMessage {
	readonly type: "STARTED";
	readonly version: typeof EXECUTION_CONTROL_PROTOCOL_VERSION;
	readonly token: string;
	readonly supervisorPid: number;
}

export interface ExecutionResultMessage {
	readonly type: "RESULT";
	readonly version: typeof EXECUTION_CONTROL_PROTOCOL_VERSION;
	readonly token: string;
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly spawnErrorMessage: string | null;
}

export type ControllerExecutionMessage =
	| ExecutionReadyMessage
	| ExecutionStartedMessage
	| ExecutionResultMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function parseLauncherExecutionMessage(
	value: unknown,
): LauncherExecutionMessage | null {
	if (
		!isRecord(value) ||
		value.version !== EXECUTION_CONTROL_PROTOCOL_VERSION ||
		typeof value.token !== "string" ||
		value.token.length === 0
	) {
		return null;
	}
	if (value.type === "PREPARE") {
		return {
			type: "PREPARE",
			version: EXECUTION_CONTROL_PROTOCOL_VERSION,
			token: value.token,
		};
	}
	if (value.type === "START") {
		return {
			type: "START",
			version: EXECUTION_CONTROL_PROTOCOL_VERSION,
			token: value.token,
		};
	}
	return null;
}

export function parseControllerExecutionMessage(
	value: unknown,
): ControllerExecutionMessage | null {
	if (
		!isRecord(value) ||
		value.version !== EXECUTION_CONTROL_PROTOCOL_VERSION ||
		typeof value.token !== "string" ||
		value.token.length === 0
	) {
		return null;
	}
	if (
		value.type === "READY" &&
		Number.isSafeInteger(value.pid) &&
		Number(value.pid) > 0 &&
		typeof value.processIdentity === "string" &&
		value.processIdentity.length > 0 &&
		Number.isSafeInteger(value.groupId) &&
		Number(value.groupId) > 0
	) {
		return {
			type: "READY",
			version: EXECUTION_CONTROL_PROTOCOL_VERSION,
			token: value.token,
			pid: Number(value.pid),
			processIdentity: value.processIdentity,
			groupId: Number(value.groupId),
		};
	}
	if (
		value.type === "STARTED" &&
		Number.isSafeInteger(value.supervisorPid) &&
		Number(value.supervisorPid) > 0
	) {
		return {
			type: "STARTED",
			version: EXECUTION_CONTROL_PROTOCOL_VERSION,
			token: value.token,
			supervisorPid: Number(value.supervisorPid),
		};
	}
	if (
		value.type === "RESULT" &&
		(value.exitCode === null || Number.isSafeInteger(value.exitCode)) &&
		(value.signal === null || typeof value.signal === "string") &&
		(value.spawnErrorMessage === null ||
			typeof value.spawnErrorMessage === "string")
	) {
		return {
			type: "RESULT",
			version: EXECUTION_CONTROL_PROTOCOL_VERSION,
			token: value.token,
			exitCode: value.exitCode === null ? null : Number(value.exitCode),
			signal: value.signal as NodeJS.Signals | null,
			spawnErrorMessage: value.spawnErrorMessage,
		};
	}
	return null;
}

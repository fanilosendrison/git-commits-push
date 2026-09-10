import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import {
	ExecutionBoundaryError,
	platformSupportsExecutionBoundary,
	processGroupExists,
	readProcessGroupId,
	terminateExecutionBoundary,
} from "./execution-boundary-process.ts";
import {
	EXECUTION_CONTROL_PROTOCOL_VERSION,
	type ExecutionReadyMessage,
	type ExecutionResultMessage,
	parseControllerExecutionMessage,
} from "./execution-control-protocol.ts";
import { readProcessStartIdentity } from "./process-identity.ts";
import {
	type ActiveExecutionRecord,
	POSIX_EXECUTION_BOUNDARY_KIND,
} from "./reconciler-state.ts";

const HANDSHAKE_TIMEOUT_MS = 30_000;

export interface SupervisorPassResult {
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly spawnError: Error | null;
	readonly supervisorPid: number | null;
}

export interface PreparedSupervisorPass {
	readonly executionToken: string;
	readonly pid: number;
	readonly processIdentity: string;
	readonly groupId: number;
	readonly start: (abortSignal?: AbortSignal) => Promise<SupervisorPassResult>;
	readonly terminate: () => Promise<void>;
	readonly disconnect: () => void;
}

export interface PrepareSupervisorPassOptions {
	readonly compiledApplicationDirectory: string;
	readonly passthroughArguments: readonly string[];
	readonly executionToken: string;
}

interface ChildClose {
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
}

function waitForSpawn(child: ChildProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		child.once("spawn", resolve);
		child.once("error", reject);
	});
}

function observeClose(child: ChildProcess): Promise<ChildClose> {
	return new Promise((resolve) => {
		child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
	});
}

function sendIpc(child: ChildProcess, message: object): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!child.connected || !child.send) {
			reject(new Error("execution controller IPC channel is closed"));
			return;
		}
		child.send(message, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

function waitForReady(
	child: ChildProcess,
	executionToken: string,
): Promise<ExecutionReadyMessage> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error("execution controller READY handshake timed out"));
		}, HANDSHAKE_TIMEOUT_MS);
		const onMessage = (rawMessage: unknown): void => {
			const message = parseControllerExecutionMessage(rawMessage);
			if (message?.type !== "READY") return;
			cleanup();
			if (message.token !== executionToken) {
				reject(new Error("execution controller READY token mismatch"));
				return;
			}
			resolve(message);
		};
		const onClose = (): void => {
			cleanup();
			reject(new Error("execution controller exited before READY"));
		};
		const cleanup = (): void => {
			clearTimeout(timeout);
			child.removeListener("message", onMessage);
			child.removeListener("close", onClose);
		};
		child.on("message", onMessage);
		child.once("close", onClose);
	});
}

function asBoundaryRecord(
	prepared: Pick<
		PreparedSupervisorPass,
		"executionToken" | "pid" | "processIdentity" | "groupId"
	>,
): ActiveExecutionRecord {
	return {
		boundaryKind: POSIX_EXECUTION_BOUNDARY_KIND,
		generation: 1,
		groupId: prepared.groupId,
		ownerToken: "local-launcher",
		pid: prepared.pid,
		processIdentity: prepared.processIdentity,
		state: "REGISTERED",
		token: prepared.executionToken,
	};
}

function validateReady(
	child: ChildProcess,
	message: ExecutionReadyMessage,
): void {
	if (
		child.pid === undefined ||
		message.pid !== child.pid ||
		message.groupId !== child.pid
	) {
		throw new Error("execution controller READY PID/PGID is invalid");
	}
	const processIdentity = readProcessStartIdentity(child.pid);
	if (
		processIdentity === null ||
		processIdentity !== message.processIdentity ||
		readProcessGroupId(child.pid) !== child.pid
	) {
		throw new Error("execution controller READY process identity is invalid");
	}
}

function observeControllerResult(
	child: ChildProcess,
	executionToken: string,
): {
	readonly result: () => ExecutionResultMessage | null;
	readonly supervisorPid: () => number | null;
	readonly remove: () => void;
} {
	let result: ExecutionResultMessage | null = null;
	let supervisorPid: number | null = null;
	const onMessage = (rawMessage: unknown): void => {
		const message = parseControllerExecutionMessage(rawMessage);
		if (message?.token !== executionToken) return;
		if (message.type === "STARTED") supervisorPid = message.supervisorPid;
		if (message.type === "RESULT") result = message;
	};
	child.on("message", onMessage);
	return {
		result: () => result,
		supervisorPid: () => supervisorPid,
		remove: () => child.removeListener("message", onMessage),
	};
}

/** Spawn a side-effect-inert controller and verify its exact POSIX boundary. */
export async function prepareSupervisorPass({
	compiledApplicationDirectory,
	passthroughArguments,
	executionToken,
}: PrepareSupervisorPassOptions): Promise<PreparedSupervisorPass> {
	if (!executionToken.trim())
		throw new TypeError("execution token is required");
	if (!platformSupportsExecutionBoundary()) {
		throw new ExecutionBoundaryError(
			`SINGLE_LIVE_GIT_EXECUTION is unsupported on ${process.platform}; refusing to start Git work.`,
		);
	}
	const entrypointDirectory = path.join(
		compiledApplicationDirectory,
		"src",
		"entrypoints",
	);
	const controllerPath = path.join(
		entrypointDirectory,
		"execution-controller.js",
	);
	const supervisorPath = path.join(entrypointDirectory, "node-supervisor.js");
	const controller = spawn(
		process.execPath,
		[controllerPath, supervisorPath, ...passthroughArguments],
		{
			cwd: compiledApplicationDirectory,
			detached: true,
			env: process.env,
			shell: false,
			stdio: ["ignore", "inherit", "inherit", "ipc"],
			windowsHide: true,
		},
	);
	const closePromise = observeClose(controller);
	try {
		await waitForSpawn(controller);
		const readyPromise = waitForReady(controller, executionToken);
		await sendIpc(controller, {
			type: "PREPARE",
			version: EXECUTION_CONTROL_PROTOCOL_VERSION,
			token: executionToken,
		});
		const ready = await readyPromise;
		validateReady(controller, ready);

		const preparedIdentity = {
			executionToken,
			groupId: ready.groupId,
			pid: ready.pid,
			processIdentity: ready.processIdentity,
		};
		let started = false;
		return {
			...preparedIdentity,
			disconnect(): void {
				if (controller.connected) controller.disconnect();
			},
			async start(abortSignal?: AbortSignal): Promise<SupervisorPassResult> {
				if (started)
					throw new Error("execution controller START is single-use");
				started = true;
				const observation = observeControllerResult(controller, executionToken);
				const abortPromise = new Promise<"aborted">((resolve) => {
					if (abortSignal?.aborted) resolve("aborted");
					else
						abortSignal?.addEventListener("abort", () => resolve("aborted"), {
							once: true,
						});
				});
				try {
					await sendIpc(controller, {
						type: "START",
						version: EXECUTION_CONTROL_PROTOCOL_VERSION,
						token: executionToken,
					});
					const outcome = await Promise.race([closePromise, abortPromise]);
					if (outcome === "aborted") {
						await terminateExecutionBoundary(
							asBoundaryRecord(preparedIdentity),
						);
					}
					const closed = outcome === "aborted" ? await closePromise : outcome;
					if (processGroupExists(ready.groupId)) {
						throw new ExecutionBoundaryError(
							"execution controller exited before its complete process group was dead",
						);
					}
					const result = observation.result();
					return {
						exitCode: result?.exitCode ?? closed.exitCode,
						signal: result?.signal ?? closed.signal,
						spawnError:
							result?.spawnErrorMessage == null
								? null
								: new Error(result.spawnErrorMessage),
						supervisorPid: observation.supervisorPid(),
					};
				} finally {
					observation.remove();
				}
			},
			async terminate(): Promise<void> {
				await terminateExecutionBoundary(asBoundaryRecord(preparedIdentity));
				await closePromise;
			},
		};
	} catch (error) {
		if (controller.pid !== undefined) {
			const identity = readProcessStartIdentity(controller.pid);
			const groupId = readProcessGroupId(controller.pid);
			if (identity !== null && groupId === controller.pid) {
				await terminateExecutionBoundary({
					boundaryKind: POSIX_EXECUTION_BOUNDARY_KIND,
					generation: 1,
					groupId,
					ownerToken: "local-launcher",
					pid: controller.pid,
					processIdentity: identity,
					state: "REGISTERED",
					token: executionToken,
				});
			} else if (
				controller.exitCode === null &&
				controller.signalCode === null
			) {
				controller.kill("SIGKILL");
			}
		}
		await closePromise;
		throw error;
	}
}

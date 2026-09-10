import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { readProcessGroupId } from "../modules/reconciliation/execution-boundary-process.ts";
import {
	type ControllerExecutionMessage,
	EXECUTION_CONTROL_PROTOCOL_VERSION,
	parseLauncherExecutionMessage,
} from "../modules/reconciliation/execution-control-protocol.ts";
import {
	recordExecutionTestEvent,
	waitForExecutionDisconnectTestBarrier,
	waitForExecutionReadyTestBarrier,
	waitForExecutionStartedMessageTestBarrier,
	waitForExecutionStartTestBarrier,
} from "../modules/reconciliation/execution-test-observer.ts";
import { establishCurrentProcessIdentity } from "../modules/reconciliation/process-identity.ts";
import { isDirectExecution } from "../utils/direct-execution.ts";

const TERMINATION_GRACE_MS = 5_000;
const GROUP_POLL_MS = 20;
const CONTROLLER_SIGNALS = ["SIGINT", "SIGTERM"] as const;

interface SupervisorObservation {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	spawnErrorMessage: string | null;
}

function sendMessage(
	message: ControllerExecutionMessage,
	onComplete: (error: Error | null) => void,
): void {
	if (!process.connected || !process.send) {
		onComplete(new Error("execution controller IPC channel is closed"));
		return;
	}
	try {
		process.send(message, (error) => onComplete(error ?? null));
	} catch (error) {
		onComplete(error instanceof Error ? error : new Error(String(error)));
	}
}

function listOwnGroupMembers(): number[] | null {
	try {
		const inspection = spawnSync("/bin/ps", ["-axo", "pid=,pgid="], {
			encoding: "utf8",
			env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
			stdio: ["ignore", "pipe", "ignore"],
		});
		if (inspection.error || inspection.status !== 0) return null;
		const inspectionPid = inspection.pid;
		const members: number[] = [];
		for (const line of inspection.stdout.split("\n")) {
			const [pidText, groupText] = line.trim().split(/\s+/u);
			const pid = Number.parseInt(pidText ?? "", 10);
			const groupId = Number.parseInt(groupText ?? "", 10);
			if (
				groupId === process.pid &&
				Number.isSafeInteger(pid) &&
				pid > 0 &&
				pid !== inspectionPid
			) {
				members.push(pid);
			}
		}
		return members;
	} catch {
		return null;
	}
}

function signalOwnGroup(signal: NodeJS.Signals): void {
	try {
		process.kill(-process.pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

/** Own one inert-until-START POSIX execution boundary. */
export async function runExecutionController(
	supervisorPath: string,
	passthroughArguments: readonly string[],
): Promise<void> {
	if (!process.send || !process.connected) {
		throw new Error("execution controller requires a launcher IPC channel");
	}
	if (process.platform !== "darwin" && process.platform !== "linux") {
		throw new Error(
			`execution process-group containment is unsupported on ${process.platform}`,
		);
	}

	let executionToken: string | null = null;
	let supervisor: ChildProcess | null = null;
	let supervisorObservation: SupervisorObservation | null = null;
	let terminationStarted = false;
	let completed = false;
	let resultSending = false;
	let forceTimer: NodeJS.Timeout | null = null;
	let groupPollTimer: NodeJS.Timeout | null = null;

	const exitController = (exitCode: number): void => {
		if (completed) return;
		completed = true;
		if (forceTimer !== null) clearTimeout(forceTimer);
		if (groupPollTimer !== null) clearInterval(groupPollTimer);
		process.exit(exitCode);
	};

	const finishWhenQuiescent = (): void => {
		if (!terminationStarted || completed || resultSending) return;
		const members = listOwnGroupMembers();
		if (members === null || members.some((pid) => pid !== process.pid)) return;
		const exitCode = supervisorObservation?.exitCode ?? 1;
		if (
			supervisorObservation !== null &&
			executionToken !== null &&
			process.connected &&
			process.send
		) {
			resultSending = true;
			sendMessage(
				{
					type: "RESULT",
					version: EXECUTION_CONTROL_PROTOCOL_VERSION,
					token: executionToken,
					...supervisorObservation,
				},
				() => exitController(exitCode),
			);
			return;
		}
		exitController(exitCode);
	};

	const beginTermination = (): void => {
		if (terminationStarted || completed) return;
		terminationStarted = true;
		recordExecutionTestEvent("boundary_termination_started", {
			executionToken,
			groupId: process.pid,
		});
		signalOwnGroup("SIGTERM");
		groupPollTimer = setInterval(finishWhenQuiescent, GROUP_POLL_MS);
		groupPollTimer.unref();
		forceTimer = setTimeout(
			() => signalOwnGroup("SIGKILL"),
			TERMINATION_GRACE_MS,
		);
		forceTimer.unref();
		finishWhenQuiescent();
	};

	for (const signal of CONTROLLER_SIGNALS) {
		process.on(signal, beginTermination);
	}
	process.on("disconnect", async () => {
		if (supervisor === null) {
			exitController(0);
			return;
		}
		await waitForExecutionDisconnectTestBarrier();
		beginTermination();
	});

	process.on("message", async (rawMessage: unknown) => {
		const message = parseLauncherExecutionMessage(rawMessage);
		if (message === null) {
			if (supervisor === null) exitController(2);
			else beginTermination();
			return;
		}
		if (message.type === "PREPARE") {
			if (executionToken !== null || supervisor !== null) {
				exitController(2);
				return;
			}
			executionToken = message.token;
			process.env.GCP_ACTIVE_EXECUTION_TOKEN = message.token;
			const processIdentity = establishCurrentProcessIdentity(message.token);
			const groupId = readProcessGroupId(process.pid);
			if (processIdentity === null || groupId !== process.pid) {
				exitController(2);
				return;
			}
			recordExecutionTestEvent("controller_ready", {
				executionToken,
				groupId,
			});
			await waitForExecutionReadyTestBarrier();
			if (!process.connected || completed) return;
			sendMessage(
				{
					type: "READY",
					version: EXECUTION_CONTROL_PROTOCOL_VERSION,
					token: message.token,
					pid: process.pid,
					processIdentity,
					groupId,
				},
				(error) => {
					if (error !== null) exitController(2);
				},
			);
			return;
		}

		if (
			message.type !== "START" ||
			executionToken === null ||
			message.token !== executionToken ||
			supervisor !== null ||
			terminationStarted
		) {
			exitController(2);
			return;
		}
		recordExecutionTestEvent("controller_start_received", {
			executionToken,
			groupId: process.pid,
		});
		await waitForExecutionStartTestBarrier();
		if (!process.connected || completed || terminationStarted) return;
		supervisor = spawn(
			process.execPath,
			[supervisorPath, ...passthroughArguments],
			{
				cwd: process.cwd(),
				detached: false,
				env: process.env,
				shell: false,
				stdio: "inherit",
				windowsHide: true,
			},
		);
		let spawnErrorMessage: string | null = null;
		supervisor.once("error", (error) => {
			spawnErrorMessage = error.message;
		});
		const supervisorPid = supervisor.pid;
		if (supervisorPid !== undefined) {
			recordExecutionTestEvent("supervisor_started", {
				executionToken,
				groupId: process.pid,
				supervisorPid,
			});
			await waitForExecutionStartedMessageTestBarrier();
			sendMessage(
				{
					type: "STARTED",
					version: EXECUTION_CONTROL_PROTOCOL_VERSION,
					token: executionToken,
					supervisorPid,
				},
				(error) => {
					if (error !== null) beginTermination();
				},
			);
		}
		supervisor.once("close", (exitCode, signal) => {
			supervisorObservation = { exitCode, signal, spawnErrorMessage };
			recordExecutionTestEvent("supervisor_exited", {
				executionToken,
				exitCode,
				groupId: process.pid,
			});
			beginTermination();
		});
	});
}

if (isDirectExecution(import.meta.url)) {
	const [supervisorPath, ...passthroughArguments] = process.argv.slice(2);
	if (!supervisorPath)
		throw new Error("execution controller requires supervisor path");
	await runExecutionController(supervisorPath, passthroughArguments);
}

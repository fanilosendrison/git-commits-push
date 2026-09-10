import { appendFileSync, existsSync } from "node:fs";

const EVENTS_PATH_ENV = "GCP_TEST_EXECUTION_EVENTS_PATH";
const READY_BARRIER_ENV = "GCP_TEST_EXECUTION_READY_BARRIER";
const START_BARRIER_ENV = "GCP_TEST_EXECUTION_START_BARRIER";
const DISCONNECT_BARRIER_ENV = "GCP_TEST_EXECUTION_DISCONNECT_BARRIER";
const REGISTERED_BARRIER_ENV = "GCP_TEST_EXECUTION_REGISTERED_BARRIER";

export type ExecutionTestEventType =
	| "controller_ready"
	| "launcher_execution_registered"
	| "controller_start_received"
	| "supervisor_started"
	| "supervisor_exited"
	| "boundary_termination_started";

function testEnvironmentValue(name: string): string | undefined {
	if (process.env.NODE_ENV !== "test") return undefined;
	return process.env[name];
}

/** Append deterministic process-boundary evidence only in explicit tests. */
export function recordExecutionTestEvent(
	type: ExecutionTestEventType,
	details: Readonly<Record<string, string | number | null>>,
): void {
	const eventsPath = testEnvironmentValue(EVENTS_PATH_ENV);
	if (!eventsPath) return;
	appendFileSync(
		eventsPath,
		`${JSON.stringify({ type, ...details, observerPid: process.pid })}\n`,
	);
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForBarrier(variableName: string): Promise<void> {
	const barrierPath = testEnvironmentValue(variableName);
	if (!barrierPath) return;
	while (!existsSync(barrierPath)) await delay(10);
}

export async function waitForExecutionReadyTestBarrier(): Promise<void> {
	await waitForBarrier(READY_BARRIER_ENV);
}

export async function waitForExecutionStartTestBarrier(): Promise<void> {
	await waitForBarrier(START_BARRIER_ENV);
}

export async function waitForExecutionDisconnectTestBarrier(): Promise<void> {
	await waitForBarrier(DISCONNECT_BARRIER_ENV);
}

export async function waitForExecutionRegisteredTestBarrier(): Promise<void> {
	await waitForBarrier(REGISTERED_BARRIER_ENV);
}

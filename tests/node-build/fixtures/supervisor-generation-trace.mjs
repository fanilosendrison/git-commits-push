import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

function owns(row, pid, generation) {
	assert.equal(row.owner_pid, pid);
	assert.equal(row.owner_invocation_mode, "targeted");
	assert.equal(row.running_generation, generation);
	assert.equal(row.requested_generation, generation);
	assert.ok(row.owner_token);
}
function idle(row, generation) {
	assert.equal(row.requested_generation, generation);
	assert.equal(row.completed_generation, generation);
	assert.equal(row.running_generation, null);
	assert.equal(row.owner_token, null);
	assert.equal(row.owner_invocation_mode, null);
	assert.equal(row.execution_token, null);
}
function absentBefore(trace, event, target) {
	assert.ok(
		trace.some((probe) => {
			if (
				probe.type !== "process_probe" ||
				probe.pid !== event.pid ||
				probe.target !== target ||
				probe.exists !== false ||
				probe.code !== "ESRCH" ||
				probe.sequence >= event.beginSequence ||
				probe.transactionOpen ||
				!probe.record
			)
				return false;
			if (target > 0)
				return (
					probe.record.owner_pid === target &&
					probe.record.owner_token === event.before.owner_token &&
					probe.record.owner_process_identity ===
						event.before.owner_process_identity
				);
			return (
				probe.record.execution_state === "START_AUTHORIZED" &&
				Object.keys(event.before)
					.filter((key) => key.startsWith("execution_"))
					.every((key) => probe.record[key] === event.before[key])
			);
		}),
		`missing lifetime-bound pre-transaction ESRCH evidence for ${target}`,
	);
}

function changesOnly(before, after, allowed) {
	for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
		if (before[key] !== after[key])
			assert.ok(allowed.includes(key), `illegal coordinator change: ${key}`);
	}
}
function validateTransitions(commits) {
	for (const { before, after } of commits) {
		const execution = Object.keys(before).filter((key) =>
			key.startsWith("execution_"),
		);
		const owner = Object.keys(before).filter((key) => key.startsWith("owner_"));
		if (before.requested_generation !== after.requested_generation) {
			changesOnly(before, after, [
				...owner,
				"requested_generation",
				"running_generation",
				"heartbeat_at_epoch_ms",
			]);
		} else if (
			before.execution_token === null &&
			after.execution_token !== null
		) {
			changesOnly(before, after, execution);
		} else if (
			before.execution_token !== null &&
			after.execution_token === null
		) {
			changesOnly(before, after, execution);
			for (const key of execution) assert.equal(after[key], null);
		} else if (
			before.execution_token &&
			before.execution_state === "REGISTERED" &&
			after.execution_state === "START_AUTHORIZED"
		) {
			changesOnly(before, after, ["execution_state"]);
		} else if (before.owner_token && after.owner_token === null) {
			changesOnly(before, after, [
				...owner,
				"completed_generation",
				"running_generation",
				"heartbeat_at_epoch_ms",
			]);
			for (const key of owner) assert.equal(after[key], null);
			assert.equal(after.completed_generation, before.requested_generation);
			assert.equal(after.running_generation, null);
			assert.equal(before.execution_token, null);
		} else changesOnly(before, after, ["heartbeat_at_epoch_ms"]);
	}
}
function authorized(row, registration, parentPid, controllerPid, token) {
	assert.ok(row);
	assert.equal(row.owner_pid, parentPid);
	assert.equal(row.owner_token, registration.after.owner_token);
	assert.equal(row.owner_invocation_mode, "targeted");
	assert.equal(row.execution_state, "START_AUTHORIZED");
	assert.equal(row.execution_token, token);
	assert.equal(row.execution_pid, controllerPid);
	assert.equal(row.execution_group_id, controllerPid);
	assert.equal(row.execution_owner_token, row.owner_token);
	assert.equal(row.execution_generation, row.running_generation);
	assert.equal(row.execution_generation, row.requested_generation);
	assert.equal(
		row.execution_generation,
		registration.after.execution_generation,
	);
}

function withoutHeartbeat(row) {
	return Object.fromEntries(
		Object.entries(row).filter(([key]) => key !== "heartbeat_at_epoch_ms"),
	);
}
function connectedCommits(observed) {
	const same = (left, right) =>
		isDeepStrictEqual(withoutHeartbeat(left), withoutHeartbeat(right));
	const pending = observed.filter((event) => !same(event.before, event.after));
	const roots = pending.filter(
		(event) =>
			event.before.requested_generation === 0 &&
			event.before.owner_token === null,
	);
	assert.equal(
		roots.length,
		1,
		"missing or ambiguous initial coordinator state",
	);
	let current = roots[0].before;
	const ordered = [];
	while (pending.length) {
		const candidates = pending.filter(
			(event) =>
				same(event.before, current) &&
				!pending.some(
					(earlier) =>
						earlier.pid === event.pid && earlier.sequence < event.sequence,
				),
		);
		assert.equal(
			candidates.length,
			1,
			"disconnected or forked coordinator snapshots",
		);
		const next = candidates[0];
		ordered.push(next);
		current = next.after;
		pending.splice(pending.indexOf(next), 1);
	}
	return ordered;
}
function sameDescriptor(left, right) {
	for (const key of Object.keys(right).filter((key) =>
		key.startsWith("execution_"),
	))
		assert.deepEqual(left[key], right[key], `disconnected descriptor: ${key}`);
}

/** Independent test oracle: exact settlement or evidenced targeted recovery/readmission. */
export function assertSupervisorGenerationTrace({
	trace,
	executionEvents,
	state,
	ownerPid,
	followUpPid,
	firstToken,
	secondToken,
	forceRecovery = false,
}) {
	const observed = trace.filter(
		(event) =>
			event.type === "coordinator_commit" && event.before && event.after,
	);
	validateTransitions(observed);
	const commits = connectedCommits(observed);
	const admissions = commits.filter(
		(event) =>
			event.before.requested_generation !== event.after.requested_generation,
	);
	assert.ok(
		admissions.length === 2 || admissions.length === 3,
		"unexpected admission count",
	);
	for (const event of admissions)
		assert.equal(
			event.after.requested_generation,
			event.before.requested_generation + 1,
		);
	const initial = admissions[0];
	idle(initial.before, 0);
	owns(initial.after, ownerPid, 1);
	assert.equal(initial.after.completed_generation, 0);
	const second = admissions[1];
	assert.equal(second.pid, followUpPid);
	let finalGeneration;
	if (second.before.owner_token === null) {
		assert.equal(
			forceRecovery,
			false,
			"controlled owner death must require recovery",
		);
		idle(second.before, 1);
		owns(second.after, followUpPid, 2);
		assert.equal(second.after.completed_generation, 1);
		assert.equal(admissions.length, 2);
		finalGeneration = 2;
	} else {
		assert.equal(admissions.length, 3);
		owns(second.before, ownerPid, 1);
		owns(second.after, followUpPid, 2);
		assert.equal(second.before.completed_generation, 0);
		assert.equal(second.after.completed_generation, 0);
		assert.notEqual(second.before.owner_token, second.after.owner_token);
		absentBefore(trace, second, ownerPid);
		for (const key of Object.keys(second.before).filter((key) =>
			key.startsWith("execution_"),
		))
			assert.deepEqual(
				second.after[key],
				second.before[key],
				`recovery changed preserved ${key}`,
			);
		const settlement = commits.filter(
			(event) =>
				event.pid === followUpPid &&
				event.before.owner_token === second.after.owner_token &&
				event.after.owner_token === null,
		);
		assert.equal(settlement.length, 1, "recovery must settle exactly once");
		assert.equal(settlement[0].before.execution_token, null);
		idle(settlement[0].after, 2);
		const fresh = admissions[2];
		assert.equal(fresh.pid, followUpPid);
		idle(fresh.before, 2);
		owns(fresh.after, followUpPid, 3);
		assert.equal(fresh.after.completed_generation, 2);
		assert.notEqual(fresh.after.owner_token, second.after.owner_token);
		assert.ok(settlement[0].sequence < fresh.beginSequence);
		finalGeneration = 3;
	}
	const registrations = commits.filter(
		(event) =>
			event.before.execution_token === null &&
			event.after.execution_token !== null,
	);
	assert.equal(
		registrations.length,
		2,
		"exactly two registered execution chains",
	);
	assert.deepEqual(
		registrations.map((event) => event.after.execution_token),
		[firstToken, secondToken],
	);
	assert.deepEqual(
		registrations.map((event) => event.after.execution_generation),
		[1, finalGeneration],
	);
	assert.deepEqual(
		registrations.map((event) => event.after.owner_pid),
		[ownerPid, followUpPid],
	);
	for (const event of registrations) {
		assert.equal(event.after.execution_state, "REGISTERED");
		assert.equal(event.after.execution_owner_token, event.after.owner_token);
		assert.equal(event.after.execution_pid, event.after.execution_group_id);
	}
	const starts = commits.filter(
		(event) =>
			event.before.execution_state === "REGISTERED" &&
			event.after.execution_state === "START_AUTHORIZED",
	);
	assert.equal(starts.length, 2);
	assert.deepEqual(
		starts.map((event) => event.after.execution_token),
		[firstToken, secondToken],
	);
	const supervisors = executionEvents.filter(
		(event) => event.type === "supervisor_started",
	);
	assert.equal(
		supervisors.length,
		2,
		"no clean or replacement execution may be hidden by LLM counts",
	);
	assert.deepEqual(
		supervisors.map((event) => event.executionToken),
		[firstToken, secondToken],
	);
	const sends = trace.filter((event) => event.type === "controller_start_send");
	const receipts = trace.filter(
		(event) => event.type === "controller_start_receive",
	);
	const spawns = trace.filter((event) => event.type === "supervisor_spawn");
	assert.equal(sends.length, 2);
	assert.equal(receipts.length, 2);
	assert.equal(spawns.length, 2);
	for (const [index, token] of [firstToken, secondToken].entries()) {
		const registration = registrations[index];
		sameDescriptor(starts[index].before, registration.after);
		const parentPid = registration.after.owner_pid;
		const controllerPid = registration.after.execution_pid;
		assert.equal(supervisors[index].groupId, controllerPid);
		const send = sends.find((event) => event.token === token);
		const receipt = receipts.find((event) => event.token === token);
		const spawn = spawns.find(
			(event) => event.childPid === supervisors[index].supervisorPid,
		);
		assert.ok(send && receipt && spawn);
		assert.equal(send.pid, parentPid);
		assert.equal(send.controllerPid, controllerPid);
		assert.equal(send.transactionOpen, false);
		assert.equal(receipt.pid, controllerPid);
		assert.equal(receipt.parentPid, parentPid);
		assert.equal(spawn.pid, controllerPid);
		assert.equal(spawn.token, token);
		assert.ok(
			spawn.receipt &&
				spawn.receipt.token === token &&
				spawn.receipt.sequence === receipt.sequence,
		);
		authorized(send.record, registration, parentPid, controllerPid, token);
		authorized(receipt.record, registration, parentPid, controllerPid, token);
		authorized(spawn.record, registration, parentPid, controllerPid, token);
		for (const record of [send.record, receipt.record, spawn.record])
			sameDescriptor(record, starts[index].after);
		assert.ok(receipt.sequence < spawn.sequence);
		const clears = commits.filter(
			(event) =>
				event.before.execution_token === token &&
				event.after.execution_token === null,
		);
		assert.equal(clears.length, 1);
		sameDescriptor(clears[0].before, starts[index].after);
		absentBefore(trace, clears[0], supervisors[index].groupId * -1);
	}
	assert.equal(state.requestedGeneration, finalGeneration);
	assert.equal(state.completedGeneration, finalGeneration);
	assert.equal(state.runningGeneration, null);
	assert.equal(state.ownerToken, null);
	assert.equal(state.activeExecution, null);
	return finalGeneration;
}

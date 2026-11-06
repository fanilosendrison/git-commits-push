import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSupervisorGenerationTrace } from "./fixtures/supervisor-generation-trace.mjs";

function scenario(recovery) {
	const trace = [];
	const sequences = new Map();
	const next = (pid) => {
		const value = (sequences.get(pid) ?? 0) + 1;
		sequences.set(pid, value);
		return value;
	};
	const row = (
		generation,
		completed,
		pid = null,
		token = null,
		execution = null,
	) => ({
		requested_generation: generation,
		completed_generation: completed,
		running_generation: pid ? generation : null,
		owner_pid: pid,
		owner_token: token,
		owner_invocation_mode: pid ? "targeted" : null,
		owner_process_identity: pid ? `birth-${pid}` : null,
		execution_token: execution?.token ?? null,
		execution_generation: execution?.generation ?? null,
		execution_pid: execution?.group ?? null,
		execution_group_id: execution?.group ?? null,
		execution_owner_token: execution?.owner ?? null,
		execution_state: execution?.state ?? null,
	});
	const commit = (pid, before, after) => {
		const event = {
			type: "coordinator_commit",
			pid,
			before: structuredClone(before),
			after: structuredClone(after),
			beginSequence: next(pid),
			sequence: next(pid),
		};
		trace.push(event);
		return event;
	};
	const absent = (pid, target, record) =>
		trace.push({
			type: "process_probe",
			pid,
			target,
			exists: false,
			code: "ESRCH",
			record: structuredClone(record),
			transactionOpen: false,
			sequence: next(pid),
		});
	const handshake = (parentPid, controllerPid, token, record) => {
		trace.push({
			type: "controller_start_send",
			pid: parentPid,
			controllerPid,
			token,
			record: structuredClone(record),
			transactionOpen: false,
			sequence: next(parentPid),
		});
		const receipt = {
			type: "controller_start_receive",
			pid: controllerPid,
			parentPid,
			token,
			record: structuredClone(record),
			sequence: next(controllerPid),
		};
		trace.push(receipt);
		trace.push({
			type: "supervisor_spawn",
			pid: controllerPid,
			childPid: controllerPid + 1,
			token,
			receipt: structuredClone(receipt),
			record: structuredClone(record),
			sequence: next(controllerPid),
		});
	};
	const registered = {
		token: "first",
		generation: 1,
		group: 100,
		owner: "A",
		state: "REGISTERED",
	};
	const started = { ...registered, state: "START_AUTHORIZED" };
	const zero = row(0, 0);
	const acquired = row(1, 0, 10, "A");
	const firstReg = row(1, 0, 10, "A", registered);
	const firstStart = row(1, 0, 10, "A", started);
	commit(10, zero, acquired);
	commit(10, acquired, firstReg);
	commit(10, firstReg, firstStart);
	handshake(10, 100, "first", firstStart);
	let beforeFresh;
	let ownGeneration;
	if (recovery) {
		absent(20, 10, firstStart);
		const recovered = row(2, 0, 20, "R", started);
		commit(20, firstStart, recovered);
		absent(20, -100, recovered);
		const cleared = row(2, 0, 20, "R");
		commit(20, recovered, cleared);
		beforeFresh = row(2, 2);
		commit(20, cleared, beforeFresh);
		ownGeneration = 3;
	} else {
		absent(10, -100, firstStart);
		const cleared = row(1, 0, 10, "A");
		commit(10, firstStart, cleared);
		beforeFresh = row(1, 1);
		commit(10, cleared, beforeFresh);
		ownGeneration = 2;
	}
	const fresh = row(ownGeneration, ownGeneration - 1, 20, "B");
	commit(20, beforeFresh, fresh);
	const secondReg = row(ownGeneration, ownGeneration - 1, 20, "B", {
		token: "second",
		generation: ownGeneration,
		group: 200,
		owner: "B",
		state: "REGISTERED",
	});
	const secondStart = { ...secondReg, execution_state: "START_AUTHORIZED" };
	commit(20, fresh, secondReg);
	commit(20, secondReg, secondStart);
	handshake(20, 200, "second", secondStart);
	absent(20, -200, secondStart);
	const cleared = row(ownGeneration, ownGeneration - 1, 20, "B");
	commit(20, secondStart, cleared);
	commit(20, cleared, row(ownGeneration, ownGeneration));
	return {
		trace,
		ownerPid: 10,
		followUpPid: 20,
		firstToken: "first",
		secondToken: "second",
		forceRecovery: recovery,
		executionEvents: [
			{
				type: "supervisor_started",
				executionToken: "first",
				groupId: 100,
				supervisorPid: 101,
			},
			{
				type: "supervisor_started",
				executionToken: "second",
				groupId: 200,
				supervisorPid: 201,
			},
		],
		state: {
			requestedGeneration: ownGeneration,
			completedGeneration: ownGeneration,
			runningGeneration: null,
			ownerToken: null,
			activeExecution: null,
		},
	};
}

for (const recovery of [false, true])
	test(`generation trace accepts the exact ${recovery ? "targeted-recovery" : "normal-settlement"} route`, () => {
		assert.equal(
			assertSupervisorGenerationTrace(scenario(recovery)),
			recovery ? 3 : 2,
		);
	});
function renumber(data) {
	const counters = new Map();
	const next = (pid) => {
		const value = (counters.get(pid) ?? 0) + 1;
		counters.set(pid, value);
		return value;
	};
	for (const event of data.trace) {
		if (event.type === "coordinator_commit")
			event.beginSequence = next(event.pid);
		event.sequence = next(event.pid);
	}
	for (const event of data.trace.filter(
		(item) => item.type === "supervisor_spawn",
	))
		if (event.receipt)
			event.receipt.sequence = data.trace.find(
				(item) =>
					item.type === "controller_start_receive" && item.pid === event.pid,
			).sequence;
}

test("snapshot continuity does not depend on cross-process append order", () => {
	const data = scenario(true);
	data.trace.reverse();
	assert.equal(assertSupervisorGenerationTrace(data), 3);
});
test("snapshot continuity permits heartbeat changes only", () => {
	const data = scenario(true);
	let stamp = 0;
	for (const event of data.trace.filter(
		(item) => item.type === "coordinator_commit",
	)) {
		const observed = ++stamp;
		event.before.heartbeat_at_epoch_ms = event.before.owner_token
			? observed
			: null;
		event.after.heartbeat_at_epoch_ms = event.after.owner_token
			? observed
			: null;
	}
	assert.equal(assertSupervisorGenerationTrace(data), 3);
});
const invalid = {
	"omitted adoption event": (data) => {
		const clear = data.trace.find(
			(event) =>
				event.type === "coordinator_commit" &&
				event.before.execution_token === "first" &&
				event.after.execution_token === null,
		);
		clear.before.execution_generation = 2;
		clear.before.execution_owner_token = "R";
		data.trace.find((event) => event.target === -100).record = structuredClone(
			clear.before,
		);
	},
	"intermediate recovery adoption": (data) => {
		const index = data.trace.findIndex(
			(event) =>
				event.type === "coordinator_commit" &&
				event.before.owner_pid === 10 &&
				event.after.owner_pid === 20,
		);
		const before = data.trace[index].after;
		const adopted = {
			...before,
			execution_generation: 2,
			execution_owner_token: before.owner_token,
		};
		data.trace.splice(index + 1, 0, {
			type: "coordinator_commit",
			pid: 20,
			before: structuredClone(before),
			after: structuredClone(adopted),
		});
		data.trace.find(
			(event) =>
				event.type === "coordinator_commit" &&
				event.before.execution_token === "first" &&
				event.after.execution_token === null,
		).before = structuredClone(adopted);
		data.trace.find(
			(event) => event.type === "process_probe" && event.target === -100,
		).record = structuredClone(adopted);
		renumber(data);
	},
	"wrong supervisor group death": (data) => {
		data.executionEvents[0].groupId = 999;
		data.trace.find((event) => event.target === -100).target = -999;
	},
	"START before committed authorization": (data) => {
		data.trace.find(
			(event) =>
				event.type === "controller_start_send" && event.token === "second",
		).record.execution_state = "REGISTERED";
	},
	"supervisor before START receipt": (data) => {
		data.trace.find(
			(event) => event.type === "supervisor_spawn" && event.token === "second",
		).receipt = null;
	},
	"missing owner-death proof": (data) => {
		data.trace = data.trace.filter((event) => event.target !== 10);
	},
	"missing group-death proof": (data) => {
		data.trace = data.trace.filter((event) => event.target !== -100);
	},
	"global recovery substitution": (data) => {
		data.trace.find(
			(event) =>
				event.type === "coordinator_commit" &&
				event.before.owner_pid === 10 &&
				event.after.owner_pid === 20,
		).after.owner_invocation_mode = "global";
	},
	"erased preserved execution": (data) => {
		data.trace.find(
			(event) =>
				event.type === "coordinator_commit" &&
				event.before.owner_pid === 10 &&
				event.after.owner_pid === 20,
		).after.execution_token = null;
	},
	"phantom extra generation": (data) => {
		data.state.requestedGeneration = 4;
		data.state.completedGeneration = 4;
	},
	"unrecorded clean execution": (data) => {
		data.executionEvents.push({
			type: "supervisor_started",
			executionToken: "third",
			groupId: 300,
		});
	},
	"execution during recovery": (data) => {
		data.trace.find(
			(event) =>
				event.type === "coordinator_commit" &&
				event.after.execution_token === "second",
		).after.execution_generation = 2;
	},
	"missing fresh admission": (data) => {
		data.trace = data.trace.filter(
			(event) =>
				!(
					event.type === "coordinator_commit" &&
					event.before.requested_generation === 2 &&
					event.after.requested_generation === 3
				),
		);
	},
};
test("generation trace rejects a pre-existence group observation", () => {
	const data = scenario(false);
	const index = data.trace.findIndex(
		(event) => event.type === "process_probe" && event.target === -100,
	);
	const [probe] = data.trace.splice(index, 1);
	const registration = data.trace.findIndex(
		(event) =>
			event.type === "coordinator_commit" &&
			event.before.execution_token === null &&
			event.after.execution_token === "first",
	);
	probe.record = structuredClone(data.trace[registration].before);
	data.trace.splice(registration, 0, probe);
	renumber(data);
	assert.throws(() => assertSupervisorGenerationTrace(data));
});

for (const [name, mutate] of Object.entries(invalid))
	test(`generation trace rejects ${name}`, () => {
		const data = scenario(true);
		mutate(data);
		assert.throws(() => assertSupervisorGenerationTrace(data));
	});

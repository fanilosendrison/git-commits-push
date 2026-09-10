import assert from "node:assert/strict";
import { test } from "node:test";
import {
	EXECUTION_CONTROL_PROTOCOL_VERSION,
	parseControllerExecutionMessage,
	parseLauncherExecutionMessage,
} from "../../src/modules/reconciliation/execution-control-protocol.ts";

test("execution control protocol accepts only versioned non-empty tokens", () => {
	assert.deepStrictEqual(
		parseLauncherExecutionMessage({
			type: "PREPARE",
			version: EXECUTION_CONTROL_PROTOCOL_VERSION,
			token: "execution-token",
		}),
		{
			type: "PREPARE",
			version: EXECUTION_CONTROL_PROTOCOL_VERSION,
			token: "execution-token",
		},
	);
	for (const invalid of [
		null,
		{},
		{ type: "START", version: 999, token: "execution-token" },
		{ type: "START", version: EXECUTION_CONTROL_PROTOCOL_VERSION, token: "" },
		{
			type: "UNKNOWN",
			version: EXECUTION_CONTROL_PROTOCOL_VERSION,
			token: "x",
		},
	]) {
		assert.strictEqual(parseLauncherExecutionMessage(invalid), null);
	}
});

test("execution control protocol rejects malformed READY and wrong result shapes", () => {
	assert.deepStrictEqual(
		parseControllerExecutionMessage({
			type: "READY",
			version: EXECUTION_CONTROL_PROTOCOL_VERSION,
			token: "execution-token",
			pid: 123,
			processIdentity: "birth-identity",
			groupId: 123,
		}),
		{
			type: "READY",
			version: EXECUTION_CONTROL_PROTOCOL_VERSION,
			token: "execution-token",
			pid: 123,
			processIdentity: "birth-identity",
			groupId: 123,
		},
	);
	for (const invalid of [
		{
			type: "READY",
			version: EXECUTION_CONTROL_PROTOCOL_VERSION,
			token: "execution-token",
			pid: 0,
			processIdentity: "birth-identity",
			groupId: 0,
		},
		{
			type: "RESULT",
			version: EXECUTION_CONTROL_PROTOCOL_VERSION,
			token: "execution-token",
			exitCode: "0",
			signal: null,
			spawnErrorMessage: null,
		},
	]) {
		assert.strictEqual(parseControllerExecutionMessage(invalid), null);
	}
});

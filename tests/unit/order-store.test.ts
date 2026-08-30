import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	deleteQueuedOrder,
	deleteQueuedOrderFiles,
	listQueuedOrders,
	orderFileName,
	writeQueuedOrder,
} from "../../src/modules/orders/order-store.ts";
import type { OrderMetadata } from "../../src/modules/orders/types.ts";

describe("order-store", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "order-store-"));
	});

	afterEach(() => {
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	function order(overrides: Partial<OrderMetadata>): OrderMetadata {
		return {
			orderId: "order-a",
			requestedRunId: "run-a",
			originAgent: "pi",
			callerName: "Pi Agent",
			queuedAtEpochMs: 100,
			...overrides,
		};
	}

	test("writes queued orders as inspectable JSON", () => {
		const queued = order({
			orderId: "order-session-2",
			requestedRunId: "run-session-2",
			originSessionId: "session-2",
			blockedByRunId: "run-session-1",
			queuePosition: 1,
		});

		const filePath = writeQueuedOrder(testDir, queued);

		assert.strictEqual(path.basename(filePath), orderFileName(queued));
		const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		assert.strictEqual(raw.orderId, "order-session-2");
		assert.strictEqual(raw.originSessionId, "session-2");
		assert.strictEqual(raw.blockedByRunId, "run-session-1");
	});

	test("lists queued orders in FIFO order", () => {
		writeQueuedOrder(
			testDir,
			order({ orderId: "order-third", queuedAtEpochMs: 300 }),
		);
		writeQueuedOrder(
			testDir,
			order({ orderId: "order-first", queuedAtEpochMs: 100 }),
		);
		writeQueuedOrder(
			testDir,
			order({ orderId: "order-second", queuedAtEpochMs: 200 }),
		);

		const records = listQueuedOrders(testDir);

		assert.deepStrictEqual(
			records.map((record) => record.order.orderId),
			["order-first", "order-second", "order-third"],
		);
	});

	test("deletes individual and bulk queued order files", () => {
		writeQueuedOrder(
			testDir,
			order({ orderId: "order-first", queuedAtEpochMs: 100 }),
		);
		writeQueuedOrder(
			testDir,
			order({ orderId: "order-second", queuedAtEpochMs: 200 }),
		);

		const first = listQueuedOrders(testDir)[0];
		assert.notStrictEqual(first, undefined);
		if (!first) return;

		deleteQueuedOrder(first);
		assert.deepStrictEqual(
			listQueuedOrders(testDir).map((record) => record.order.orderId),
			["order-second"],
		);

		deleteQueuedOrderFiles(testDir);
		assert.deepStrictEqual(listQueuedOrders(testDir), []);
	});
});

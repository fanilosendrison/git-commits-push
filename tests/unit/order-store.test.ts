import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

		expect(path.basename(filePath)).toBe(orderFileName(queued));
		const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		expect(raw.orderId).toBe("order-session-2");
		expect(raw.originSessionId).toBe("session-2");
		expect(raw.blockedByRunId).toBe("run-session-1");
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

		expect(records.map((record) => record.order.orderId)).toEqual([
			"order-first",
			"order-second",
			"order-third",
		]);
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
		expect(first).toBeDefined();
		if (!first) return;

		deleteQueuedOrder(first);
		expect(
			listQueuedOrders(testDir).map((record) => record.order.orderId),
		).toEqual(["order-second"]);

		deleteQueuedOrderFiles(testDir);
		expect(listQueuedOrders(testDir)).toEqual([]);
	});
});

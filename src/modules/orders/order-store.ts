import * as fs from "node:fs";
import * as path from "node:path";
import type {
	LockMetadata,
	OrderMetadata,
	QueuedOrderRecord,
} from "./types.ts";

const ORDER_FILE_PATTERN = /^order-(\d+)-(.+)\.(json|flag)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
	record: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(
	record: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

export function isQueuedOrderFile(fileName: string): boolean {
	return ORDER_FILE_PATTERN.test(fileName);
}

function fileParts(
	fileName: string,
): { queuedAtEpochMs: number; id: string } | null {
	const match = fileName.match(ORDER_FILE_PATTERN);
	if (!match) return null;
	const queuedAtEpochMs = Number.parseInt(match[1] ?? "", 10);
	const id = match[2];
	if (!Number.isFinite(queuedAtEpochMs) || !id) return null;
	return { queuedAtEpochMs, id };
}

function normalizeOrder(
	value: unknown,
	fileName: string,
): OrderMetadata | null {
	const parts = fileParts(fileName);
	if (!parts) return null;

	if (!isRecord(value)) {
		return {
			orderId: parts.id,
			requestedRunId: "legacy-queued-order",
			originAgent: "unknown",
			callerName: "unknown",
			queuedAtEpochMs: parts.queuedAtEpochMs,
		};
	}

	const orderId = stringField(value, "orderId") ?? parts.id;
	const requestedRunId =
		stringField(value, "requestedRunId") ?? "unknown-requested-run";
	const originAgent = stringField(value, "originAgent") ?? "unknown";
	const callerName = stringField(value, "callerName") ?? "unknown";
	const queuedAtEpochMs =
		numberField(value, "queuedAtEpochMs") ?? parts.queuedAtEpochMs;
	const originSessionId = stringField(value, "originSessionId");
	const blockedByRunId = stringField(value, "blockedByRunId");
	const blockedByCallerName = stringField(value, "blockedByCallerName");
	const triggeredByRunId = stringField(value, "triggeredByRunId");
	const queuePosition = numberField(value, "queuePosition");

	return {
		orderId,
		requestedRunId,
		originAgent,
		callerName,
		queuedAtEpochMs,
		...(originSessionId ? { originSessionId } : {}),
		...(blockedByRunId ? { blockedByRunId } : {}),
		...(blockedByCallerName ? { blockedByCallerName } : {}),
		...(triggeredByRunId ? { triggeredByRunId } : {}),
		...(queuePosition ? { queuePosition } : {}),
	};
}

function readOrderFile(filePath: string): OrderMetadata | null {
	const fileName = path.basename(filePath);
	const ext = path.extname(fileName);
	if (ext === ".flag") {
		return normalizeOrder(null, fileName);
	}

	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		return normalizeOrder(parsed, fileName);
	} catch {
		return null;
	}
}

export function orderFileName(order: OrderMetadata): string {
	return `order-${order.queuedAtEpochMs}-${order.orderId}.json`;
}

export function writeQueuedOrder(dir: string, order: OrderMetadata): string {
	fs.mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, orderFileName(order));
	const tmpPath = `${filePath}.tmp-${process.pid}`;
	fs.writeFileSync(tmpPath, JSON.stringify(order, null, 2), "utf-8");
	fs.renameSync(tmpPath, filePath);
	return filePath;
}

export function listQueuedOrders(dir: string): QueuedOrderRecord[] {
	if (!fs.existsSync(dir)) return [];

	return fs
		.readdirSync(dir)
		.filter(isQueuedOrderFile)
		.map((fileName) => {
			const filePath = path.join(dir, fileName);
			const order = readOrderFile(filePath);
			if (!order) return null;
			return { filePath, fileName, order };
		})
		.filter((record): record is QueuedOrderRecord => record !== null)
		.sort((a, b) => {
			if (a.order.queuedAtEpochMs !== b.order.queuedAtEpochMs) {
				return a.order.queuedAtEpochMs - b.order.queuedAtEpochMs;
			}
			return a.fileName.localeCompare(b.fileName);
		});
}

export function deleteQueuedOrder(record: QueuedOrderRecord): void {
	fs.unlinkSync(record.filePath);
}

export function deleteQueuedOrderFiles(dir: string): void {
	if (!fs.existsSync(dir)) return;

	for (const fileName of fs.readdirSync(dir)) {
		if (isQueuedOrderFile(fileName)) {
			fs.unlinkSync(path.join(dir, fileName));
		}
	}
}

export function readLock(lockPath: string): LockMetadata | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
		if (!isRecord(parsed)) return null;
		const runId = stringField(parsed, "runId");
		const callerName = stringField(parsed, "callerName");
		const timestamp = numberField(parsed, "timestamp");
		if (!runId || !callerName || timestamp === undefined) return null;

		const orderId = stringField(parsed, "orderId");
		const originSessionId = stringField(parsed, "originSessionId");
		const originAgent = stringField(parsed, "originAgent");

		return {
			runId,
			callerName,
			timestamp,
			...(orderId ? { orderId } : {}),
			...(originSessionId ? { originSessionId } : {}),
			...(originAgent ? { originAgent } : {}),
		};
	} catch {
		return null;
	}
}

export function writeLock(lockPath: string, lock: LockMetadata): void {
	fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2), "utf-8");
}

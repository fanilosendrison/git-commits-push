import { randomUUID } from "node:crypto";
import { ulid } from "ulid";

function formatTimestamp(date: Date): string {
	return date.toISOString().replace(/[:.-]/g, "").toLowerCase();
}

export function createRunId(): string {
	return ulid();
}

export function createOrderId(now = new Date()): string {
	return `order-${formatTimestamp(now)}-${randomUUID().slice(0, 8)}`;
}

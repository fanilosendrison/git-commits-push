import { randomUUID } from "node:crypto";

function formatTimestamp(date: Date): string {
	return date.toISOString().replace(/[:.-]/g, "").toLowerCase();
}

export function createRunId(now = new Date()): string {
	return `run-${formatTimestamp(now)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function createOrderId(now = new Date()): string {
	return `order-${formatTimestamp(now)}-${randomUUID().slice(0, 8)}`;
}

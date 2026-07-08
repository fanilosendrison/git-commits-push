export const ORDER_ENV_KEYS = {
	orderId: "GCP_ORDER_ID",
	originSessionId: "GCP_ORDER_ORIGIN_SESSION_ID",
	originAgent: "GCP_ORDER_ORIGIN_AGENT",
	callerName: "GCP_ORDER_CALLER_NAME",
	queuedAtEpochMs: "GCP_ORDER_QUEUED_AT_EPOCH_MS",
	triggeredByRunId: "GCP_ORDER_TRIGGERED_BY_RUN_ID",
	isQueuedOrder: "GCP_ORDER_IS_QUEUED",
} as const;

export interface LockMetadata {
	runId: string;
	callerName: string;
	timestamp: number;
	orderId?: string;
	originSessionId?: string;
	originAgent?: string;
}

export interface OrderMetadata {
	orderId: string;
	requestedRunId: string;
	originAgent: string;
	callerName: string;
	queuedAtEpochMs: number;
	originSessionId?: string;
	blockedByRunId?: string;
	blockedByCallerName?: string;
	triggeredByRunId?: string;
	queuePosition?: number;
}

export interface OrderContext {
	orderId: string;
	originAgent: string;
	callerName: string;
	originSessionId?: string;
	queuedAtEpochMs?: number;
	triggeredByRunId?: string;
	isQueuedOrder: boolean;
}

export type AcquireLockResult =
	| {
			kind: "ACQUIRED";
			order: OrderMetadata;
			lock: LockMetadata;
	  }
	| {
			kind: "QUEUED";
			order: OrderMetadata;
			position: number;
			blockedByRunId: string;
			blockedByCallerName: string;
	  };

export type ReleaseLockResult =
	| {
			kind: "released";
			triggeredOrder?: OrderMetadata;
			remainingQueuedOrders: number;
	  }
	| {
			kind: "missing-lock" | "malformed-lock" | "not-owner";
	  };

export interface QueuedOrderRecord {
	filePath: string;
	fileName: string;
	order: OrderMetadata;
}

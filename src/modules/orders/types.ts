/**
 * src/modules/orders/types.ts — Request identity contract.
 *
 * A "request" (formerly "order") is one public invocation of git-commits-push.
 * It is a pure identity for observability: the reconciler never persists
 * requests, queues them, or binds them to repositories.
 */
export const LEGACY_QUEUED_REQUEST_ENV_KEY = "GCP_ORDER_IS_QUEUED";

export const REQUEST_ENV_KEYS = {
	requestId: "GCP_ORDER_ID",
	originSessionId: "GCP_ORDER_ORIGIN_SESSION_ID",
	originAgent: "GCP_ORDER_ORIGIN_AGENT",
	callerName: "GCP_ORDER_CALLER_NAME",
} as const;

export interface RequestIdentity {
	requestId: string;
	callerName: string;
	originAgent: string;
	originSessionId?: string;
}

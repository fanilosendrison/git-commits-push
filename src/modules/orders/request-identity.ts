/**
 * src/modules/orders/request-identity.ts — Request identity detection.
 *
 * Detects the caller identity (agent, session, caller name) for one public
 * invocation and exposes it as environment variables consumed by telemetry.
 * The launcher owns this detection for real invocations; direct orchestrator
 * runs (tests, dev) fall back to the same detection here.
 */
import { resolveExecutionIdentity } from "../core/execution-identity.ts";
import { createOrderId } from "./order-id.ts";
import { REQUEST_ENV_KEYS, type RequestIdentity } from "./types.ts";

function readExplicitIdentityValue(key: string): string | undefined {
	const value = process.env[key];
	if (value === undefined) return undefined;
	const normalized = value.trim();
	if (!normalized) {
		throw new Error(`${key} must not be empty when explicitly configured.`);
	}
	return normalized;
}

function assertIdentityValue(name: string, value: string): void {
	if (!value.trim()) throw new Error(`${name} must not be empty.`);
}

/**
 * Resolve the request identity from the environment. When no identity is
 * present (direct orchestrator invocation), a fresh request id is created and
 * the identity is exported to the environment for downstream telemetry.
 */
export function resolveRequestIdentity(): RequestIdentity {
	const executionIdentity = resolveExecutionIdentity();
	const originSessionId =
		readExplicitIdentityValue(REQUEST_ENV_KEYS.originSessionId) ??
		executionIdentity.sessionId;
	const identity: RequestIdentity = {
		requestId:
			readExplicitIdentityValue(REQUEST_ENV_KEYS.requestId) ?? createOrderId(),
		callerName:
			readExplicitIdentityValue(REQUEST_ENV_KEYS.callerName) ??
			executionIdentity.callerName,
		originAgent:
			readExplicitIdentityValue(REQUEST_ENV_KEYS.originAgent) ??
			executionIdentity.agentName,
		...(originSessionId ? { originSessionId } : {}),
	};
	exportRequestIdentityEnv(identity);
	return identity;
}

export function exportRequestIdentityEnv(identity: RequestIdentity): void {
	assertIdentityValue("requestId", identity.requestId);
	assertIdentityValue("callerName", identity.callerName);
	assertIdentityValue("originAgent", identity.originAgent);
	if (identity.originSessionId !== undefined) {
		assertIdentityValue("originSessionId", identity.originSessionId);
	}
	process.env[REQUEST_ENV_KEYS.requestId] = identity.requestId;
	process.env[REQUEST_ENV_KEYS.callerName] = identity.callerName;
	process.env[REQUEST_ENV_KEYS.originAgent] = identity.originAgent;
	if (identity.originSessionId) {
		process.env[REQUEST_ENV_KEYS.originSessionId] = identity.originSessionId;
	}
}

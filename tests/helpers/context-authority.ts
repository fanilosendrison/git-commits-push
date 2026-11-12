import { createHash } from "node:crypto";
import type {
	ContextAuthority,
	ContextProfile,
} from "../../src/modules/llm/context-types.ts";

/** Explicit synthetic oracle: JSON UTF-8 bytes are TEST units, never provider tokens. */
export function syntheticContextAuthority(
	overrides: Partial<ContextProfile> = {},
): ContextAuthority {
	return {
		scope: "test",
		now: () => 100,
		resolve: (request) => ({
			scope: "test",
			id: "synthetic-byte-profile",
			provider: request.provider,
			model: request.model,
			revision: "synthetic-revision-1",
			protocol: request.protocol,
			encoding: "test-json-utf8-byte-units",
			provenance: "independent test fixture; no production qualification",
			qualifiedAt: 0,
			expiresAt: 1000,
			inputLimit: 10_000_000,
			outputLimit: 8192,
			minimumResponseTokens: 16,
			count: async (input) => ({
				requestDigest: createHash("sha256")
					.update(JSON.stringify(input))
					.digest("hex"),
				revision: "synthetic-revision-1",
				encoding: "test-json-utf8-byte-units",
				includesProtocol: true,
				inputTokens: Buffer.byteLength(JSON.stringify(input)),
			}),
			...overrides,
		}),
	};
}

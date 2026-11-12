import { createHash } from "node:crypto";

/** Synthetic JSON-byte units only. No production model or tokenizer qualification. */
export function syntheticCompiledAuthority(overrides = {}) {
	return {
		scope: "test",
		now: () => 100,
		resolve: (request) => ({
			scope: "test",
			id: "compiled-synthetic-profile",
			provider: request.provider,
			model: request.model,
			revision: "synthetic-revision",
			protocol: request.protocol,
			encoding: "test-json-byte-units",
			provenance: "independent compiled fixture",
			qualifiedAt: 0,
			expiresAt: 1000,
			inputLimit: 10000000,
			outputLimit: 8192,
			minimumResponseTokens: 16,
			count: async (input) => ({
				requestDigest: createHash("sha256")
					.update(JSON.stringify(input))
					.digest("hex"),
				revision: "synthetic-revision",
				encoding: "test-json-byte-units",
				includesProtocol: true,
				inputTokens: Buffer.byteLength(JSON.stringify(input)),
			}),
			...overrides,
		}),
	};
}

/**
 * Bun preload used by the full-pipeline acceptance test.
 *
 * It replaces only the external HTTP boundary. The orchestrator, Turnlock
 * protocol, bridge CLI, result persistence, resume command, and Git publisher
 * all run as production code in separate Bun processes.
 */
const OPENAI_COMPLETIONS_ENDPOINT =
	"https://api.openai.com/v1/chat/completions";
let completionCallCount = 0;

function resolveRequestUrl(input: string | URL | Request): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

const mockFetch = async (
	input: string | URL | Request,
	init?: RequestInit,
): Promise<Response> => {
	const requestUrl = resolveRequestUrl(input);
	if (requestUrl !== OPENAI_COMPLETIONS_ENDPOINT) {
		throw new Error(`Unexpected LLM endpoint: ${requestUrl}`);
	}
	const requestMethod =
		init?.method ?? (input instanceof Request ? input.method : undefined);
	if (requestMethod !== "POST") {
		throw new Error(
			`Unexpected LLM request method: ${requestMethod ?? "none"}`,
		);
	}

	const isInitialResponse = completionCallCount === 0;
	completionCallCount++;
	const completionPlan = {
		commit: {
			type: "feat",
			// The first response intentionally violates the lowercase-subject rule.
			// The bridge must process the retry delegation that Turnlock emits.
			description: isInitialResponse
				? "Complete v2 pipeline"
				: "complete v2 pipeline",
			isBreaking: false,
		},
		files: ["pipeline.ts"],
	};

	return new Response(
		JSON.stringify({
			id: "test-completion",
			object: "chat.completion",
			created: 0,
			model: "gpt-5.4-mini",
			choices: [
				{
					index: 0,
					message: {
						role: "assistant",
						content: JSON.stringify([completionPlan]),
					},
					finish_reason: "stop",
				},
			],
			usage: {
				prompt_tokens: 1,
				completion_tokens: 1,
				total_tokens: 2,
			},
		}),
		{
			status: 200,
			headers: { "content-type": "application/json" },
		},
	);
};

// Bun augments fetch with nonstandard helpers, so replace the property instead
// of assigning a narrower test function to its enriched TypeScript type.
Object.defineProperty(globalThis, "fetch", {
	configurable: true,
	writable: true,
	value: mockFetch,
});

/**
 * Node preload used by the full-pipeline acceptance test.
 *
 * It replaces only the external HTTP boundary. The orchestrator, Turnlock
 * protocol, bridge CLI, result persistence, resume command, and Git publisher
 * all run as production code in separate Node processes.
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
	const requestBody = JSON.parse(String(init?.body)) as {
		messages?: Array<{ role?: string; content?: string }>;
	};
	const userPrompt =
		requestBody.messages?.find((message) => message.role === "user")?.content ??
		"";

	let responseContent: string;
	if (isInitialResponse) {
		responseContent = JSON.stringify([
			{
				commit: {
					type: "feat",
					description:
						"complete the delegated v2 pipeline with durable retry processing support",
					isBreaking: false,
				},
				files: ["pipeline.ts"],
			},
		]);
	} else {
		if (userPrompt.includes("pipelineVersion = 2")) {
			throw new Error("Validation repair prompt leaked the full Git diff");
		}
		if (!userPrompt.includes("72") || !userPrompt.includes("planIndex")) {
			throw new Error(
				"Validation repair prompt omitted structured constraints",
			);
		}
		responseContent = JSON.stringify([
			{
				planIndex: 0,
				commit: {
					type: "feat",
					description: "complete v2 pipeline",
					isBreaking: false,
				},
			},
		]);
	}

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
						content: responseContent,
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

// Replace the property so the test function can keep a deliberately narrow
// signature while intercepting only the external HTTP boundary.
Object.defineProperty(globalThis, "fetch", {
	configurable: true,
	writable: true,
	value: mockFetch,
});

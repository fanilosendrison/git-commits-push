const OPENAI_COMPLETIONS_ENDPOINT =
	"https://api.openai.com/v1/chat/completions";

function resolveRequestUrl(input) {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

async function mockFetch(input, init) {
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
	const requestBody = JSON.parse(String(init?.body ?? "null"));
	const userPrompt =
		requestBody.messages?.find((message) => message.role === "user")?.content ??
		"";
	if (!userPrompt.includes("README.md")) {
		throw new Error("Unborn-repository prompt omitted the staged README.md");
	}

	return new Response(
		JSON.stringify({
			choices: [
				{
					finish_reason: "stop",
					index: 0,
					message: {
						content: JSON.stringify([
							{
								commit: {
									description: "create initial project documentation",
									isBreaking: false,
									type: "docs",
								},
								files: ["README.md"],
							},
						]),
						role: "assistant",
					},
				},
			],
			created: 0,
			id: "compiled-unborn-repository",
			model: "gpt-5.4-mini",
			object: "chat.completion",
			usage: {
				completion_tokens: 1,
				prompt_tokens: 1,
				total_tokens: 2,
			},
		}),
		{
			headers: { "content-type": "application/json" },
			status: 200,
		},
	);
}

Object.defineProperty(globalThis, "fetch", {
	configurable: true,
	value: mockFetch,
	writable: true,
});

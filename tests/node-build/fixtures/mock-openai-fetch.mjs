import { appendFileSync } from "node:fs";

const OPENAI_COMPLETIONS_ENDPOINT =
	"https://api.openai.com/v1/chat/completions";
let completionCallCount = 0;

function resolveRequestUrl(input) {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

function recordRequest(callNumber, requestBody) {
	const logPath = process.env.MOCK_LLM_REQUEST_LOG;
	if (!logPath) throw new Error("MOCK_LLM_REQUEST_LOG is required");
	appendFileSync(
		logPath,
		`${JSON.stringify({
			callNumber,
			messageCount: Array.isArray(requestBody?.messages)
				? requestBody.messages.length
				: 0,
			model: requestBody?.model,
		})}\n`,
	);
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
	const callNumber = completionCallCount + 1;
	recordRequest(callNumber, requestBody);
	completionCallCount = callNumber;
	const userPrompt =
		requestBody.messages?.find((message) => message.role === "user")?.content ??
		"";
	const responseContent =
		callNumber === 1
			? JSON.stringify([
					{
						commit: {
							description: "Complete compiled bare remote pipeline",
							isBreaking: false,
							type: "feat",
						},
						files: ["pipeline.ts"],
					},
				])
			: JSON.stringify([
					{
						planIndex: 0,
						commit: {
							description: "complete compiled bare remote pipeline",
							isBreaking: false,
							type: "feat",
						},
					},
				]);
	if (callNumber > 1 && userPrompt.includes("compiledPipeline = true")) {
		throw new Error("Compiled repair prompt leaked the full Git diff");
	}

	return new Response(
		JSON.stringify({
			choices: [
				{
					finish_reason: "stop",
					index: 0,
					message: {
						content: responseContent,
						role: "assistant",
					},
				},
			],
			created: 0,
			id: `compiled-bare-remote-${callNumber}`,
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

/**
 * Node preload — deterministic reconciliation E2E LLM mock.
 *
 * Replaces only the external LLM HTTP boundary. Plan generation is derived
 * from the staged diff in the request body, so every repo receives a valid
 * Conventional Commit plan for exactly the files it staged.
 *
 * Environment:
 *   MOCK_LLM_REQUEST_LOG       (required) append one JSON line per LLM call
 *   MOCK_LLM_FIRST_CALL_MARKER (optional) written when the first LLM request is observed
 *   MOCK_LLM_RELEASE_FILE      (optional) block the first request until this file exists
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

const OPENAI_COMPLETIONS_ENDPOINT =
	"https://api.openai.com/v1/chat/completions";

function resolveRequestUrl(input) {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

function extractDiffFiles(messages) {
	const files = new Set();
	for (const message of messages ?? []) {
		if (typeof message?.content !== "string") continue;
		for (const match of message.content.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
			if (match[1]) files.add(match[1]);
		}
	}
	return [...files].sort();
}

function buildCompletionPlan(files) {
	if (files.length === 0) {
		throw new Error("Reconciler mock could not derive files from the diff");
	}
	return {
		commit: {
			type: "feat",
			description: `publish ${files.join(" ")}`,
			isBreaking: false,
		},
		files,
	};
}

async function waitForReleaseFile() {
	while (!existsSync(process.env.MOCK_LLM_RELEASE_FILE)) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
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
	const files = extractDiffFiles(requestBody?.messages);
	if (!process.env.MOCK_LLM_REQUEST_LOG) {
		throw new Error("MOCK_LLM_REQUEST_LOG is required");
	}
	appendFileSync(
		process.env.MOCK_LLM_REQUEST_LOG,
		`${JSON.stringify({
			files,
			model: requestBody?.model,
		})}\n`,
	);

	if (process.env.MOCK_LLM_RELEASE_FILE) {
		if (
			process.env.MOCK_LLM_FIRST_CALL_MARKER &&
			!existsSync(process.env.MOCK_LLM_FIRST_CALL_MARKER)
		) {
			writeFileSync(
				process.env.MOCK_LLM_FIRST_CALL_MARKER,
				"first LLM request observed\n",
			);
		}
		await waitForReleaseFile();
	}

	return new Response(
		JSON.stringify({
			choices: [
				{
					finish_reason: "stop",
					index: 0,
					message: {
						content: JSON.stringify([buildCompletionPlan(files)]),
						role: "assistant",
					},
				},
			],
			created: 0,
			id: `reconciler-mock-${files.join("-")}`,
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

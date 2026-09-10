import http from "node:http";
import https from "node:https";

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
	if (files.length === 0) throw new Error("overlap mock found no diff files");
	return {
		commit: {
			type: "feat",
			description: `publish ${files.join(" ")}`,
			isBreaking: false,
		},
		files,
	};
}

function waitAtParentBarrier(payload, signal) {
	const target = new URL(process.env.GCP_TEST_LLM_SERVER_URL);
	const transport = target.protocol === "https:" ? https : http;
	return new Promise((resolve, reject) => {
		const body = JSON.stringify(payload);
		const request = transport.request(
			target,
			{
				headers: {
					"content-length": Buffer.byteLength(body),
					"content-type": "application/json",
				},
				method: "POST",
			},
			(response) => {
				response.resume();
				response.once("end", () => {
					if (response.statusCode !== 200) {
						reject(
							new Error(`test LLM barrier returned ${response.statusCode}`),
						);
						return;
					}
					resolve();
				});
			},
		);
		request.once("error", reject);
		if (signal) {
			const abort = () => request.destroy(new Error("LLM request aborted"));
			signal.addEventListener("abort", abort, { once: true });
			request.once("close", () => signal.removeEventListener("abort", abort));
		}
		request.end(body);
	});
}

let signalResistanceInstalled = false;

async function mockFetch(input, init) {
	if (
		process.env.GCP_TEST_LLM_IGNORE_SIGTERM === "1" &&
		!signalResistanceInstalled
	) {
		signalResistanceInstalled = true;
		process.on("SIGTERM", () => {});
	}
	const requestUrl = resolveRequestUrl(input);
	if (requestUrl !== OPENAI_COMPLETIONS_ENDPOINT) {
		throw new Error(`Unexpected LLM endpoint: ${requestUrl}`);
	}
	if (!process.env.GCP_TEST_LLM_SERVER_URL) {
		throw new Error("GCP_TEST_LLM_SERVER_URL is required");
	}
	const executionToken = process.env.GCP_ACTIVE_EXECUTION_TOKEN;
	if (!executionToken) throw new Error("active execution token is unavailable");
	const requestBody = JSON.parse(String(init?.body ?? "null"));
	const files = extractDiffFiles(requestBody?.messages);
	await waitAtParentBarrier(
		{ executionToken, files, model: requestBody?.model },
		init?.signal,
	);
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
			id: `overlap-mock-${files.join("-")}`,
			model: "gpt-5.4-mini",
			object: "chat.completion",
			usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
		}),
		{ headers: { "content-type": "application/json" }, status: 200 },
	);
}

Object.defineProperty(globalThis, "fetch", {
	configurable: true,
	value: mockFetch,
	writable: true,
});

import "./synthetic-context-injection.mjs";
import { appendFileSync, readFileSync } from "node:fs";

// Inject the explicit synthetic context oracle and replace the provider HTTP boundary. Fixture plans are explicit test data,
// never inferred from the production implementation's membership calculation.
globalThis.fetch = async (input) => {
	const url =
		typeof input === "string"
			? input
			: input instanceof URL
				? input.href
				: input.url;
	if (url !== "https://api.openai.com/v1/chat/completions")
		throw new Error("Unexpected fixture transport.");
	const log = process.env.MOCK_LLM_REQUEST_LOG;
	const batches = JSON.parse(process.env.GCP_COMPLETENESS_PLANS);
	let count = 0;
	try {
		count = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length;
	} catch {}
	const plans = batches[Math.min(count, batches.length - 1)];
	appendFileSync(log, `${JSON.stringify({ plans })}\n`);
	return new Response(
		JSON.stringify({
			id: "completeness-fixture",
			object: "chat.completion",
			created: 0,
			model: "gpt-5.4-mini",
			choices: [
				{
					index: 0,
					finish_reason: "stop",
					message: { role: "assistant", content: JSON.stringify(plans) },
				},
			],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
};

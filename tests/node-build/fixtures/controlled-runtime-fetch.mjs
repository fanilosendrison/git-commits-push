import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import promises from "node:fs/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const release = process.env.GCP_CONTROLLED_RELEASE;
const source = process.env.GCP_FORBIDDEN_SOURCE;
const stateFile = process.env.GCP_CONTROLLED_STATE;
assert.ok(release && source && stateFile);
const read = fs.readFileSync;
const write = fs.writeFileSync;
const realpath = fs.realpathSync;
const config = JSON.parse(read(stateFile, "utf8"));
function rejectSource(file) {
	const name = file instanceof URL ? fileURLToPath(file) : String(file);
	if (name === source || name.startsWith(`${source}${path.sep}`))
		throw new Error(
			"Installed runtime attempted to read its unavailable source/distribution checkout",
		);
}
fs.readFileSync = (file, ...args) => {
	rejectSource(file);
	return read(file, ...args);
};
const readAsync = promises.readFile;
promises.readFile = (file, ...args) => {
	rejectSource(file);
	return readAsync(file, ...args);
};
syncBuiltinESMExports();
registerHooks({
	load(url, context, nextLoad) {
		if (url.startsWith("file:")) {
			const file = realpath(fileURLToPath(url));
			assert.ok(
				file.startsWith(`${release}${path.sep}`),
				"Production module escaped installed release",
			);
		}
		return nextLoad(url, context);
	},
});

globalThis.fetch = async (input, init) => {
	const url = new URL(
		typeof input === "string"
			? input
			: input instanceof URL
				? input.href
				: input.url,
	);
	const google = url.hostname === "generativelanguage.googleapis.com";
	assert.ok(google || url.hostname === "api.mistral.ai");
	assert.equal(init.method, "POST");
	assert.equal(typeof init.body, "string");
	const body = JSON.parse(init.body);
	const model = google
		? decodeURIComponent(
				url.pathname.split("/models/")[1].replace(":generateContent", ""),
			)
		: body.model;
	assert.equal(
		google ? body.generationConfig.maxOutputTokens : body.max_tokens,
		4096,
	);
	const user = google
		? body.contents
				.flatMap((m) => m.parts)
				.map((p) => p.text)
				.join("\n")
		: body.messages.find((m) => m.role === "user").content;
	const header = JSON.parse(
		user.split("\n")[0].slice("AUTHORITATIVE_PARTITION ".length),
	);
	assert.equal(header.H0, config.base);
	assert.equal(header.T, config.tree);
	for (const file of header.paths) assert.ok(config.paths.includes(file));
	const head = execFileSync(
		"git",
		["-C", config.repository, "rev-parse", "HEAD"],
		{ encoding: "utf8" },
	).trim();
	assert.equal(head, config.base, "No first commit before complete aggregate");
	const state = JSON.parse(read(stateFile, "utf8"));
	state.calls.push({
		model,
		paths: header.paths,
		wireBytes: Buffer.byteLength(init.body),
	});
	write(stateFile, JSON.stringify(state));
	if (
		config.scenario === "fallback" &&
		model === "primary" &&
		state.calls.filter((c) => c.model === "primary").length > 1
	)
		return new Response('{"error":{"message":"synthetic outage"}}', {
			status: 503,
		});
	if (
		(config.scenario === "overflow" ||
			(config.scenario === "fallback" && model === "smaller")) &&
		header.paths.length > 1
	)
		return new Response('{"code":"invalid_request_prompt_too_long"}', {
			status: 400,
		});
	const plan = JSON.stringify([
		{
			commit: {
				type: "fix",
				description: "preserve controlled runtime changes",
				isBreaking: false,
			},
			files: header.paths,
		},
	]);
	const content =
		config.scenario === "malformed"
			? [{ type: "text", text: 7 }]
			: config.scenario === "string"
				? plan
				: [
						{
							type: "thinking",
							thinking: [{ type: "text", text: "PRIVATE_REASONING_SENTINEL" }],
						},
						{ type: "text", text: plan },
					];
	return new Response(
		JSON.stringify(
			google
				? {
						candidates: [
							{ content: { parts: [{ text: plan }] }, finishReason: "STOP" },
						],
					}
				: { choices: [{ message: { content }, finish_reason: "stop" }], model },
		),
		{ status: 200 },
	);
};

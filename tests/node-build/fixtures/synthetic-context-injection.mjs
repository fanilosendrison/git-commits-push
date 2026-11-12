import { realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Explicit test-only dependency facade. Installed files and all admission/dispatch
// functions remain original; only the authority binding is synthetic. Normal
// production has neither this preload nor a job/settings profile-injection hook.
const entry = process.argv[1];
if (entry && path.basename(entry) === "turnlock-to-llm-bridge.js") {
	const target = pathToFileURL(
		realpathSync(
			path.resolve(path.dirname(entry), "../modules/llm/context-admission.js"),
		),
	).href;
	const oracle = new URL("../context-profile-fixture.mjs", import.meta.url)
		.href;
	registerHooks({
		load(url, context, nextLoad) {
			if (url !== target) return nextLoad(url, context);
			return {
				format: "module",
				shortCircuit: true,
				source:
					`export * from ${JSON.stringify(`${target}?original-admission`)};\n` +
					`import { syntheticCompiledAuthority } from ${JSON.stringify(oracle)};\n` +
					"export const productionContextAuthority = syntheticCompiledAuthority();\n",
			};
		},
	});
}

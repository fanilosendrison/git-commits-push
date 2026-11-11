import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { activateGitExecutableForProcess } from "../git/git-executable.ts";
import {
	type ControlledStepResult,
	runControlledStep,
} from "./controlled-step.ts";

export const QUALIFICATION_COMMANDS = Object.freeze([
	"typecheck",
	"typecheck:node",
	"typecheck:node:stats",
	"lint",
	"test",
	"test:node:build",
	"test:node:stats",
] as const);
// The old contributor controller used this bound but killed only its direct child.
export const QUALIFICATION_TIMEOUT_MS = 3 * 60 * 60 * 1000;

/** Run the prescribed suite with platform Git and lifetime-bound process cleanup. */
export async function runQualification(): Promise<boolean> {
	if (!process.env.GCP_QUALIFY_LEGACY_RELEASES?.trim()) {
		throw new Error(
			"Full qualification requires explicit historical-release fixture inputs; an optional skip is not qualification.",
		);
	}
	if (process.env.PI_SKILL_STATS_MODE === "test") {
		throw new Error(
			"Qualification must not globally override test identity or suppress telemetry oracles.",
		);
	}
	const root = path.resolve(import.meta.dirname, "../../..");
	const state = path.join(root, ".state");
	mkdirSync(state, { recursive: true, mode: 0o700 });
	const output = mkdtempSync(path.join(state, "qualification-"));
	const git = activateGitExecutableForProcess();
	const abort = new AbortController();
	const timer = setTimeout(
		() => abort.abort("QUALIFICATION_TIMEOUT"),
		QUALIFICATION_TIMEOUT_MS,
	);
	const interrupt = () => abort.abort("SIGINT");
	const terminate = () => abort.abort("SIGTERM");
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", terminate);
	const records: Array<{
		command: string;
		seconds: number;
		result: ControlledStepResult | null;
		error: string | null;
	}> = [];
	let success = false;
	try {
		writeFileSync(
			path.join(output, "source.json"),
			`${JSON.stringify({
				head: execFileSync("git", ["rev-parse", "HEAD"], {
					cwd: root,
					encoding: "utf8",
				}).trim(),
				gitExecutable: git.executable,
				watchdogMs: QUALIFICATION_TIMEOUT_MS,
			})}\n`,
			{ mode: 0o600 },
		);
		process.stdout.write(`Qualification evidence: ${output}\n`);
		for (const command of QUALIFICATION_COMMANDS) {
			if (abort.signal.aborted) break;
			const started = performance.now();
			let result: ControlledStepResult | null = null;
			let error: string | null = null;
			try {
				result = await runControlledStep({
					command: "pnpm",
					args: ["run", command],
					cwd: root,
					outputDirectory: path.join(output, command.replaceAll(":", "-")),
					signal: abort.signal,
				});
			} catch (failure) {
				error = failure instanceof Error ? failure.name : "UNKNOWN_FAILURE";
			}
			records.push({
				command,
				seconds: (performance.now() - started) / 1000,
				result,
				error,
			});
			writeFileSync(
				path.join(output, "results.json"),
				`${JSON.stringify({ complete: false, records }, null, 2)}\n`,
				{ mode: 0o600 },
			);
			process.stdout.write(
				`${result?.success ? "PASS" : "FAIL"} pnpm run ${command}\n`,
			);
			if (!result?.success) break;
		}
		success =
			!abort.signal.aborted &&
			records.length === QUALIFICATION_COMMANDS.length &&
			records.every(
				(record) => record.error === null && record.result?.success,
			);
		return success;
	} finally {
		clearTimeout(timer);
		process.removeListener("SIGINT", interrupt);
		process.removeListener("SIGTERM", terminate);
		git.restore();
		writeFileSync(
			path.join(output, "results.json"),
			`${JSON.stringify(
				{
					complete: success,
					aborted: abort.signal.aborted,
					abortReason:
						typeof abort.signal.reason === "string"
							? abort.signal.reason
							: null,
					records,
				},
				null,
				2,
			)}\n`,
			{ mode: 0o600 },
		);
	}
}

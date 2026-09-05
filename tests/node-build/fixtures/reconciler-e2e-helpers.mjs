import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function withTemporaryDirectory(callback) {
	const directory = await mkdtemp(path.join(tmpdir(), "reconciler-e2e-é-"));
	try {
		await callback(directory);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}

export function isolatedEnvironment(root) {
	return {
		...process.env,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		HOME: path.join(root, "isolated home"),
		XDG_CONFIG_HOME: path.join(root, "isolated config"),
	};
}

export function runGit(cwd, args, environment) {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: environment,
		shell: false,
	});
	assert.equal(
		result.status,
		0,
		`git ${args.join(" ")} failed: ${result.stderr}`,
	);
	return result.stdout.trim();
}

export async function readJsonLines(filePath) {
	if (!existsSync(filePath)) return [];
	return (await readFile(filePath, "utf8"))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

export function protocolActions(stdout) {
	return [...stdout.matchAll(/@@TURNLOCK@@\n([\s\S]*?)@@END@@/g)].map(
		(match) => {
			const actionLine = match[1]
				?.split("\n")
				.find((line) => line.startsWith("action: "));
			return actionLine?.slice("action: ".length) ?? "missing";
		},
	);
}

export function nonProtocolBytes(stdout) {
	return stdout.replace(/@@TURNLOCK@@[\s\S]*?@@END@@/g, "").replace(/\s/g, "");
}

export async function waitForFile(filePath, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(filePath)) {
		assert.ok(Date.now() < deadline, `timed out waiting for ${filePath}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

export function waitForClose(child) {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve(child.exitCode);
	}
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve(code));
	});
}

export async function waitForRunCompletion(runsDirectory, expectedRuns) {
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		const entries = existsSync(runsDirectory)
			? await readdir(runsDirectory, { withFileTypes: true })
			: [];
		const runs = entries.filter((entry) => entry.isDirectory());
		if (runs.length !== expectedRuns) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			continue;
		}
		let allTerminal = true;
		for (const run of runs) {
			const eventsPath = path.join(runsDirectory, run.name, "events.ndjson");
			if (!existsSync(eventsPath)) {
				allTerminal = false;
				continue;
			}
			const lines = (await readFile(eventsPath, "utf8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			if (lines.at(-1)?.eventType !== "orchestrator_end") {
				allTerminal = false;
			}
		}
		if (allTerminal) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.fail("Turnlock runs did not reach terminal state in time");
}

export async function createRepoWithBareRemote(
	repositoryPath,
	bareRemotePath,
	environment,
) {
	await mkdir(repositoryPath, { recursive: true });
	await mkdir(bareRemotePath, { recursive: true });
	runGit(bareRemotePath, ["init", "--bare", "--quiet"], environment);
	runGit(repositoryPath, ["init", "--quiet"], environment);
	runGit(
		repositoryPath,
		["config", "user.name", "Reconciler E2E"],
		environment,
	);
	runGit(
		repositoryPath,
		["config", "user.email", "reconciler-e2e@example.invalid"],
		environment,
	);
	await writeFile(path.join(repositoryPath, "README.md"), "initial\n");
	runGit(repositoryPath, ["add", "README.md"], environment);
	runGit(
		repositoryPath,
		["commit", "--quiet", "--no-verify", "-m", "initial"],
		environment,
	);
	runGit(
		repositoryPath,
		["remote", "add", "origin", bareRemotePath],
		environment,
	);
	runGit(
		repositoryPath,
		["push", "--quiet", "--set-upstream", "origin", "HEAD"],
		environment,
	);
}

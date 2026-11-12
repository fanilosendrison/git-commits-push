import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

const requestSchema = z
	.object({
		command: z.string().min(1),
		args: z.array(z.string()),
		cwd: z.string().min(1),
		receipt: z.string().min(1),
		stdout: z.string().min(1),
		stderr: z.string().min(1),
	})
	.strict();
const request = requestSchema.parse(
	JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")),
);
const stdout = openSync(request.stdout, "wx", 0o600);
const stderr = openSync(request.stderr, "wx", 0o600);
const child = spawn(request.command, request.args, {
	cwd: request.cwd,
	env: process.env,
	stdio: ["ignore", stdout, stderr],
	shell: false,
	detached: false,
});
const outcome = await new Promise<{
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	spawnError: string | null;
}>((resolve) => {
	child.once("error", (error) =>
		resolve({ exitCode: null, signal: null, spawnError: error.name }),
	);
	child.once("exit", (exitCode, signal) =>
		resolve({ exitCode, signal, spawnError: null }),
	);
});
closeSync(stdout);
closeSync(stderr);
// The maintained execution controller remains the live PGID anchor until cleanup.
const inspection = spawnSync("/bin/ps", ["-axo", "pid=,pgid="], {
	encoding: "utf8",
	env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
	timeout: 10_000,
});
let residual: number[] | null = null;
if (!inspection.error && inspection.status === 0 && inspection.stdout.trim()) {
	const entries = inspection.stdout
		.trim()
		.split("\n")
		.map((line) => line.trim().split(/\s+/u));
	if (
		entries.every(
			(fields) =>
				fields.length === 2 && fields.every((field) => /^[0-9]+$/u.test(field)),
		)
	) {
		residual = entries
			.map(([pid, group]) => [Number(pid), Number(group)])
			.filter(
				([pid, group]) =>
					group === process.ppid &&
					pid !== process.ppid &&
					pid !== process.pid &&
					pid !== inspection.pid,
			)
			.map(([pid]) => pid as number);
	}
}
writeFileSync(
	request.receipt,
	`${JSON.stringify({ ...outcome, residual })}\n`,
	{ mode: 0o600 },
);
process.exitCode =
	outcome.exitCode === 0 &&
	outcome.signal === null &&
	outcome.spawnError === null &&
	residual !== null &&
	residual.length === 0
		? 0
		: 1;

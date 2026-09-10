import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";

/** ESRCH means absent; EPERM proves that the process exists. */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Boot epoch is retained as diagnostic metadata, not as liveness authority. */
export function currentBootEpochMs(): number {
	return Date.now() - Math.floor(os.uptime() * 1000);
}

/** Read a process-birth identity without invoking a shell. */
export function readProcessStartIdentity(pid: number): string | null {
	if (!Number.isSafeInteger(pid) || pid <= 0) return null;
	try {
		if (process.platform === "linux") {
			const bootId = fs
				.readFileSync("/proc/sys/kernel/random/boot_id", "utf8")
				.trim();
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8").trim();
			const fieldsAfterCommand = stat
				.slice(stat.lastIndexOf(")") + 2)
				.split(" ");
			const startTicks = fieldsAfterCommand[19];
			return bootId && startTicks ? `linux-proc:${bootId}:${startTicks}` : null;
		}
		const processRecord = execFileSync(
			"/bin/ps",
			["-p", String(pid), "-o", "lstart=", "-o", "command="],
			{
				encoding: "utf8",
				env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
				stdio: ["ignore", "pipe", "ignore"],
			},
		).trim();
		return processRecord ? `ps-process:${processRecord}` : null;
	} catch {
		return null;
	}
}

/** Add a unique, non-secret launch marker before reading this process identity. */
export function establishCurrentProcessIdentity(nonce: string): string | null {
	if (!nonce.trim()) return null;
	process.title = `git-commits-push-${nonce}`;
	return readProcessStartIdentity(process.pid);
}

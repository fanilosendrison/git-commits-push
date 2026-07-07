import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

function resolveHome(filepath: string): string {
	if (filepath.startsWith("~")) {
		return path.join(os.homedir(), filepath.slice(1));
	}
	return filepath;
}

function getStateDir(): string {
	if (process.env.ORDER_STATE_DIR) {
		return resolveHome(process.env.ORDER_STATE_DIR);
	}
	return path.join(import.meta.dir, "../../.state/orders");
}

export function checkAndAcquireLock(runId: string, callerName: string): "ACQUIRED" | "QUEUED" {
	const dir = getStateDir();
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}

	const lockPath = path.join(dir, "running.lock");

	if (fs.existsSync(lockPath)) {
		let lockContent: { runId: string; callerName: string; timestamp: number };
		try {
			lockContent = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
		} catch {
			// Malformed lock file -> treat as stale
			writeLock(lockPath, runId, callerName);
			return "ACQUIRED";
		}

		if (lockContent.runId === runId) {
			return "ACQUIRED";
		}

		const stat = fs.statSync(lockPath);
		const ageMs = Date.now() - stat.mtimeMs;

		if (ageMs > 40000) {
			// Stale lock: clean up old lock and any stale queues
			try {
				fs.unlinkSync(lockPath);
				const files = fs.readdirSync(dir);
				for (const f of files) {
					if (f.startsWith("order-") && f.endsWith(".flag")) {
						fs.unlinkSync(path.join(dir, f));
					}
				}
			} catch {
				// ignore race conditions during deletion
			}

			writeLock(lockPath, runId, callerName);
			return "ACQUIRED";
		}

		// Active lock exists -> queue the order
		const myFlagName = `order-${Date.now()}-${randomUUID()}.flag`;
		const myFlagPath = path.join(dir, myFlagName);
		fs.writeFileSync(myFlagPath, "", "utf-8");

		// Calculate position in queue
		const files = fs.readdirSync(dir);
		const flags = files
			.filter(f => f.startsWith("order-") && f.endsWith(".flag"))
			.map(f => {
				const match = f.match(/^order-(\d+)-(.*)\.flag$/);
				return {
					name: f,
					timestamp: match ? parseInt(match[1]!, 10) : 0,
				};
			})
			.sort((a, b) => a.timestamp - b.timestamp);

		const myIndex = flags.findIndex(f => f.name === myFlagName);
		const position = myIndex !== -1 ? myIndex + 1 : flags.length;

		console.log(`ℹ️ Order registered! A session is already in progress (managed by: 🤖 ${lockContent.callerName}). You are in position ${position} in the queue. Your commits will be pushed asynchronously in the parent session.`);
		return "QUEUED";
	}

	writeLock(lockPath, runId, callerName);
	return "ACQUIRED";
}

function writeLock(lockPath: string, runId: string, callerName: string) {
	fs.writeFileSync(lockPath, JSON.stringify({
		runId,
		callerName,
		timestamp: Date.now()
	}), "utf-8");
}

export function releaseLockAndTriggerNext(runId: string): void {
	const dir = getStateDir();
	const lockPath = path.join(dir, "running.lock");

	if (fs.existsSync(lockPath)) {
		let lockContent: { runId: string };
		try {
			lockContent = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
		} catch {
			return;
		}

		if (lockContent.runId !== runId) {
			return; // Lock does not belong to us
		}

		try {
			fs.unlinkSync(lockPath);
		} catch {
			// ignore
		}
	}

	stopHeartbeat();

	// Trigger next in queue if any
	if (fs.existsSync(dir)) {
		const files = fs.readdirSync(dir);
		const flags = files
			.filter(f => f.startsWith("order-") && f.endsWith(".flag"))
			.map(f => {
				const match = f.match(/^order-(\d+)-(.*)\.flag$/);
				return {
					name: f,
					timestamp: match ? parseInt(match[1]!, 10) : 0,
				};
			})
			.sort((a, b) => a.timestamp - b.timestamp);

		if (flags.length > 0) {
			const oldestFlag = flags[0].name;
			try {
				fs.unlinkSync(path.join(dir, oldestFlag));
			} catch {
				// ignore
			}

			// Spawn next run detached
			const skillRoot = path.resolve(__dirname, "../..");
			const subprocess = spawn("bun", ["run", "start"], {
				cwd: skillRoot,
				detached: true,
				stdio: "ignore"
			});
			subprocess.unref();
		}
	}
}

let heartbeatInterval: Timer | null = null;

export function startHeartbeat(intervalMs = 10000): void {
	if (heartbeatInterval) return;
	const dir = getStateDir();
	const lockPath = path.join(dir, "running.lock");

	heartbeatInterval = setInterval(() => {
		if (fs.existsSync(lockPath)) {
			const now = new Date();
			try {
				fs.utimesSync(lockPath, now, now);
			} catch {
				// ignore
			}
		}
	}, intervalMs);
}

export function stopHeartbeat(): void {
	if (heartbeatInterval) {
		clearInterval(heartbeatInterval);
		heartbeatInterval = null;
	}
}

export function setupCleanupHooks(runId: string): void {
	const cleanup = () => {
		stopHeartbeat();
		const dir = getStateDir();
		const lockPath = path.join(dir, "running.lock");
		try {
			if (fs.existsSync(lockPath)) {
				const lockContent = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
				if (lockContent.runId === runId) {
					fs.unlinkSync(lockPath);
				}
			}
		} catch {
			// ignore
		}
		process.exit(1);
	};

	process.on("SIGINT", cleanup);
	process.on("uncaughtException", (err) => {
		console.error("Uncaught exception in process:", err);
		cleanup();
	});
}

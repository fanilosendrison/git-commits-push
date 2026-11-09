import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";

export interface InstallLockEvent {
	readonly type: string;
	readonly pid: number;
	readonly monotonicNs: string;
	readonly [field: string]: unknown;
}

interface ActorExit {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
}

const FIXTURE_DIRECTORY = path.resolve(
	import.meta.dirname,
	"../node-build/fixtures",
);
const PROCESS_OBSERVATION_BOUND_MS = 20_000;

/** Build only a VFS extension; use the Node process's own SQLite engine. */
export function buildInstallLockSchedule(directory: string): string {
	if (process.platform !== "darwin" && process.platform !== "linux") {
		throw new Error(
			"Native installer-lock scheduling requires Linux or macOS.",
		);
	}
	const library = path.join(directory, "install-lock-schedule.so");
	const result = spawnSync(
		"cc",
		[
			...(process.platform === "darwin"
				? ["-dynamiclib"]
				: ["-shared", "-fPIC"]),
			path.join(FIXTURE_DIRECTORY, "install-lock-schedule.c"),
			"-o",
			library,
		],
		{ encoding: "utf8", shell: false, timeout: PROCESS_OBSERVATION_BOUND_MS },
	);
	if (result.status !== 0) {
		throw new Error(`Cannot build SQLite VFS test fixture: ${result.stderr}`, {
			cause: result.error,
		});
	}
	return library;
}

/** Real child lifetime, bounded observations, and diagnostic-only VFS control. */
export class InstallLockProcess {
	readonly child;
	readonly events: InstallLockEvent[] = [];
	readonly nativeEvents: string[] = [];
	readonly result: Promise<ActorExit>;
	stderr = "";
	private readonly changes = new EventEmitter();
	private exit: ActorExit | undefined;

	constructor(
		moduleUrl: string,
		lockPath: string,
		schedule?: { readonly library: string; readonly role: "A" | "B" },
	) {
		this.child = spawn(
			process.execPath,
			[
				path.join(FIXTURE_DIRECTORY, "install-lock-actor.mjs"),
				moduleUrl,
				lockPath,
				...(schedule ? [schedule.library] : []),
			],
			{
				stdio: ["ignore", "pipe", "pipe", "ipc", "pipe", "pipe"],
				env: {
					...process.env,
					...(schedule ? { GCP_TEST_LOCK_ROLE: schedule.role } : {}),
				},
			},
		);
		this.child.stdout?.resume();
		this.child.stderr?.on("data", (chunk: Buffer) => {
			this.stderr += chunk.toString();
		});
		this.child.on("error", (error) => {
			this.stderr += error.message;
		});
		this.child.on("message", (message: unknown) => {
			if (
				typeof message !== "object" ||
				message === null ||
				!("type" in message) ||
				typeof message.type !== "string" ||
				!("pid" in message) ||
				typeof message.pid !== "number" ||
				!("monotonicNs" in message) ||
				typeof message.monotonicNs !== "string"
			) {
				this.stderr += "Invalid fixture IPC message";
				return;
			}
			this.events.push(message as InstallLockEvent);
			this.changes.emit("change");
		});
		const control = this.child.stdio[4];
		control?.on("error", (error: Error) => {
			this.stderr += error.message;
		});
		let pending = "";
		this.child.stdio.at(5)?.on("data", (chunk: Buffer) => {
			pending += chunk.toString();
			for (;;) {
				const end = pending.indexOf("\n");
				if (end < 0) break;
				const line = pending.slice(0, end);
				pending = pending.slice(end + 1);
				this.nativeEvents.push(line);
				this.changes.emit("native", line);
				this.changes.emit("change");
			}
		});
		this.result = new Promise((resolve) => {
			this.child.once("close", (code, signal) => {
				this.exit = { code, signal };
				resolve(this.exit);
				this.changes.emit("change");
			});
		});
	}

	send(command: "acquire" | "release"): void {
		this.child.send(command);
	}

	permitNative(): void {
		const control = this.child.stdio[4];
		if (!control || !("write" in control))
			throw new Error("Missing VFS control pipe.");
		control.write("G");
	}

	onNative(listener: (line: string) => void): void {
		this.changes.on("native", listener);
	}

	waitFor(type: string): Promise<InstallLockEvent> {
		return this.observe(
			() => this.events.find((event) => event.type === type),
			type,
		);
	}

	waitForNative(fragment: string): Promise<string> {
		return this.observe(
			() => this.nativeEvents.find((line) => line.includes(fragment)),
			fragment,
		);
	}

	private observe<T>(scan: () => T | undefined, label: string): Promise<T> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() =>
					finish(new Error(`Timed out waiting for ${label}: ${this.stderr}`)),
				PROCESS_OBSERVATION_BOUND_MS,
			);
			const finish = (error?: Error, event?: T): void => {
				clearTimeout(timer);
				this.changes.off("change", check);
				if (error) reject(error);
				else if (event !== undefined) resolve(event);
			};
			const check = (): void => {
				const event = scan();
				if (event !== undefined) finish(undefined, event);
				else if (this.exit)
					finish(
						new Error(
							`Fixture exited before ${label}: ${JSON.stringify(this.exit)} ${this.stderr}`,
						),
					);
			};
			this.changes.on("change", check);
			check();
		});
	}

	async terminate(): Promise<void> {
		if (this.exit) return;
		this.child.kill("SIGKILL");
		await this.waitForExit();
	}

	waitForExit(): Promise<ActorExit> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Fixture did not exit.")),
				PROCESS_OBSERVATION_BOUND_MS,
			);
			void this.result.then((result) => {
				clearTimeout(timer);
				resolve(result);
			});
		});
	}
}

/** Force the observed RESERVED/SHARED crossing without sleeps or fake BUSY. */
export function crossInstallLockPromotions(
	a: InstallLockProcess,
	b: InstallLockProcess,
): void {
	a.onNative((line) => {
		if (line.includes(" FIRST_RESERVED ")) b.send("acquire");
		if (line.includes(" EXCLUSIVE_BUSY ")) {
			b.permitNative();
			a.permitNative();
		}
	});
	b.onNative((line) => {
		if (line.includes(" RESERVED_BUSY ")) a.permitNative();
	});
	a.send("acquire");
}

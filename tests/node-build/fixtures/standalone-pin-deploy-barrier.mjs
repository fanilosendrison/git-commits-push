import { spawnSync } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const control = JSON.parse(
	await readFile(process.env.GCP_PIN_TEST_CONTROL, "utf8"),
);
const result = spawnSync(
	process.execPath,
	[control.pnpmCliPath, ...process.argv.slice(2)],
	{
		env: process.env,
		stdio: "inherit",
		shell: false,
	},
);
if (result.status !== 0 || result.signal !== null)
	process.exit(result.status ?? 1);
await writeFile(
	control.ready,
	JSON.stringify({
		target: process.argv.at(-1),
		pid: process.pid,
		parentPid: process.ppid,
	}),
);
const deadline = performance.now() + 60_000;
for (;;) {
	try {
		await access(control.proceed);
		break;
	} catch {}
	if (performance.now() >= deadline)
		throw new Error("Deployment barrier was not released");
	await delay(10);
}

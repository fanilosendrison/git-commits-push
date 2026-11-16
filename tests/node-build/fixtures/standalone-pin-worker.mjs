import { access, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const job = JSON.parse(await readFile(process.argv[3], "utf8"));
const { installStandalone } = await import(process.argv[2]);
const options = { ...job.options, environment: process.env };
// Attach both handlers immediately, including while waiting for a barrier.
const outcome = installStandalone(options).then(
	(result) => ({ ok: true, releaseName: result.releaseName }),
	(error) => ({ ok: false, error: error.message }),
);
if (job.nextExpectedReleaseName !== undefined) {
	const deadline = performance.now() + 60_000;
	for (;;) {
		try {
			await access(job.ready);
			break;
		} catch {}
		if (performance.now() >= deadline)
			throw new Error("Worker did not reach deployment barrier");
		await delay(10);
	}
	options.expectedReleaseName = job.nextExpectedReleaseName;
	await writeFile(job.proceed, "continue\n");
}
await writeFile(job.result, JSON.stringify(await outcome));

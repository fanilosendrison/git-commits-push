/** Test-only interposition at real pending External Requests and guarded Git ref effects. */
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const mode = process.env.GCP_TEST_MERGE_INTERRUPT;
const marker = process.env.GCP_TEST_MERGE_MARKER;
const originalWrite = fs.writeFileSync;
function pause(boundary) {
	if (!marker) throw new Error("Missing owned interruption marker.");
	originalWrite(marker, JSON.stringify({ pid: process.pid, boundary }));
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
if (
	mode === "before-commit" ||
	mode === "after-commit" ||
	mode === "pending-report"
) {
	const label =
		mode === "before-commit"
			? "prepared-merge-commit"
			: mode === "after-commit"
				? "prepared-merge-publish"
				: "prepared-merge-report";
	const originalRead = fs.readFileSync;
	fs.readFileSync = (file, ...args) => {
		if (String(file).endsWith(`/external-requests/${label}.json`)) pause(mode);
		return originalRead(file, ...args);
	};
}
if (mode === "lost-commit-ack") {
	const originalExec = childProcess.execFileSync;
	childProcess.execFileSync = (file, args, ...options) => {
		const result = originalExec(file, args, ...options);
		if (
			file === "git" &&
			args?.[0] === "update-ref" &&
			args.includes("--no-deref")
		)
			pause(mode);
		return result;
	};
}
syncBuiltinESMExports();

/** Write the reconciliation coalescing notice to standard output. */
export function writeCoalescedMessage(generation) {
	process.stdout.write(
		`Reconciliation requested (generation ${generation}).\n` +
			"Another git-commits-push worker is active.\n" +
			"This terminal can exit; the active worker will perform another global rescan before becoming idle.\n",
	);
}

/** Write the live legacy-worker admission failure. */
export function writeLiveLegacyWorkerMessage() {
	process.stderr.write(
		"git-commits-push: a legacy queue worker (running.lock) appears active.\n" +
			"Refusing to start a competing reconciler. Wait for the legacy worker to finish, then run again;\n" +
			"or remove the lock manually after confirming that no legacy worker is running.\n",
	);
}

/** Write the malformed legacy-lock admission failure. */
export function writeMalformedLegacyLockMessage() {
	process.stderr.write(
		"git-commits-push: legacy queue lock (running.lock) is malformed or unreadable.\n" +
			"Refusing reconciliation because legacy worker liveness cannot be established.\n" +
			"Preserve and inspect the lock before removing it manually.\n",
	);
}

/** Write a generic fail-closed launcher diagnostic. */
export function failClosed(message) {
	process.stderr.write(`git-commits-push: ${message}\n`);
	process.exitCode = 2;
}

const [moduleUrl, lockPath, holdMillisecondsText] = process.argv.slice(2);
if (!moduleUrl || !lockPath) {
	throw new Error("Expected install-lock module URL and lock path.");
}
const { acquireInstallLock, releaseInstallLock } = await import(moduleUrl);
const owner = acquireInstallLock(lockPath);
process.stdout.write(`READY ${owner.recovered ? "recovered" : "fresh"}\n`);
if (holdMillisecondsText === undefined) {
	setInterval(() => {}, 60_000);
} else {
	const holdMilliseconds = Number(holdMillisecondsText);
	if (!Number.isSafeInteger(holdMilliseconds) || holdMilliseconds < 0) {
		throw new Error("Hold duration must be a non-negative integer.");
	}
	setTimeout(() => {
		releaseInstallLock(lockPath, owner);
	}, holdMilliseconds);
}

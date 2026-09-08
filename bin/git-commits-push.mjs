#!/usr/bin/env node

const MINIMUM_NODE_VERSION = Object.freeze({ major: 22, minor: 19, patch: 0 });

export function supportsNodeVersion(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:-|$)/.exec(version);
	if (!match) return false;
	const [, majorText, minorText, patchText] = match;
	const major = Number(majorText);
	const minor = Number(minorText);
	const patch = Number(patchText);
	return (
		major > MINIMUM_NODE_VERSION.major ||
		(major === MINIMUM_NODE_VERSION.major &&
			(minor > MINIMUM_NODE_VERSION.minor ||
				(minor === MINIMUM_NODE_VERSION.minor &&
					patch >= MINIMUM_NODE_VERSION.patch)))
	);
}

if (!supportsNodeVersion(process.versions.node)) {
	process.stderr.write(
		`git-commits-push requires Node.js >= 22.19.0; found ${process.versions.node}.\n`,
	);
	process.exitCode = 2;
} else {
	const [{ realpathSync }, { fileURLToPath, pathToFileURL }] =
		await Promise.all([import("node:fs"), import("node:url")]);
	const entrypointUrl = pathToFileURL(
		realpathSync(
			fileURLToPath(
				new URL("../dist/src/entrypoints/git-commits-push.js", import.meta.url),
			),
		),
	).href;
	const { runStandaloneCli } = await import(entrypointUrl);
	process.exitCode = await runStandaloneCli(process.argv.slice(2));
}

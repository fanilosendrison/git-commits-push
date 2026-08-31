const [compiledValidatorPath, expectedOutcome = "block"] =
	process.argv.slice(2);
if (!compiledValidatorPath) {
	throw new Error("compiled validator path is required");
}
if (expectedOutcome !== "block" && expectedOutcome !== "warning") {
	throw new Error(`unknown expected scanner outcome: ${expectedOutcome}`);
}

const chunks = [];
for await (const chunk of process.stdin) {
	chunks.push(Buffer.from(chunk));
}
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const { processRepoValidationAndDiff } = await import(compiledValidatorPath);

try {
	await processRepoValidationAndDiff(
		{ id: "compiled-security-repository", path: input.repositoryPath },
		{
			autoPush: false,
			model: "security-fixture-model",
			provider: "security-fixture-provider",
			searchPaths: [input.repositoryPath],
			skipTests: true,
			systemPromptPath: input.systemPromptPath,
			temperature: 0,
		},
	);
	if (expectedOutcome !== "warning") {
		process.stderr.write(
			"compiled secret scanner unexpectedly accepted the diff\n",
		);
		process.exitCode = 7;
	} else {
		process.stderr.write("compiled secret scanner emitted a warning\n");
		process.stdout.write(
			"@@TURNLOCK@@\n" +
				"version: 2\n" +
				"action: DONE\n" +
				"run_id: 01J00000000000000000000011\n" +
				"orchestrator: git-commits-push-tl\n" +
				"output: warning-accepted\n" +
				"success: true\n" +
				"@@END@@\n",
		);
	}
} catch (error) {
	if (
		expectedOutcome !== "block" ||
		!(error instanceof Error) ||
		!error.message.includes("Security Exception")
	) {
		throw error;
	}
	process.stderr.write("compiled secret scanner blocked the repository\n");
	process.stdout.write(
		"@@TURNLOCK@@\n" +
			"version: 2\n" +
			"action: ERROR\n" +
			"run_id: 01J00000000000000000000010\n" +
			"orchestrator: git-commits-push-tl\n" +
			"message: secret-scanner-blocked\n" +
			"@@END@@\n",
	);
}

const [compiledPublisherPath, repositoryPath, expectedDiffHash] =
	process.argv.slice(2);
if (!compiledPublisherPath || !repositoryPath || !expectedDiffHash) {
	throw new Error(
		"publisher path, repository path, and diff hash are required",
	);
}

const { executeMultiCommitAndPush } = await import(compiledPublisherPath);
const { captureValidatedSource } = await import(
	new URL("./validated-source.js", compiledPublisherPath).href
);
await executeMultiCommitAndPush(
	repositoryPath,
	[
		{
			commit: {
				description: "preserve hooks and file modes",
				isBreaking: false,
				type: "test",
			},
			files: ["executable-script.sh", "regular-file.txt"],
		},
	],
	expectedDiffHash,
	{
		autoPush: false,
		model: "security-fixture-model",
		provider: "security-fixture-provider",
		searchPaths: [repositoryPath],
		skipTests: true,
		systemPromptPath: "unused-by-publisher",
		temperature: 0,
	},
	undefined,
	{ witness: captureValidatedSource(repositoryPath, false) },
);

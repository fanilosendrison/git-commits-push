/**
 * src/entrypoints/turnlock-orchestrator.ts — Main entrypoint for the git-commits-push-TL skill.
 * Orchestrates Phase 1-5 via Turnlock state machine.
 */
import * as os from "node:os";
import * as path from "node:path";
import { definePhase, runOrchestrator, type OrchestratorConfig } from "turnlock";
import { stateSchema } from "../config/state-schema.ts";
import { runDiscoveryAndValidationPhase } from "../phases/step1-discovery-validation.ts";
import { runCommitAndPushPhase } from "../phases/step2-commit-push.ts";
import { bootstrapOrchestratorRun } from "../utils/cli-bootstrap.ts";
import type { GlobalState } from "../types.ts";

const config: OrchestratorConfig<GlobalState> = {
	name: "git-commits-push-tl",
	initial: "discovery-and-validation",
	initialState: { repos: {} },
	resumeCommand: (runId) =>
		`bun run src/entrypoints/turnlock-orchestrator.ts --run-id ${runId} --resume`,
	runDirRoot: path.join(os.homedir(), ".turnlock", "runs"),
	stateSchema,
	phases: {
		"discovery-and-validation": definePhase(runDiscoveryAndValidationPhase),
		"commit-and-push": definePhase(runCommitAndPushPhase),
	},
};

if (import.meta.main) {
	bootstrapOrchestratorRun(process.argv.slice(2))
		.then(() => {
			return runOrchestrator(config);
		})
		.then(() => {
			process.exit(0);
		})
		.catch((err) => {
			process.stderr.write(
				`[Fatal Error] ${err instanceof Error ? err.message : String(err)}\n`,
			);
			process.exit(1);
		});
}

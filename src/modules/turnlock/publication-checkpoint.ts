import type {
	BridgeJobPayload,
	PublicationCheckpointPayload,
} from "../../types.ts";
import { writeCommitJobResult } from "./job-result-store.ts";

/** Acknowledge internal durable-publication checkpoints without auth, inference or Git. */
export function acknowledgePublicationCheckpoint(
	payload: BridgeJobPayload,
	job: { readonly id: string; readonly resultPath: string },
): payload is PublicationCheckpointPayload {
	if (
		payload.mode !== "checkpoint-push-only" &&
		payload.mode !== "checkpoint-creation-outcome"
	)
		return false;
	writeCommitJobResult(job.resultPath, {
		success: true,
		id: job.id,
		commits: [],
	});
	return true;
}

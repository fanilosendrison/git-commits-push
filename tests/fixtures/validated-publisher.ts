import { executeMultiCommitAndPush as publish } from "../../src/modules/git/publisher.ts";
import { isTrackedPublicationRequired } from "../../src/modules/git/push.ts";
import { captureValidatedSource } from "../../src/modules/git/validated-source.ts";

/** Legacy publisher fixtures model admission before execution, not a historical resume.
 * Explicit witness/race/recovery tests call the production API directly instead.
 */
export function executeMultiCommitAndPush(
	...args: Parameters<typeof publish>
): ReturnType<typeof publish> {
	const [repository, plans, hash, settings, target, completeness] = args;
	return publish(
		repository,
		plans,
		hash,
		settings,
		target,
		completeness ?? {
			witness: captureValidatedSource(
				repository,
				!!target || isTrackedPublicationRequired(repository, settings.autoPush),
			),
		},
	);
}

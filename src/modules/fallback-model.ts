/**
 * src/modules/fallback-model.ts — Fallback model escalation
 *
 * When the default model exhausts its validation retry budget, the skill can
 * retry with a fallback model before failing.
 */

import type { FeedbackError, Settings } from "../types.ts";

/**
 * Check whether to escalate to the fallback model.
 * Falls back only when:
 *   - fallbackProvider is configured
 *   - error is validation (not structural/race/git/network)
 *   - current attempt count >= max attempts for this kind
 *   - fallback hasn't been attempted yet
 */
export function shouldUseFallback(
	settings: Settings,
	kind: FeedbackError["kind"],
	attemptCount: number,
	fallbackAttempted: boolean,
): boolean {
	if (!settings.fallbackProvider) return false;
	if (kind !== "validation") return false;
	if (fallbackAttempted) return false;
	if (attemptCount < 2) return false; // MAX_ATTEMPTS_BY_KIND.validation
	return true;
}

/**
 * Build settings overridden with the fallback provider/model.
 * Preserves all other settings fields.
 */
export function buildFallbackSettings(settings: Settings): Settings {
	return {
		...settings,
		provider: settings.fallbackProvider!,
		model: settings.fallbackModel!,
	};
}

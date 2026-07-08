import type { FeedbackError, Settings } from "../../types.ts";

export function shouldUseFallback(
	settings: Settings,
	kind: FeedbackError["kind"],
	attemptCount: number,
	fallbackAttempted: boolean,
): boolean {
	if (!settings.fallbackProvider) return false;
	if (kind !== "validation") return false;
	if (fallbackAttempted) return false;
	if (attemptCount < 2) return false;
	return true;
}

export function buildFallbackSettings(settings: Settings): Settings {
	return {
		...settings,
		provider: settings.fallbackProvider!,
		model: settings.fallbackModel!,
	};
}

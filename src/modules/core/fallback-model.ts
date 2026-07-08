import type { FeedbackError, Settings } from "../../types.ts";

export function shouldUseFallback(
	settings: Settings,
	kind: FeedbackError["kind"],
	attemptCount: number,
	fallbackAttempted: boolean,
): boolean {
	if (!settings.fallbackProvider || !settings.fallbackModel) return false;
	if (kind !== "validation") return false;
	if (fallbackAttempted) return false;
	if (attemptCount < 2) return false;
	return true;
}

export function buildFallbackSettings(settings: Settings): Settings {
	const fallbackProvider = settings.fallbackProvider;
	const fallbackModel = settings.fallbackModel;
	if (!fallbackProvider || !fallbackModel) {
		throw new Error(
			"Cannot build fallback settings without fallbackProvider and fallbackModel",
		);
	}
	return {
		...settings,
		provider: fallbackProvider,
		model: fallbackModel,
	};
}

const LAUNCHER_SIGNALS = ["SIGINT", "SIGTERM"] as const;
type LauncherSignal = (typeof LAUNCHER_SIGNALS)[number];

export interface LauncherCancellation {
	readonly signal: AbortSignal;
	readonly interruptedSignal: LauncherSignal | null;
	readonly ownershipFailure: string | null;
	readonly abortForOwnershipFailure: (message: string) => void;
	readonly removeSignalHandlers: () => void;
}

/** Install launcher-level cancellation before durable reconciliation admission. */
export function createLauncherCancellation(): LauncherCancellation {
	let interruptedSignal: LauncherSignal | null = null;
	let ownershipFailure: string | null = null;
	const controller = new AbortController();
	const handlers = new Map<LauncherSignal, () => void>();
	for (const signal of LAUNCHER_SIGNALS) {
		const handler = (): void => {
			interruptedSignal ??= signal;
			if (!controller.signal.aborted) controller.abort(signal);
		};
		handlers.set(signal, handler);
		process.on(signal, handler);
	}
	return {
		signal: controller.signal,
		get interruptedSignal() {
			return interruptedSignal;
		},
		get ownershipFailure() {
			return ownershipFailure;
		},
		abortForOwnershipFailure(message: string): void {
			ownershipFailure ??= message;
			if (!controller.signal.aborted) controller.abort("ownership-lost");
		},
		removeSignalHandlers(): void {
			for (const [signal, handler] of handlers) {
				process.removeListener(signal, handler);
			}
		},
	};
}

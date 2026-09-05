/** Install launcher-level cancellation before durable reconciliation admission. */
export function createLauncherCancellation() {
	let interruptedSignal = null;
	let ownershipFailure = null;
	const controller = new AbortController();
	const handlers = new Map();
	for (const signal of ["SIGINT", "SIGTERM"]) {
		const handler = () => {
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
		abortForOwnershipFailure(message) {
			ownershipFailure ??= message;
			if (!controller.signal.aborted) controller.abort("ownership-lost");
		},
		removeSignalHandlers() {
			for (const [signal, handler] of handlers) {
				process.removeListener(signal, handler);
			}
		},
	};
}

import { registerInstallLockRecoveryTests } from "../fixtures/install-lock-recovery-scenarios.ts";

registerInstallLockRecoveryTests(
	new URL(
		"../../dist/src/modules/installation/install-lock.js",
		import.meta.url,
	).href,
);

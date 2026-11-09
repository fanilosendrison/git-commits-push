import { registerInstallLockRecoveryTests } from "../fixtures/install-lock-recovery-scenarios.ts";

registerInstallLockRecoveryTests(
	new URL("../../src/modules/installation/install-lock.ts", import.meta.url)
		.href,
);

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Qualify the exact source candidate, not a historical hardcoded release version.
export const candidateVersion = JSON.parse(
	readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
).version;
assert.equal(typeof candidateVersion, "string");
const literalVersion = candidateVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const candidateReleasePattern = new RegExp(
	`^${literalVersion}-[a-f0-9]{64}$`,
	"u",
);

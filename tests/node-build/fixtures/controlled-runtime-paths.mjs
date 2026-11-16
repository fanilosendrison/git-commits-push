import path from "node:path";
import { fileURLToPath } from "node:url";

const within = (root, file) =>
	file === root || file.startsWith(`${root}${path.sep}`);

/** Test-only source exclusion; fixture data and installed images are not checkouts. */
export function assertInstalledReadPath(
	file,
	{ source, release, fixture },
	realpath,
) {
	if (typeof file === "number") return;
	const lexical = path.resolve(
		file instanceof URL ? fileURLToPath(file) : String(file),
	);
	let physical;
	try {
		physical = realpath(lexical);
	} catch {
		physical = lexical;
	}
	if (!within(source, lexical) && !within(source, physical)) return;
	for (const allowed of [release, fixture]) {
		if (within(allowed, lexical) && within(allowed, physical)) return;
	}
	throw new Error(
		"Installed runtime attempted to read its unavailable source/distribution checkout",
	);
}

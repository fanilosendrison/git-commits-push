import { access, realpath } from "node:fs/promises";
import path from "node:path";

/** Resolve one executable from PATH without invoking a shell. */
export async function resolvePathExecutable(name, environment = process.env) {
	for (const directory of (environment.PATH ?? "").split(path.delimiter)) {
		if (!directory) continue;
		const candidate = path.join(directory, name);
		try {
			await access(candidate, 1);
			return await realpath(candidate);
		} catch {
			// Continue to the next PATH entry.
		}
	}
	throw new Error(`Executable is unavailable on PATH: ${name}`);
}

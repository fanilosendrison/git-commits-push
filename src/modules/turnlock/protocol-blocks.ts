/** Decode Turnlock's serialized protocol field without shell evaluation. */
export function parseSerializedValue(val: string): string {
	if (val.startsWith('"') && val.endsWith('"')) {
		try {
			return JSON.parse(val) as string;
		} catch {
			return val.slice(1, -1);
		}
	}
	return val;
}

/** Extract the next standard Turnlock manifest/resume pair, for either supported yield shape. */
export function extractTurnlockBlocks(output: string): {
	manifestPath: string | null;
	resumeCmd: string | null;
} {
	let manifestPath: string | null = null;
	let resumeCmd: string | null = null;
	let inBlock = false;
	const lines: string[] = [];
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "@@TURNLOCK@@") {
			inBlock = true;
			lines.length = 0;
			continue;
		}
		if (trimmed === "@@END@@") {
			inBlock = false;
			for (const field of lines) {
				const manifest = field.match(/^manifest: (.*)$/);
				if (manifest?.[1] !== undefined)
					manifestPath = parseSerializedValue(manifest[1]);
				const resume = field.match(/^resume_cmd: (.*)$/);
				if (resume?.[1] !== undefined)
					resumeCmd = parseSerializedValue(resume[1]);
			}
			lines.length = 0;
			continue;
		}
		if (inBlock) lines.push(line);
	}
	return { manifestPath, resumeCmd };
}

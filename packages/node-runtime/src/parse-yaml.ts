import { CORE_SCHEMA, loadAll, YAMLException } from "js-yaml";

const DEFAULT_YAML_SOURCE_NAME = "<yaml>";

export interface ParseYamlOptions {
	readonly sourceName?: string;
}

export class YamlParseError extends Error {
	readonly sourceName: string;
	readonly line: number | null;
	readonly column: number | null;

	constructor(sourceName: string, cause: unknown) {
		const yamlException = cause instanceof YAMLException ? cause : null;
		const line = yamlException?.mark ? yamlException.mark.line + 1 : null;
		const column = yamlException?.mark ? yamlException.mark.column + 1 : null;
		const location =
			line === null || column === null
				? ""
				: ` at line ${line}, column ${column}`;
		const reason =
			yamlException?.reason ??
			(cause instanceof Error ? cause.message : String(cause));
		super(
			`Invalid YAML in ${JSON.stringify(sourceName)}${location}: ${reason}`,
			{ cause },
		);
		this.name = "YamlParseError";
		this.sourceName = sourceName;
		this.line = line;
		this.column = column;
	}
}

export function parseYaml(
	source: string,
	options: ParseYamlOptions = {},
): unknown {
	const sourceName = options.sourceName?.trim() || DEFAULT_YAML_SOURCE_NAME;
	try {
		const documents = loadAll(source, null, {
			filename: sourceName,
			json: false,
			schema: CORE_SCHEMA,
		});
		return documents.length === 1 ? documents[0] : documents;
	} catch (cause: unknown) {
		throw new YamlParseError(sourceName, cause);
	}
}

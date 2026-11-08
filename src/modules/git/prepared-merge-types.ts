/** Explicit caller authority; no ambient merge state can construct this scope. */
export interface PreparedMergeScope {
	readonly kind: "prepared-merge";
	readonly repository: string;
	readonly pushRemote: string;
	readonly pushRef: string;
	readonly firstParent: string;
	readonly secondParent: string;
	readonly indexTree: string;
	readonly mergeMessage: string;
}

/** Additional immutable source authority retained before any commit effect. */
export interface PreparedMergeSource {
	readonly authorIdent: string;
	readonly committerIdent: string;
	readonly expectedCommitSha: string;
	readonly headReference: string;
	readonly secondParentSha: string;
	readonly message: string;
	readonly indexEntriesDigest: string;
}

/** Caller-authorized creation anchor; not an existing destination baseline. */
export interface CreationAnchor {
	readonly baseRef: string;
	readonly baseSha: string;
}

/** Admission evidence frozen before staging, planning or commit effects. */
export interface ExplicitCreateTargetSnapshot extends CreationAnchor {
	readonly kind: "explicit-create-target";
	readonly remote: string;
	readonly destinationRef: string;
	readonly observedBaseRefSha: string;
	readonly initialHeadSha: string;
	readonly pushUrlFingerprint: string;
}

/** Exact validated outgoing history for an absence-leased publication. */
export interface ExplicitCreatePushSnapshot extends CreationAnchor {
	readonly kind: "explicit-create";
	readonly remote: string;
	readonly destinationRef: string;
	readonly observedBaseRefSha: string;
	readonly validatedHeadSha: string;
	readonly outgoingShas: string[];
	readonly pushUrlFingerprint: string;
}

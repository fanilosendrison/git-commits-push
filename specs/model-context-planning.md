---
okf_version: "1.0"
kind: "KnowledgeAsset"
asset_type: "specification"
name: "model-context-planning"
version: "2.0.0"
status: "Active"
domain: "git-commits-push"
severity: "strict"
---

# Model context admission and complete planning

## Authority and scope

Apply the owner's C2-Portable and bounded-composition decisions for Issue #34,
which replace compulsory qualified counting and do not claim universal semantic
composition proof. Preserve C1 and C3–C6 within that explicitly bounded scope. Preserve the existing reconciliation, validated-source,
publication, repair ownership and bounded fallback contracts. This specification
adds request admission and complete planning; it does not qualify a provider.

Keep H0, full accepted tree T, full raw diff hash and Git's literal validated path
set F outside model authority. Hash the complete unconverted Git stdout bytes,
not a UTF-8-decoded/re-encoded string; preserve invalid UTF-8 binary bytes in
this new binding independently of historical textual `diffHash` behavior. Never replace them with a partition, summary,
residual source or model output. Preserve historical immutable releases and runs.

## Qualified admission

Construct the complete logical adapter request before admission. Bind provider,
effective model, protocol identity, provider options, messages, generation
parameters and explicit response reserve to its SHA-256 request identity. This
identity hashes the exact deterministic application serialization, not a claim of
RFC canonical JSON or a captured HTTP body. Qualified counting must account for
the corresponding provider wire transformation and chat/template overhead.

Return exactly one status:

- `ADMITTED`
- `REJECTED_INPUT_CAPACITY`
- `REJECTED_OUTPUT_RESERVE`
- `CAPABILITY_UNKNOWN`
- `CAPABILITY_STALE`
- `COUNTING_UNSUPPORTED`

Only `ADMITTED` establishes `CONTEXT_CAPACITY_PROVEN` under this policy.
A missing profile may instead select the portable policy below. A selected
profile that is invalid, stale, unsupported or refuses the reserve remains a
qualified-policy refusal; never silently downgrade failed selected evidence.
Qualified input-capacity refusal may split independent Git path units.
Refusals are not provider outages and cannot select provider fallback.

Require a trusted executable profile bound to provider, effective model,
qualified revision, protocol, encoding, provenance and validity interval. Require
positive safe-integer input/output limits, minimum sufficient response reserve,
and the combined-window limit when applicable. Require a counter attestation
binding the complete request digest, revision, encoding and inclusion of protocol
overhead. Bound each counter to 10000 milliseconds, pass an AbortSignal, abort
on expiry and clear the timer on every settlement. Independently check a monotonic
deadline when processing evidence, including synchronous work that prevents timer
delivery. Late evidence must abort/refuse even if its promise wins the timer race.
Exceptional counting settlements also abort cooperative work before clearing the
timer, including synchronous rejection after expiry.
A shorter deadline may be
injected only by test authorities. Qualified counters must bound their own
transport and dispose of cooperative work; no unbounded internal retries are
permitted. Late counter results cannot authorize generation. Validate counting
results; errors, unsupported encodings and invalid or non-integer counts refuse.
Check limits without arithmetic overflow.

For separate input/output limits, enforce each independently. When a combined
limit applies, enforce input plus reserved output against it as well. Explicitly
send the admitted reserve to the adapter. An output reserve below the qualified
minimum or above output capacity refuses. A finite reserve bounds generation;
it does not guarantee that arbitrary model output will form a valid plan.
Schema and complete-plan validation remain mandatory.

Freeze a private request snapshot before counting and send that same snapshot.
Revalidate proof identity and validity immediately before every physical send,
including retries inside the runtime adapter. A local transport refusal is
non-retryable and remains an admission error at the invoker boundary; never
fabricate a provider HTTP response or turn it into provider failover. Feedback, options, model,
provider, protocol or reserve changes require fresh admission. Apply this boundary
to initial planning, compact message repair, structural retries, feedback,
fallback and every partition call.

## Profile trust and aliases

Keep production profiles in implementation-owned, reviewed qualification code.
Do not load executable profiles, token counts or test qualifications from job
JSON, caller settings or environment variables. No production profile is
qualified by this specification. The default production resolver is empty until
a separately evidenced profile is accepted.

Inject explicitly synthetic profiles only through deterministic test dependencies.
A production authority must reject a test-scoped profile. Test token units and
simulated capacities are not provider facts. Same-process injected dependencies
are a testing boundary, not a sandbox against arbitrary code in the process.

Unknown models and unresolved aliases cannot receive qualified admission.
Runtime-supported models without a profile may use portable execution. Do not derive a qualified revision
from a model name. Metadata limits and historical successful HTTP responses are
not complete encoding/counting proof. A qualified alias resolver would need an
evidenced binding to the actual invoked revision; metadata sampled before and
after a call does not by itself provide an atomic revision pin.

Do not treat `maxDiffChars`, bytes/3.5, transport JSON length or a throttle estimate
as production token evidence. Retain an additional presentation resource guard
only without silent truncation of required source content.

## Portable bounded execution

Use policy `gcp-portable-v1` when no qualified profile exists for a runtime-supported
provider/model. Permit `PORTABLE_ATTEMPT_ALLOWED`, never `CONTEXT_CAPACITY_PROVEN`.
Bind the complete immutable logical request identity, protocol, options, system
instructions, metadata, feedback and explicit output reserve. A successful call
establishes neither general model capacity nor a stable revision qualification.

Limit the UTF-8 serialization of that complete logical request to 65536 bytes.
Also guard the actual serialized request body at every physical send at 131072
bytes, before transport. These are operational allocation limits: a deliberately
small 64 KiB planning unit and a separate 128 KiB wire ceiling for serializer
expansion. Neither number is a universally safe model context. Do not convert
bytes to tokens or omit mandatory content. Oversized logical units split before
sending; an oversized indivisible unit or unsupported wire representation refuses.
Send an explicit positive output quota of at most 4096 tokens, default 4096.
This separately bounded output allocation is not a guaranteed sufficient response
or a claim about the provider's capacity. Validate responses as before.

Recognize `CONTEXT_OVERFLOW_REPORTED` only from bounded structured transport
responses for an explicitly recognized provider/status/code combination. Initially
recognize Mistral HTTP400 with exact `code=invalid_request_prompt_too_long`
(top-level or error object) and OpenAI HTTP400 with exact
`error.code=context_length_exceeded`. Do not parse diagnostic message text or
transfer these codes to other providers. Unknown codes/statuses, malformed bodies,
authentication, cancellation and protocol failures remain
`CONTEXT_FAILURE_UNDETERMINED` with respect to context; retain their existing
runtime failure/fallback policy, never subdivide on them.

On recognized overflow, retain the request digest and structured provider identity,
charge the failed call, and bisect its sorted literal path membership at the
midpoint. Rebuild both requests from their complete pinned Git representations;
never split patch text or a single file. Enforce the existing partition and shared
call/recovery limits before continuing. A failed unit invalidates the aggregate.
Retain recognized terminal overflow in the settled job's `contextOverflow`
receipt, including provider, effective model, request digest, HTTP status, exact
code and closed termination reason (`provider-refusal`, `indivisible-path` or
`planning-budget-exhausted`). Validate that receipt with terminal invalid-request
classification; never persist raw provider diagnostics. Ordinary invalid requests
without this evidence remain distinct. No overflow can create a provider fallback
cycle. Rebuild requests and policy
proofs for every model switch; never reuse another model's admission.

## Bounded composition scope

Git proves source identity and membership, not semantic groups. Planning units
are not definitive commits: each response may propose one or more groups within
its exact membership. Keep all existing schema, message, duplicate-path, ownership
and aggregate validators. `COMPLETE_PLAN_VALIDATED` means these executable gates,
not universal semantic coherence. `PUBLICATION_AUTHORIZED` additionally requires
the existing source, invocation and publication checks before effects.

Different subdivisions may produce different ordinary commit groupings and lose
cross-unit context. Document and test this quality limitation without presenting
coverage as semantic proof. Do not invent atomic groups from filenames, proximity
or model assertions. Caller-specific mandatory grouping/cardinality/message
constraints are not supported by a new API here; that work belongs to #23.
The caller boundary that knows an unrepresentable mandatory constraint must refuse
rather than claim GCP will enforce it. GCP cannot validate an absent input.

## Git partitions

Read paths and representations from pinned Git objects using literal/NUL-framed
Git primitives. Never split patch strings on `diff --git`. Bind the partition
manifest to the original source witness and full diff hash. Re-establish actual
remaining membership through the canonical landed-commit proof on retries.

Order paths deterministically. Before selecting a leaf with a literal Git
pathspec, prove that remaining membership is a component-prefix antichain:
literal pathspecs still recurse into descendants. Refuse coupled file/directory
transitions explicitly before generation; this version does not assign those
coupled identities to independent plans. Each supported path belongs to exactly
one nonempty partition. Enforce closed union F (or its canonically proven remaining subset),
no duplicates, no invented paths and a finite partition bound. Read each path's
full representation through Git, preserving deletion, modes, symlink/gitlink
metadata and binary patch data. Decode patch bytes with strict UTF-8 (preserving
BOM data), so a genuine replacement character in content is not confused with
lossy decoding. Conservatively refuse ambiguous replacement characters in
canonical pathname strings until their byte identity is qualified. Refuse
unsupported or lossy encodings rather than replacing bytes or dropping a path. A single indivisible representation
that cannot fit refuses; splitting its text arbitrarily is not an alternative.

Compose the complete request for each candidate partition, including system,
feedback and explicit literal membership. Admit every final partition before
calling it under its selected policy. Greedy deterministic path grouping is
permitted. Byte limits are local resource policy, never token evidence.
Stale selected profiles and unsupported encodings cannot be repaired by reducing
path count.

## Aggregate gate and recovery

Validate each response with the production schema and exact partition membership.
Reject outside paths even when they are unchanged companions tolerated by older
nonpartitioned publication. Validate the complete aggregate with canonical
coverage/message/source checks before the first commit. A schema-valid membership defect must cross the result
boundary as a canonically classified structural planning failure and may consume
only the existing repository structural retry. It is not a provider outage.
Reject combined provider/structural retry authority. An absent complete aggregate, including a provider outage without rejected repair
plans, has no complete-plan fingerprint: retain the last genuine loop fingerprint
or its absence, never fabricate one from an empty plan, and retain the existing
kind-specific counter. Keep this condition separate from structural retry
authorization. A compact repair still has its exact complete frozen candidate;
its existing one-fallback repair and ownership rules remain unchanged. On a
provider outage during compact repair, reconstruct structured constraints from
the frozen complete candidate using the canonical message validator. Preserve
all requested indexes, budgets, bodies and file ownership; refuse if no canonical
repair constraint remains rather than queuing an impossible zero-index repair.
A failed partition invalidates the aggregate; a set of successful partial results is not publication
authority. Return no successful repository result until aggregation completes.

Preserve the existing message-only repair contract: only requested messages may
change, never plan cardinality or ownership. An oversized indivisible repair
request may refuse explicitly. Existing canonical validation repairs still own
message validation before commit effects.

Planning partition results are not landed commits. Interrupted planning cannot
recapture T, reset attempts, or promote partial results to success. Existing
witness/parentage/index-progress recovery continues to govern effects after the
first commit. Preserve landed commits and actual remote evidence on failure.
Require final HEAD tree T and exact publication evidence exactly as before.

## Shared budgets

Preserve canonical repository-level `MAX_ATTEMPTS_BY_KIND` and the single durable
`fallbackAttempted` budget. Partitions are not new repositories or new retry
rounds. Keep one result job per repository/round so partial plans cannot enter
the commit phase independently.

Within a planning job, allow at most 32 nonempty leaf partitions, including
adaptive subdivisions. Across settled repository planning jobs, carry a monotonic
`planningBudget` receipt through results, Turnlock state and subsequent payloads:
at most 2048 counting-proof requests, 64 total adapter calls (including context
refusals and malformed-response repeats) and one malformed-response repeat. Preserve the runtime's current maximum of four additional
transport attempts, shared across all calls in the job instead of per partition.
Each call gets one base attempt plus the currently remaining shared recovery
allowance; charge actual reported attempts on both success and failure. Invalid
or unavailable attempt evidence fails closed. Preserve runtime backoff and error classification. New typed terminal runtime
failures must remain terminal even when their diagnostic text contains legacy
validation phrases. A bridge-owned fatal marker also outranks validation words
echoed in malformed-response diagnostics after the local repeat budget is spent;
those diagnostics cannot authorize a new validation round or an empty-plan
fingerprint. Preserve the historical unprefixed validation extension separately.
Carry the closed terminal kind through result validation;
do not infer types for historical untyped receipts or combine terminal/outage/
structural retry authority. A later existing repository retry/fallback round retains its
canonical accounting and the consumed planning receipt; it cannot obtain extra
rounds by naming partitions or changing models. Missing or regressing receipts
cannot reset known consumption. This receipt records settled jobs, not a new
per-send crash journal. Interrupted jobs never supply partial-plan authority.

The finite base-call allowance supports partitioning; it is not an increase in
recovery attempts. Refuse when any shared allowance is exhausted. No fixture,
partition, adapter error or resumed partial plan grants unbounded retry.

## Qualification and release

Qualify the generic engine with independent injected positive/negative controls,
actual bridge/runtime layers and temporary Git/bare-remote fixtures. Preserve
RED/GREEN identities, complete repository validation and independent review.

Separately qualify production provider profiles, including revision addressing,
complete protocol counting and output semantics. Google's counting endpoint and
Mistral tokenizers/Responses facilities are candidates for investigation, not
proof for the currently used generation protocol. A profile for one provider
never qualifies another provider or repairs the historical fallback by inference.

An empty production registry does not prevent portable execution. It still
precludes qualified capacity claims. Keep generic implementation, full validation,
independent review, operational qualification and historical fallback remediation
as separate gates. Portable deterministic tests do not establish live provider
usability.
No automatic caller publication or global release activation is authorized.

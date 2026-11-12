---
okf_version: "1.0"
kind: "KnowledgeAsset"
asset_type: "specification"
name: "model-context-planning"
version: "1.0.0"
status: "Active"
domain: "git-commits-push"
severity: "strict"
---

# Model context admission and complete planning

## Authority and scope

Apply the owner's C1–C6 decisions and the provider-independent construction
clarification for Issue #34. Preserve the existing reconciliation, validated-source,
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

Only `ADMITTED` authorizes generation. Refusals are terminal admission failures,
not transient provider errors. Do not select fallback by interpreting refusal
prose or consume a new retry against the same refused request.

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

Unknown models and unresolved aliases refuse. Do not derive a qualified revision
from a model name. Metadata limits and historical successful HTTP responses are
not complete encoding/counting proof. A qualified alias resolver would need an
evidenced binding to the actual invoked revision; metadata sampled before and
after a call does not by itself provide an atomic revision pin.

Do not treat `maxDiffChars`, bytes/3.5, transport JSON length or a throttle estimate
as production token evidence. Retain an additional presentation resource guard
only without silent truncation of required source content.

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
calling it. Greedy deterministic path grouping is permitted; no token heuristic
may substitute for the counter's admission result. Unknown/stale capabilities or
unsupported encodings cannot be repaired by reducing path count.

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

Within a planning job, allow at most 32 nonempty partitions, 2048 counting-proof
requests, 64 total adapter calls (including malformed-response repeats) and one malformed-response repeat
shared across the job. Preserve the runtime's current maximum of four additional
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
canonical accounting; it cannot obtain extra rounds by naming partitions.

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

An empty production registry must not block generic construction. It must refuse
real generation and prevents a release from being advertised as an operational
remediation. Keep generic implementation, full validation, independent review,
production usability and historical fallback remediation as separate gates.
No automatic caller publication or global release activation is authorized.

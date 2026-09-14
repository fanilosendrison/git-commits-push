---
okf_version: "1.0"
kind: "KnowledgeAsset"
asset_type: "agent-directives"
domain: "git-commits-push-repository-governance"
severity: "strict"
name: "git-commits-push Engineering GitHub Project profile"
---

# git-commits-push Engineering GitHub Project profile

Apply the shared GitHub Engineering Projects operational protocol before using
this profile. This file contains only git-commits-push-specific routing,
authority, classification, and workflow policy.

## Fixed routing

- GitHub owner: `fanilosendrison`
- Default repository: `fanilosendrison/git-commits-push`
- Repository visibility: private
- Project title: `git-commits-push Engineering`
- Project number: `7`
- Project URL: <https://github.com/users/fanilosendrison/projects/7>
- Project type: private user-owned GitHub Project V2
- Linked repository: `fanilosendrison/git-commits-push`

Resolve an unqualified `Issue #N` as
`fanilosendrison/git-commits-push#N`. Follow an explicit repository-qualified
reference or Issue URL instead when the user provides one.

## Authority boundary

Treat git-commits-push Engineering as the authority for durable work existence,
classification, priority, and workflow state. Never treat it as authority for
runtime behavior, reconciliation semantics, or release content.

Apply these repository authority boundaries:

1. `AGENTS.md` defines contributor directives, responsibility boundaries, and
   the required validation sequence.
2. `specs/reconciliation.md` defines the normative reconciliation state machine.
3. `src/` implements the runtime; executable behavior and tests outrank prose
   summaries when they disagree, and every disagreement must be reported.
4. `docs/reconciliation-migration.md` and `docs/node-cutover-preflight.md`
   define compatibility and operational procedures.
5. `README.md` documents user-facing behavior; it is not a semantic authority.
6. Installed releases under `$XDG_DATA_HOME/git-commits-push/releases/` are
   immutable deployment artifacts; their content is evidence, not policy.

Report every inconsistency between these sources. An Issue or Project field
never ratifies runtime semantics, a migration decision, or a release action.

## Workflow-status mapping

Map the shared protocol's workflow roles to these exact `Status` values:

- unready backlog: `Backlog`
- ready for independent pickup: `Ready`
- active execution: `In Progress`
- reviewable result: `Review`
- completed work: `Done`

`Ready` means the work can be picked up without reopening unresolved semantics,
external capabilities, or dependencies. Use the Project's `Agent Queue` view as
the normal autonomous pickup surface. A direct user request may select another
item, but it does not ratify proposed semantics or remove unresolved
prerequisites.

## Classification fields

### Area

Use `Area` for the surface that owns the immediate deliverable:

- `LLM & Providers`
- `Orchestration`
- `Reconciliation & State`
- `Git & Publication`
- `Installation & Release`
- `Validation & Tests`
- `Documentation & Governance`

Create linked follow-up Issues when a downstream area requires independent
acceptance, prerequisites, or scheduling.

### Kind

Use `Kind` for the item's relationship to the engineering plan:

- `Agent Task`: independently scoped work intended for direct execution.
- `Follow-up`: downstream work created by another task, finding, or accepted
  decision.
- `Finding`: a validated concern that still requires adjudication, design, or
  correction.

Do not retain an unvalidated observation as a `Finding` item.

### Priority

Use `Priority` according to this Project contract:

- `P0`: blocks current progress or protects a critical correctness, safety,
  security, or publication invariant.
- `P1`: should be completed in the current phase.
- `P2`: important but non-blocking work.
- `P3`: useful retained work that can wait.

Priority controls scheduling only. It never overrides contributor directives,
the reconciliation state machine, the trust boundary, or validation
requirements.

An open decision that can silently invalidate published history, a release
artifact, or stored state defaults to `P0` while it remains unresolved. A
`Follow-up` that operationalizes an already accepted decision does not inherit
that default. Record an explicit rationale on the Issue when deviating from
either default.

## Project views

The intended views are:

- `All Work`: table of every tracked item.
- `Agent Queue`: table filtered to `Status` in `Ready` or `In Progress`; the
  normal autonomous pickup surface.

Treat any difference between these declarations and live GitHub configuration as
an inconsistency to report before relying on the affected routing.

## Issue requirements

A normal git-commits-push Issue must state:

- the observed problem or required outcome;
- the exact evidence: run IDs, revisions, commands, and observed output;
- the controlling contributor directives, specs, and procedures;
- the affected `Area` and every unresolved prerequisite;
- constraints, security boundaries, and authority limits;
- mechanically checkable acceptance criteria;
- the required validation from the `AGENTS.md` sequence.

Keep the Issue outcome-oriented. Do not duplicate the only authoritative runtime
contract, state machine, or procedure in GitHub prose.

Populate `Status`, `Area`, `Kind`, and `Priority` for every Project Issue. Use
native GitHub parent, sub-issue, dependency, and Pull Request relationships when
available within this repository. Record a cross-repository dependency in both
Issue bodies, because native blocked-by relationships do not cross repositories.

## Findings and durable work

Create a `fanilosendrison/git-commits-push` Issue for every validated finding or
other work unit that must be deferred, handed off, scheduled, or tracked
independently. Add it to git-commits-push Engineering and populate all required
fields.

Default retained findings to `Backlog`. Use `Ready` only when authority,
dependencies, capabilities, scope, acceptance criteria, and validation make the
work independently executable.

Do not create Issues for transient exploratory reasoning, duplicate backlog
entries, or unvalidated observations.

## Repository validation

Use the current validation sequence in `AGENTS.md`. Project completion, an Issue
closure, or a passing review cannot replace the required type checks, lint,
source tests, compiled node tests, statistics smoke, or installed-release
verification.

---
okf_version: "1.0"
kind: "KnowledgeAsset"
asset_type: "test-fixture"
name: "historical-state-reader-provenance"
version: "1.0.0"
domain: "git-commits-push"
severity: "strict"
---

# Baseline state reader

These source files are an exact, machine-extracted historical verification fixture from commit `431a19aa1dedaa60d0262262c63f2a9c1ee93f0a` (package 0.9.0). The extraction uses `git archive` for `src/config/state-schema.ts`, `src/types.ts`, `src/modules/turnlock/job-result-schema.ts` `src/modules/llm/provider-failure.ts` and its transitive `src/modules/core/sensitive-diagnostic-sanitizer.ts` dependency.

Do not modify or reformat this reader. It is not production authority. Its independent historical behavior proves that new creation state fails closed under the actual baseline reader, rather than a reconstructed approximation.

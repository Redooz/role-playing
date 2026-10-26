# Rubrics

Frozen rubric definitions, one directory per rubric version:
`evals/rubrics/<rubric-version>/`.

Rules from the M0 plan (D4, D5, D6):

- A rubric is **frozen** once a run references it. Editing it in place
  invalidates every cache entry and baseline keyed by that version, so a change
  means a new version directory.
- The Jev cache key includes the rubric version (Architecture Plan v5 §4.3),
  alongside the canonical payload, grader version, extraction version and
  provider surface. Reusing a version number for different content is a bug.
- Every rubric carries provenance and a version. Deletion propagation is
  documented even though no production data exists at M0 (§4.6.9).
- Rubrics are referenced by version from run manifests; a run without a rubric
  version is rejected.

M0 has no scored behaviour yet, so this directory is intentionally empty until
the first calibration run defines a rubric.

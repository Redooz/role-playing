# Rubrics

Frozen rubric and label definitions, one file per version:
`evals/rubrics/<version>.md`.

Rules from the M0 plan (D4, D5, D6):

- A rubric is **frozen** once a run references it. Editing it in place
  invalidates every cache entry and baseline keyed by that version, so a change
  means a new version file.
- The Jev cache key includes the rubric version (Architecture Plan v5 §4.3),
  alongside the canonical payload, grader version, extraction version and
  provider surface. Reusing a version number for different content is a bug.
- Every rubric carries provenance and a version. Deletion propagation is
  documented even though no production data exists at M0 (§4.6.9).
- Rubrics are referenced by version from run manifests; a run without a rubric
  version is rejected.

## Current versions

| File                                | Covers                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| `m2-persona-rubric-v2.md`           | M2 semantic axes                                                                    |
| `m2-annotation-guideline-v2.md`     | M2 human annotation                                                                 |
| `m3b-turn-taking-rubric-v1.md`      | M3b interjection warrant                                                            |
| `m3b-speaker-label-guideline-v1.md` | M3b speaker ownership, before the next-step and mixed tests; kept for history       |
| `m3b-speaker-label-guideline-v2.md` | M3b speaker ownership, next-step and mixed tests, `m3b-v2` and later                |
| `m3a-routing-label-v2.md`           | M3a routing ownership and visible coverage, before the mixed test; kept for history |
| `m3a-routing-label-v3.md`           | M3a routing ownership, visible coverage and the mixed test, `1.1.0` and later       |

Older versions stay in place for history and for the runs that reference them.
`m3b-v1` and `synthetic-routing/1.0.0` are frozen on their original rules.

# Episode labels performance closeout

Non-gating measurement from 2026-10-15, baseline
`5a77b5854b62601842969eea23915ab5fd5526b2`. This is supporting evidence for
that implementation candidate, not a performance assertion about current HEAD.
The measured production-file-list fingerprint was
`bd8576e3b4f8c220de2872980c102c8460b0efb0c0d76d60dd8850dc91cbbd2e`.

100 samples per side/mode, four warmups, alternating baseline/candidate order
on Node v24.14.0 Linux. Both sides exercised the real formation planner,
installed-candidate validation, Git placement and operation receipts, with
structural SDK doubles. These measurements are not live E2E acceptance.

| Mode | Quantile | Baseline ms | Candidate ms | Delta ms | Delta |
|---|---|---:|---:|---:|---:|
| inherit | p50 | 152.726 | 149.710 | -3.016 | -1.98% |
| inherit | p95 | 169.536 | 176.445 | +6.909 | +4.08% |
| new | p50 | 164.351 | 172.132 | +7.781 | +4.73% |
| new | p95 | 193.263 | 195.675 | +2.412 | +1.25% |

All four comparisons met the episode spec's simultaneous 5% and 10 ms limits
in that run. Paired host-call sequences matched. Subsequent policy/payload,
managed-task protocol-source and CLI warning corrections were not rebenchmarked;
the measured fingerprint does not identify the final candidate.

Raw samples and per-file fingerprints are in
[results.json](/tmp/paseo-slp-episode-bench-to3qribk/results.json); the one-off
benchmark is [bench.mjs](/tmp/paseo-slp-episode-bench-to3qribk/bench.mjs).
The results file's SHA-256 is
`f5a07017ce9d2b6b39b017d9593b82b9101db365b8b7ff3f8de4fea76d91069d`.
These paths are machine-local and are not distributed evidence. Reuse requires
recovering those exact artifacts and matching pins; otherwise measure again
under the [current performance contract](../spec/episode-labels.md#performance-constraints).

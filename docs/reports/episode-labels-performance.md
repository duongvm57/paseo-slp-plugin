# Episode labels performance evidence

Measured 2026-10-15 on the implementation candidate before commit.
Baseline: `5a77b5854b62601842969eea23915ab5fd5526b2`. Candidate production-file-list SHA-256:
`bd8576e3b4f8c220de2872980c102c8460b0efb0c0d76d60dd8850dc91cbbd2e`. The benchmark pins every tracked/untracked production file under
`plugin/`, `src/`, `tests/helpers/`, and `package.json`; its before/after
fingerprints match. Documentation and tests outside helpers are excluded.

100 samples per side per mode, four warmups, alternating baseline/candidate
order on the same machine (v24.14.0, linux). The baseline is an
unchanged `git archive HEAD` checkout sharing the same dependency installation.
Both sides use the real Lead formation planner, installed candidate validation,
Git placement qualification and durable operation receipts. Paseo calls use
structural doubles; this is local performance evidence, not live E2E acceptance.
New allocations retain previous openings, rather than resetting state each run.

| Mode | Quantile | Baseline ms | Candidate ms | Delta ms | Delta |
|---|---|---:|---:|---:|---:|
| inherit | p50 | 152.726 | 149.710 | -3.016 | -1.98% |
| inherit | p95 | 169.536 | 176.445 | +6.909 | +4.08% |
| new | p50 | 164.351 | 172.132 | +7.781 | +4.73% |
| new | p95 | 193.263 | 195.675 | +2.412 | +1.25% |

All four comparisons satisfy the spec's simultaneous limits of 5% and 10 ms
in this run. Results vary with filesystem latency; this is a measurement,
not a guaranteed bound on a live daemon or a slow disk. Episode selection
itself measured inherit p50/p95 0.151/0.282 ms,
and new p50/p95 4.530/6.859 ms.

Host-call sequences are equal in every measured pair:
`providers → providers → refresh → create → providers → refresh`.
MCP bridge tests separately verify unchanged creator-refresh counts and no
post-create label updates. Inheritance does not rewrite metadata. New openings
append one checksum-chained entry and synchronize data/length with `fdatasync`;
only initial file/directory creation also requires directory synchronization.
Managed open/close events share existing work-ledger transactions.

The earlier atomic rewrite and append-with-full-fsync candidates exceeded the
bound (atomic rewrite new p95 +20.754 ms/+12.35%; append/full-fsync new p95
+11.696 ms/+6.63%). They were not accepted. The final implementation uses
append/data synchronization and is measured above; no threshold was relaxed.

After measurement, the delegation reference was copy-edited to its original
745-word ceiling and its generated payload refreshed. Those are the only
production-file differences from the measured fingerprint; server/runtime
implementation is unchanged. The copy edit was not separately benchmarked.
The final test receipt pins the candidate including that text correction.

Raw samples, per-file fingerprints, benchmark script and earlier results:
[/tmp/paseo-slp-episode-bench-to3qribk](/tmp/paseo-slp-episode-bench-to3qribk).
The final raw result is `results.json`. These local artifacts are not installed
runtime files and have not been committed or uploaded.

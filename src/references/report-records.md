# Handback and settlement

Keep prose as the bounded judgment; a v1 slp-record projects those same facts.
Candidate/check claims need a handback record; report-only work may omit it
or use candidate:null. Use the installed `records --schema` for exact fields
and advertised optional structured reports/recaps; do not copy schema/parser
algorithms into task instructions.

## Submit or verify

When attached to a desk assignment, use slp_handback_submit with recordV1 and
inspect observedCandidateId/gaps. The runtime validates the envelope and
captures its bound checkout separately; a stored claim, pending observation
or supplied matching hash proves neither execution nor acceptance. It may
leave outputRef unreadable: actual referenced-evidence validation still
needs the CLI or authorized evidence inspection. Pause source writes and
report actual artifacts, output and unfinished work, even with measured capture.

For ordinary/Lean reports or referenced-file verification, run managed
`bin/slp.mjs records <report> --require handback --repo <absolute-checkout>`.
Measure handback claims: `slp.mjs verify-handback <report> --repo <absolute-checkout> --expect-contract <repo-path>=<sha256> --paseo-home <verified-home>`.
Build facts-only review input: `slp.mjs review-packet <absolute-checkout> --base <git-ref>`.
Use a column-1 slp-record fence and advertised schema; `slp.mjs record-build` can draft one with shas taken from output files. The verifier's --repo
wins over declared roots, constrains outputRef and checks UTF-8 output hashes.
Inline output wins over outputRef; sha:null records missing evidence, never
success. Treat validation errors as unfinished proof. Parser validity and
hash equality establish consistency, not execution; Lead verifies actual
checks or inspects trustworthy candidate-bound measured execution.

Optional slp-report read/ran/authority/findings remain claims. Rendering keeps
original evidence fence bytes. handoff.recapInputs uses only supplied sources,
exposes omissions/conflicting pins and proves no settlement, acknowledgment
or transfer.

## Mutation evidence

R1: every mutation log, including the acceptance owner's replay, carries the
verbatim `sha256sum <test file>` output captured immediately before each mutant
run, plus product hashes before, mutant and after revert, and candidate identity;
a declared meta hash alone is insufficient.
R2: the acceptance owner's replay of a mutant, with its pinned log, is the
evidence of record; the writer's log is supporting; any sha mismatch between
log, meta and the handback candidate voids the claim without proof of intent.

## Receiving-owner settlement

After accepted artifact, Delivery and closed rework, account for actual
resources. With desk tools, slp_settlement_record records the receiving
owner's attestation and export verification; slp_settlement_export derives
its committed v1 block. Consume the row/derived record instead of manually
assembling duplicate IDs. Neither mirror nor export performs cleanup or
creates project acceptance; unresolved resource proof remains a gap.
Outside the desk, use the advertised settlement schema with exact owner,
seat/timeline/resource evidence. Keep candidate verdict separate from cleanup.

Place the settlement in the protocol's durable task sink when supplied;
otherwise use the assigned Supervisor's authorized causal notebook. Without
either, Lead includes Peer settlement in its handback to Supervisor. Without
Supervisor, Lead uses its own authorized task/note location and Human handback.
Lead does not write a Supervisor-owned notebook. Desk claim storage/mirrors
do not replace that official sink or authenticate its pointer.

Record only exposed native handles and actual exports. Paseo activity is
tail-oriented; logs/read pointers are not durable archives. The host may lack
transcript export, and removed timelines cannot be restored by a pointer.
Keep missing export/handle/control explicit; no raw transcript or secrets in
settlement records. monitoring.md owns resource reconciliation and host stop.

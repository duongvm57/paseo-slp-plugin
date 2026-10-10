# Write compact tactics

Read before drafting or revising a protocol. Each line must change a
repository decision or action; apply these checks to every line.

- Keep one home per meaning: global rule/procedure in role policy, local
  tactic in protocol, operational fact in a useful reference, task detail in
  its assignment. Delete duplicated rules and whole no-op sentences.
- Use environment sources (scripts/config/--help); cache only convention,
  rationale or hazards lookup cannot reveal.
- Inline what every task needs. Disclose branch-specific facts behind
  trigger-first pointers, one per distinct branch. Avoid mandatory files or
  recipe phases without a decision they serve.
- Co-locate rule, exception and caveat. Steps end in observable completion:
  candidate pinned, ruling made, grant verified, receipt returned.
- Use stable terms and positive actions; retain hard prohibitions as guards,
  paired with the authorized action. Leading words should carry meaning,
  not slogans.
- Adapt Lean/Feature/Transition/Investigation routes to the actual work mix,
  preserving applicable review/authority/completion obligations. Changed
  template meaning needs a recorded Human decision; shortening does not.
- Remove stale examples/sediment with each revision. Keep decisions here,
  rationale/history in Git or authorized evidence. Do not hide necessary
  responsibility/authority/trigger rules in unreferenced files.

Done: each line passes the tactic test, has one authoritative home and a
clear trigger/action/completion where applicable.

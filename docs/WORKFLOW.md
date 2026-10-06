# Repository Understanding

Repository code, types, module interfaces, executable commands, tests, examples,
and runtime evidence hold current implementation knowledge. Product intent,
rationale, and accepted constraints remain with their repository owners.
Use `docs/README.md` to find the relevant sources; link to existing knowledge
rather than reproduce it in a new summary.

## Authority And Scope

Respect the user's requested scope. Discovery does not authorize editing,
starting services, installing tools, or changing external settings.
Before changing externally observable policy, identify accepted repository
authority. If materially different choices remain, stop and request the smallest
decision. Code and tests show current behavior; configurable defaults are not
authority for missing product policy.

## Missing Capabilities

Identify the capabilities needed for the requested outcome: locating an owner
or interface, running a command, preparing known state, observing an effect,
verifying behavior, or recovering safely. Check the relevant implementation,
commands, fixtures, logs, and environment rather than assuming they exist.
Report an unavailable capability with its evidence and owning repository or
external dependency. Keep unobserved state Unknown.

Application commands, credentials, readiness, state ownership, and cleanup
belong to the consumer repository. A template supplies structure, not proof
that an application can be operated. Do not invent missing commands or policy.

## Trust Through Evidence

Use repository-native checks and observations appropriate to the claimed
behavior. Protect accepted safety and correctness boundaries; preserve existing
state and verified recovery mechanisms. Distinguish observed results from
assumptions, and structural checks from semantic or runtime proof.

A plan, checklist, or completion message is not behavior-level proof. A checked-in
CI job does not prove it ran or blocks merging. Report what was exercised, what
failed or could not run, and what remains unverified.

## Optional Resources

Only invoke a Harness skill when the user explicitly requests it. Installation
makes skills available; it does not activate them. Patterns and templates are
references for requested work. Harness does not classify tasks, require plans,
route requests to skills, or govern the consumer's workflow.

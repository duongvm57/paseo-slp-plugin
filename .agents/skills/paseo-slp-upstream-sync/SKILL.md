---
name: paseo-slp-upstream-sync
description: Lead-only macro workflow that turns a Paseo upstream release into a plugin impact report and, under an explicit grant, a verified paseo-slp update. Use when a new Paseo release or @getpaseo package version may affect the plugin; skip unrelated dependency bumps and Peer micro-tasks.
---

# Sync paseo-slp with Paseo upstream

Each upstream release becomes an evidence-based **impact report**; a verified
update follows only when the active assignment grants its exact writes. A
release by itself authorizes nothing: dependency, compatibility, runtime and
product changes each need their own grant.

The project Lead runs this workflow end to end: framing, integration, review
gate and verdict. A Supervisor routes or observes it. A Peer receives only a
bounded slice with the task-relevant constraints the Lead supplies.

## 1. Establish the baseline

Read `AGENTS.md`, the full `.paseo-slp/workspace-protocol.md` and the
assignment; follow the protocol's recipe, isolation, review gate and
verification rules. Record the repository, branch/commit, existing working
changes (preserve them), the target release and the permitted write scope.

**Scratch grant.** The tracked checkout is read-only during assessment, and
every scratch artifact is a write: directories, `npm pack` tarballs, extracted
trees, redirected diff output, receipts and reports. Write them only under
the exact path the assignment grants, such as
`.local-checks/skill-upstream-sync/<release>/`. Without a scratch grant,
continue with console-only evidence; when that cannot answer the question,
report the gap and request the grant. Installing or reloading a live Paseo daemon, host configuration, commit
and publication each need a separate grant.

Read `.paseo-slp/references/upstream-baseline.md`, the tracked record of each
package's **Pinned** version (what this checkout builds against) and
**Assessed** version (the newest release already classified), with coverage
and open items. Cross-check Pinned against `package.json`,
`package-lock.json`, `plugin/package.json` and `plugin/paseo-plugin.json`; a
mismatch is a finding to resolve before assessing. Record each of
`@getpaseo/plugin`, `client`, `protocol`, `cli` and `server` separately: some
are host packages rather than plugin dependencies, and each package carries its
own release number. A package with no Assessed version, or partial coverage,
starts from Pinned for its unreviewed surface.

A prior sync's report, when present, shows the investigation method and
evidence shape. Its conclusions belong to its own release: verify every fact
for the current target, and keep that prior run's artifacts untouched.

Done: Pinned and Assessed per package, supported Paseo range, worktree
baseline, target release and write authority (including the scratch grant)
are explicit.

## 2. Find the upstream release

Query npm per package so independent versions and dist-tags stay visible:

```sh
for name in plugin client protocol cli server; do
  npm view "@getpaseo/$name" version dist-tags --json
done
npm view "@getpaseo/plugin@<target-version>" version time dist.tarball repository --json
```

Repeat the second query for each assessed package. Follow each package
repository to its release notes, changelog or tag, and read every release
after Assessed through the target. Record an unavailable source as a gap; a
version number alone is not release evidence.

Done: a per-package baseline/target table lists exact versions, dates,
release-note sources and inaccessible evidence.

## 3. Compare package surfaces

Map what this checkout consumes:

```sh
rg -n '@getpaseo/' plugin package.json plugin/package.json
```

The archive work below needs the scratch grant from step 1. Pack the Assessed
and target versions of all five packages into the granted directory, leaving
the checkout's installed dependencies as they are; the new delta is what
changed since the last classification, and compatibility is still judged
against Pinned. Where step 1 found no Assessed version or partial coverage,
diff from Pinned instead — the lockfile for pinned packages, and for `cli` or
`server` the supported or observed Paseo runtime, labelled as a host version.

```sh
scratch=".local-checks/skill-upstream-sync/<release-id>"
mkdir -p "$scratch/plugin-base" "$scratch/plugin-target"
npm pack "@getpaseo/plugin@<base-version>" --pack-destination "$scratch"
npm pack "@getpaseo/plugin@<target-version>" --pack-destination "$scratch"
tar -xzf "$scratch/getpaseo-plugin-<base-version>.tgz" -C "$scratch/plugin-base"
tar -xzf "$scratch/getpaseo-plugin-<target-version>.tgz" -C "$scratch/plugin-target"
diff -ruN "$scratch/plugin-base/package" "$scratch/plugin-target/package" > "$scratch/plugin.diff"
```

`diff` exits 1 when trees differ; a larger code is a diff error. Save the file
list and diff per package, then compare the export map, public `.d.ts`
entrypoints and barrels, payload/schema files and relevant runtime `.js`. Trace
moved declarations through their barrels: a symbol still re-exported was moved,
not removed. Read runtime semantics as well as types, since a type-only diff
misses behavior changes. For `server` and `cli`, focus on the exported
contracts and host/CLI behavior the plugin relies on; distribution churn is not
plugin impact. Record every file inspected and every surface left unreviewed.

Done: every changed public or relied-on surface is classified as used, unused,
preserved through re-export, or unresolved, with source evidence.

## 4. Trace changes to plugin touchpoints

Connect each material change to the import, payload, lifecycle or process
behavior it could affect. Start from this map and verify it against current
code:

| Upstream surface | paseo-slp touchpoints |
|---|---|
| Plugin server contracts, RPC, hooks, lifecycle | `plugin/index.server.ts`, `plugin/server/*` |
| Plugin client hooks, navigation, UI contracts | `plugin/index.client.tsx`, `plugin/client/*` |
| Protocol schemas and serialized payloads | `plugin/server/config-view.ts`, `config-transaction.ts`, other `plugin/server/*` consumers, `plugin/server/generated/runtime-payload.ts` |
| Host/CLI launch behavior, argv, environment, provider resolution | `plugin/server/launchers.ts`, `executables.ts`, `provider-catalog.ts` and the affected caller |
| Compatibility range | `plugin/paseo-plugin.json` (`requirements.paseo`) |
| Dependency resolution and bundled build inputs | root `package.json` / `package-lock.json`, `plugin/package.json`, the payload generator |

Establish which SDK code the host supplies and which content the plugin build
bundles; the repository's TypeScript dependency version does not show runtime
behavior. A host-side fix can remove the need for a plugin edit, while a
bundled payload can go stale when a pin changes.

Done: each relevant upstream change maps to an actual touchpoint, or carries
the reason it has no effect.

## 5. Assess impact before updating

Classify by behavior and compatibility, not semver labels:

- **Additive:** new exports, optional fields or parameters, relaxed
  validation, preserved re-exports, or host fixes that keep the contracts this
  plugin uses. State whether any update is needed; "no plugin change" is a
  valid result.
- **Potentially breaking:** removed or renamed used exports, tightened
  required fields or schemas, changed payload/event meaning or defaults,
  altered CLI/launch behavior the plugin relies on, or a host version outside
  the supported range. Confirm the incompatibility against this plugin and
  every Paseo version the manifest still claims.
- **Unresolved:** missing release evidence, unexamined paths, unclear
  runtime/bundle boundaries, or behavior types cannot show. It stays
  unresolved until evidence arrives.

Deliver the impact report before any write: the per-package version table,
release evidence, classified findings, affected touchpoints, compatibility
consequences, update/no-update options and remaining gaps.

An update proceeds only when the assignment covers its exact dependency, code,
payload and compatibility writes; with assessment-only authority, the report is
the handback. Ask the Human when a change would drop or narrow supported Paseo
versions, needs a breaking adaptation or user-visible behavior choice, adopts
an optional upstream capability, carries a security/privacy trade-off, or
exceeds the grant. `requirements.paseo` moves only with an approved
compatibility decision, never to match the newest release.

Done: the recommendation and the Human or assignment decision that unlocks
each write are recorded before any mutation.

## 6. Apply an authorized update

Change only the direct dependencies and touchpoints the accepted decision
requires. Pass each package's separately selected version to npm, which
updates `package.json` and `package-lock.json` together; the lockfile changes
only through npm:

```sh
npm install --save-dev --save-exact \
  "@getpaseo/plugin@<plugin-version>" \
  "@getpaseo/client@<client-version>" \
  "@getpaseo/protocol@<protocol-version>"
```

Align the `@getpaseo/protocol` pin in `plugin/package.json` with the approved
version. `cli` and `server` stay out of the plugin's dependencies; inspecting
them grants no pin. Adapt code narrowly to the verified contract. Edit
`plugin/paseo-plugin.json` only as the compatibility decision requires, and
name the host versions that remain supported. After changing payload inputs:

```sh
npm run generate:plugin-payload
```

Review the generated diff for source-derived changes only.

Done: manifests, lockfile, source, compatibility range and generated payload
agree with the accepted decision, and the exact diff is reviewable.

## 7. Verify the frozen candidate

Run the checks the workspace protocol requires, reading current scripts from
`package.json`; this sync always includes `npm run check:plugin-payload`. Run
`npm test` under a whitelisted environment — `env -i` with `PATH`, `HOME` and
fresh temporary `PASEO_HOME` and `SLP_DAEMON_HOME` — because inherited `SLP_*`
values or live daemon state fake failures; remove the temporary homes after
recording results. Add focused checks for changed contracts or runtime
behavior, and keep a failing full-suite run beside any focused pass.

Each required check leaves a receipt under the scratch grant: exact command,
environment setup, tool/runtime versions, full stdout and stderr, exit code,
receipt path and SHA256. A live Paseo version that was not exercised stays a
named limit; package inspection and local tests do not prove live
compatibility.

Pin the candidate with the installed SLP snapshot helper before and after
review, and pause the writer while independent review runs. A changed snapshot
means correcting the candidate, rerunning affected checks and repeating the
gate on the new snapshot.

Done: the reviewed snapshot is stable, every required check has an actual
result and receipt, and limits remain visible.

## 8. Hand back

The Lead sends the project verdict — `ACCEPT`, `CHANGES_REQUESTED` or
`BLOCKED` — to the assigned Supervisor as a separate handback message.
Reviewers report only their own axis. Report in order:

1. **Impact:** upstream versions, dates and sources, baseline pins, classified
   deltas, touchpoints and recommendation.
2. **Decision:** no update, authorized update, or the exact Human decision
   still needed; name the approved write scope.
3. **Change:** artifact paths, concise diff summary, generated payload status
   and stable candidate identity.
4. **Verification:** commands and environment, receipt paths and SHA256, exit
   codes, candidate identity before and after review, the separate Spec and
   Standards results, then the Lead's verdict.
5. **Limits:** unreviewed package surface, missing release notes, absent
   live-runtime evidence, compatibility risks and unsettled resources.

With the verdict, update `.paseo-slp/references/upstream-baseline.md` within
the granted write scope: Assessed, coverage, date and outcome per package,
Pinned when an update landed, open items, and where the report lives. A "no
plugin change" outcome advances Assessed too; the record is how the next sync
skips work already classified. Without write scope for it, hand the exact
table rows back with the verdict.

Done: the Human or assigned Supervisor can see what was assessed, why the
chosen action follows and what evidence supports the handback, and the
baseline record matches the verdict.

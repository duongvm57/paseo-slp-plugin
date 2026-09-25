---
name: paseo-slp-upstream-sync
description: Lead-only macro workflow to assess new Paseo upstream releases against paseo-slp and carry out an authorized plugin sync. Use when an @getpaseo package or Paseo release may affect the plugin; not for unrelated dependency bumps or Peer micro-tasks.
---

# Sync paseo-slp with Paseo upstream

Use this skill to turn each upstream release into an evidence-based plugin impact report and, when the active assignment grants the write scope, a verified update. A release alone does not authorize dependency, compatibility, runtime, or product changes.

This is a **Lead macro skill**. Only the project Lead who owns framing, integration, review and technical acceptance runs the full workflow and reads the full `.paseo-slp/workspace-protocol.md`. A Supervisor may route or observe it under their assignment. A Peer must not run this workflow, decide versions or compatibility, orchestrate the review gate, or issue ACVERDICT. If the Lead delegates a bounded micro-slice, the Peer follows that assignment and only the task-relevant constraints supplied by the Lead; it does not read the full workspace protocol by default.

## 1. Establish the baseline

Read the repository's `AGENTS.md`, the full `.paseo-slp/workspace-protocol.md`, and current assignment. Record the repository, branch/commit, existing working changes, upstream release being assessed, and the permitted write scope. Preserve unrelated work. Follow the repository protocol's recipe, isolation, review gate, and verification rules.

When `.local-checks/upstream-v092/report.md` is present or designated as prior evidence, read it as a reference for the investigation method and evidence shape. Treat its v0.9.2 conclusions as release-specific; independently verify facts for the current target. Keep that report and every sibling artifact under `.local-checks/upstream-v092/` read-only. Write current-run evidence only to a fresh, assignment-authorized scratch path.

Read the current version pins and exports from `package.json`, `package-lock.json`, `plugin/package.json`, and `plugin/paseo-plugin.json`. Record versions separately for `@getpaseo/plugin`, `@getpaseo/client`, `@getpaseo/protocol`, `@getpaseo/cli`, and `@getpaseo/server`; some may be host packages rather than direct plugin dependencies. Do not infer a pin from another package or assume all packages share a release number.

The tracked checkout assessment is read-only. Every scratch mutation is a write: creating directories, `npm pack` tarballs, extracting packages, redirecting diff/log output, and writing reports all require the assignment to grant the exact scratch path. Keep investigation artifacts under `.local-checks/skill-upstream-sync/<release>/` only when that path is granted; otherwise use the exact path named by the assignment. If no scratch-write grant exists, do not create files, run `npm pack`, extract tarballs, or redirect output. Continue only with permitted console-only/read-only evidence; if that cannot answer the question, report the evidence gap and request the needed grant before proceeding. Do not install or upgrade a live Paseo daemon, change host configuration, commit, or publish unless separately authorized.

Done: current pins, supported Paseo range, worktree baseline, target release, and write authority are explicit.

## 2. Find the upstream release

Query npm for each package so independent package versions and dist-tags are visible:

```sh
for name in plugin client protocol cli server; do
  npm view "@getpaseo/$name" version dist-tags --json
done
```

Compare published versions and publication times with the recorded pins. For the candidate version of each relevant package, capture its exact metadata and tarball reference:

```sh
npm view "@getpaseo/plugin@<target-version>" version time dist.tarball repository --json
```

Repeat for each package being assessed. Follow the package repository to its release notes, changelog, or release tag when available. Read notes from the last version represented by the current pin through the target version; if a source is unavailable, record that gap and do not treat the version number as release evidence.

Done: a per-package baseline/target table includes exact versions, dates, release-note sources, and any inaccessible evidence.

## 3. Compare package surfaces

First map what this checkout actually consumes:

```sh
rg -n '@getpaseo/' plugin package.json plugin/package.json
```

Before any archive operation, confirm that the assignment explicitly grants scratch-write authority for the exact release scratch directory. `npm pack` creates a tarball; extraction creates trees; `diff` redirection writes evidence. If the grant is absent, stop before these commands and follow the console-only path or report the blocker described in Step 1.

Use `npm pack` at the recorded baseline and target version for each of the five packages. For directly pinned packages, read the baseline from the lockfile. If `cli` or `server` is not pinned by the plugin, use the version associated with the currently supported/observed Paseo runtime and label that source; never present a host version as a plugin pin. Keep the resulting `.tgz` files and extracted `package/` trees in the authorized release scratch directory; do not replace the checkout's installed dependencies during impact assessment. For example:

```sh
scratch=".local-checks/skill-upstream-sync/<release-id>"
mkdir -p "$scratch"
npm pack "@getpaseo/plugin@<pinned-version>" --pack-destination "$scratch"
npm pack "@getpaseo/plugin@<target-version>" --pack-destination "$scratch"
```

Extract the printed tarball filenames into separate versioned folders, then diff those extracted trees. For example:

```sh
mkdir -p "$scratch/plugin-pinned" "$scratch/plugin-target"
tar -xzf "$scratch/getpaseo-plugin-<pinned-version>.tgz" -C "$scratch/plugin-pinned"
tar -xzf "$scratch/getpaseo-plugin-<target-version>.tgz" -C "$scratch/plugin-target"
diff -ruN "$scratch/plugin-pinned/package" "$scratch/plugin-target/package" > "$scratch/plugin.diff"
```

Compare the package export map, public `.d.ts` entrypoints and barrels, payload/schema files, and relevant runtime `.js` files. Save the file list and `diff -ruN` output for each package; exit code 1 means differences were found, while a larger code indicates a diff error. Trace moved declarations through their barrels: a file move is not an API removal when the symbol remains re-exported. Check public exports as well as runtime semantics; a type-only diff misses behavior changes.

Use release notes and the tarball diff together. For `@getpaseo/server` and `@getpaseo/cli`, focus on exported contracts and host/CLI behavior that the plugin actually relies on; avoid treating unrelated distribution churn as plugin impact. Record the exact files inspected and any unreviewed surface.

Done: every changed public or relied-on surface is classified as used, unused, preserved through re-export, or unresolved, with source evidence.

## 4. Trace changes to plugin touchpoints

For each material change, identify the concrete import, payload, lifecycle, or process behavior it could affect. Use this map, then verify it against current code:

| Upstream surface | paseo-slp touchpoints |
|---|---|
| Plugin server contracts, RPC, hooks, lifecycle | `plugin/index.server.ts`, `plugin/server/*` |
| Plugin client hooks, navigation, UI contracts | `plugin/index.client.tsx`, `plugin/client/*` |
| Protocol schemas and serialized payloads | `plugin/server/config-view.ts`, `config-transaction.ts`, relevant `plugin/server/*` consumers, and `plugin/server/generated/runtime-payload.ts` |
| Host/CLI launch behavior, argv, environment, or provider resolution | `plugin/server/launchers.ts`, `executables.ts`, `provider-catalog.ts`, and the affected server-side caller |
| Compatibility range | `plugin/paseo-plugin.json` (`requirements.paseo`) |
| Dependency resolution and bundled build inputs | root `package.json` / `package-lock.json`, `plugin/package.json`, and the plugin payload generator |

Confirm which SDK code is host-supplied and which protocol or other content is bundled by the current plugin build. Do not infer runtime behavior solely from the repository's TypeScript dependency version. A host-side fix can remove the need for a plugin edit; a bundled payload can still be stale when a dependency pin changes.

Done: the impact map connects each relevant upstream change to an actual plugin touchpoint or records why it has no effect.

## 5. Assess impact before updating

Classify each change using behavior and compatibility, not semver labels alone:

- **Additive:** new exports, optional fields or parameters, relaxed validation, preserved re-exports, or host fixes that retain the contracts this plugin uses. State whether any code or dependency update is actually needed; “no plugin change” is a valid result.
- **Potentially breaking:** removed or renamed used exports, tightened required fields or schemas, changed payload/event meaning or defaults, altered CLI/launch behavior the plugin relies on, or a host version outside the currently supported range. Verify whether the change is truly incompatible with this plugin and with every Paseo version the manifest still claims to support.
- **Unresolved:** missing release evidence, unexamined paths, unclear runtime/bundle boundaries, or behavior that cannot be inferred from types. Keep it unresolved; do not convert absence of evidence into compatibility.

Before any write, deliver an impact report with the per-package version table, release evidence, additive/breaking/unresolved findings, affected touchpoints, compatibility consequences, recommended update/no-update options, and remaining evidence gaps.

Proceed with an update only when the active assignment covers the exact dependency, code, payload, and compatibility writes required. Ask the Human for a decision when a change would drop or narrow supported Paseo versions, requires a breaking adaptation or user-visible behavior choice, adopts an optional upstream capability, exposes a security/privacy trade-off, or exceeds the current grant. If authority covers assessment only, stop after the report. Never widen or narrow `requirements.paseo` just to match the newest release.

Done: the recommendation and the Human/assignment decision that unlocks any write are recorded before mutation.

## 6. Apply an authorized update

Update only the direct dependencies and touchpoints required by the accepted decision. For the root pins, pass each package's separately selected version to npm so it updates `package.json` and `package-lock.json` together:

```sh
npm install --save-dev --save-exact \
  "@getpaseo/plugin@<plugin-version>" \
  "@getpaseo/client@<client-version>" \
  "@getpaseo/protocol@<protocol-version>"
```

Then align the corresponding `@getpaseo/protocol` pin in `plugin/package.json` with the approved version. Do not hand-edit the root lockfile or add `@getpaseo/cli` or `@getpaseo/server` as plugin dependencies just because they were inspected.

Adapt code narrowly to the verified contract. Change `plugin/paseo-plugin.json` only when the approved compatibility decision requires it, and explain which host versions remain supported. Regenerate the plugin payload after changing its source inputs:

```sh
npm run generate:plugin-payload
```

Review the generated diff and confirm it contains only the intended source-derived changes. Do not install, reload, or upgrade a live plugin/daemon unless the assignment separately grants that operation.

Done: manifests, lockfile, source, compatibility range, and generated payload agree with the accepted decision; the exact diff is reviewable.

## 7. Verify the frozen candidate

Read current scripts from `package.json`. Run the checks required by the workspace protocol on the candidate. For this repository, the expected checks are:

- `npm test` under a whitelisted environment (`env -i` with `PATH`, `HOME` and fresh temporary directories for both `PASEO_HOME` and `SLP_DAEMON_HOME`), so no inherited `SLP_*` value or live daemon state leaks in; clean up the temporary homes after recording results.
- `npm run typecheck`
- `npm run check`
- `npm run check:plugin-payload` (the payload `--check` script)

Capture the **full stdout and stderr** for each required check in an inspectable receipt under the authorized scratch path. Record the exact command and environment/isolation setup, tool/runtime versions, complete output, exit code, receipt path, and receipt SHA256. Do not reduce a failing full-suite run to a focused-test pass; retain both outputs separately. If no receipt write path is authorized, request it before running checks whose evidence must be retained. Add focused checks for changed contracts or runtime behavior. If a live Paseo version was not exercised, say so; local tests and package inspection do not prove live compatibility.

Pin the candidate with the installed SLP snapshot helper before and after review. Pause the writer while independent review runs. If the snapshot changes, correct the candidate, rerun affected checks, and repeat the gate on the new snapshot.

Done: the reviewed snapshot is stable, all required checks have actual results, and limitations remain visible.

## 8. Hand back

The Lead owns the project verdict and sends it to the assigned Supervisor as a separate handback message. State `ACCEPT`, `CHANGES_REQUESTED`, or `BLOCKED`; reviewers report only their own axis disposition and never issue the project ACVERDICT. Report these items in order:

1. **Impact:** upstream versions/dates/sources, baseline pins, classified deltas, touchpoints, and recommendation.
2. **Decision:** no update, authorized update, or the exact Human decision still needed; name the approved write scope.
3. **Change:** artifact paths, concise diff summary, generated payload status, and stable candidate identity.
4. **Verification:** exact command and environment, full output/receipt path and SHA256, exit code, candidate identity before/after review, and separate Spec and Standards gate results required by the workspace protocol; then the Lead-owned ACVERDICT.
5. **Limits:** unreviewed package surface, missing release notes, absent live-runtime evidence, compatibility risks, and any unsettled resources.

Done: the Human or assigned Supervisor can see what was assessed, why the chosen action follows, and what evidence supports the handback.

# Repository skill layout

Operational facts for "Routing and skills" in
`.paseo-slp/workspace-protocol.md`; the rules stay there. Verified 2026-09-25.

Two skill homes, by audience:

| Home | Ships in payload | Holds |
|---|---|---|
| `skills/<name>/` | Yes — every install receives it | Skills for repositories using paseo-slp (onboarding, e2e) |
| `.agents/skills/<name>/` | No | Skills for maintaining this repository only (upstream-sync) |

Codex reads `.agents/skills/` directly. Claude reads `.claude/skills/`, so each
repository-scoped skill has a relative symlink there. `.agents/` is otherwise
gitignored for skills CLI installs; `.gitignore` whitelists each tracked
repository-scoped skill by name.

Add a repository-scoped skill `<name>` from the repository root:

```bash
mkdir -p .agents/skills/<name>
# write .agents/skills/<name>/SKILL.md with frontmatter name + description
printf '!.agents/skills/<name>/\n' >> .gitignore
ln -s ../../.agents/skills/<name> .claude/skills/<name>
test -e .claude/skills/<name>/SKILL.md            # Claude sees it
! git check-ignore -q .agents/skills/<name>/SKILL.md  # git tracks it
```

Moving a skill between homes changes the payload: run
`npm run generate:plugin-payload` and commit the regenerated file.

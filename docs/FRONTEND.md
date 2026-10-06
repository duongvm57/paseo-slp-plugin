# Frontend

The plugin embeds a React Native surface under `plugin/` (Paseo desk UI for
supervision, assignments, and report records). Conventions live with the code —
see `plugin/` and `docs/plugin-explained.html` for the operator-facing view.

Notes for contributors:

- UI-facing runtime code lives under `plugin/server/runtime/` and
  `plugin/shared/runtime/` — it is payload (`installUnitPaths`), so bytes and
  modes are byte-compared; keep modes 644/755.
- No standalone web frontend exists in this repo; do not scaffold one without
  a contract change.

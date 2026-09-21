# {{PROJECT_DISPLAY_NAME}} — Project rules

> This file is a stub. On first container boot, ask Claude :
>
> > Based on `.devcontainer/claude/CLAUDE-dev.md` (general dev rules)
> > and looking at this project's package.json / README /
> > directory structure / any CONTRIBUTING.md, generate the
> > project-specific rules for `.devcontainer/claude/CLAUDE-project.md`.
>
> Until then, Claude operates with `CLAUDE-dev.md` (general dev rules)
> + `CLAUDE-reviewer.md` (reviewer mode) only — project-specific
> guidance will be missing.

## Conventions

> **TODO** — rules below are written for Node.js / TypeScript by
> default (this repo's typical stack). If this project is in another
> language (PHP, Python, Go…), adapt or remove the JS-specific
> bullets at first boot.

**Default stack** : {{PROJECT_STACK}}.

_(still to fill in : framework / build commands / test commands)_

### Perf preferences (greenfield code only — §4 wins for existing code)

- **Object iteration: `for…in` by default.** `Object.entries` /
  `Object.keys` / `Object.values` allocate an intermediate array on
  every call. `for (const k in obj) { const v = obj[k] }` iterates
  directly over enumerable keys with zero allocation. Reproduce this
  pattern as-is.
- **No `Map` / `Set` by default.** For common cases — lookup,
  deduplication, counting — a plain object `{}` and an array are
  enough and faster (`Map`/`Set` are wrappers with overhead). Before
  reaching for `Map` because your key happens to be an object, ask:
  **is there a natural string identifier?** (id, name, uuid, path…).
  If yes, use a plain object keyed by that string — don't promote an
  accidental object-key into a reason to use `Map`. `Map`/`Set` is
  justified only when semantics truly require it: keys that can't
  reduce to a string, `.size` needed without recompute, or stable
  insertion-order iteration with frequent deletions.

## Architecture

_(to fill in : top-level dirs / data flow / entry points)_

## Gotchas

_(to fill in : non-obvious constraints, brittle areas, owner notes)_

# CLAUDE.md — Dev guidelines

Behavioural guidelines for *implementation tasks*: writing code,
fixing bugs, refactoring, building features. Goal — reduce common LLM
coding mistakes (drift, over-engineering, false-done).

**Bias declared:** caution over speed.

**Scope.** These rules apply when the user asks you to *do dev work*.
For questions, exploration, or "explain X" / "where is Y" requests,
answer directly — no plan mode, no ceremony, no verification loop.
Use judgement; if a "simple question" turns out to require a code
change, switch to the rules below before editing.

For project-specific rules (stack, conventions, repo layout,
environment), read [CLAUDE-project.md](.devcontainer/claude/CLAUDE-project.md).

## 1. Plan Mode default

Enter plan mode for any non-trivial dev task — anything with **3+
steps**, an **architectural decision**, or where the right approach
isn't obvious. Plan mode is for *both* building and verification, not
just building.

Write the plan upfront. Detailed specs reduce ambiguity and let the
user catch drift before code is written.

If something goes sideways mid-execution, **STOP and re-plan
immediately**. Don't keep pushing through a plan that no longer fits
reality.

**Multi-session work.** When a task is too large for a single session
(≥3 sessions of work — a feature rollout, a refactor across many
files, a migration), propose the `/prepare-plan` skill. It scaffolds
a dedicated rollout directory (ROLLOUT + STATUS + LOG + EXISTING +
sessions/) so progress survives session boundaries.

## 2. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations of the request exist, present them —
  don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

This is the cheapest moment to catch a misunderstanding. Five minutes
of clarification beats two hours of rework.

## 3. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Self-check: *"Would a senior engineer say this is over-engineered?"*
If yes, simplify.

**No laziness either** — find root causes, not temporary workarounds.
The simplest solution is rarely the laziest one.

## 4. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans, remove imports / variables /
functions that *your* changes made unused. Don't remove pre-existing
dead code unless asked.

The test: **every changed line should trace directly to the user's
request.** Anything else is scope creep — propose it as a separate
task instead of folding it in.

## 5. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform vague tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them
  pass."
- "Fix the bug" → "Write a test that reproduces it, then make it
  pass."
- "Refactor X" → "Ensure tests pass before and after."

For multi-step tasks, state a brief plan with verification per step:

```
1. [step] → verify: [check]
2. [step] → verify: [check]
3. [step] → verify: [check]
```

Strong criteria let you loop independently. Weak criteria ("make it
work") require constant clarification.

## 6. Verification Before Done

**Never mark a task complete without proving it works.**

- Run the tests. Check the logs. Demonstrate correctness with a
  concrete artefact (test pass, log line, screenshot, output).
- When relevant, diff behaviour between `main` and your changes.
- Ask yourself: **"Would a staff engineer approve this?"**

**Autonomous bug fixing.** Bug reports come with everything you need
— the failing test, the error log, the stack trace. Just fix it.
Don't ask the user to walk you through the diagnosis. Point at the
evidence, form a hypothesis, resolve it, verify.

A task is not done until verification passes. "It compiles" isn't
verification.

## 7. Subagent Strategy

Use subagents liberally to keep the main context window clean.

- Offload research, exploration, and parallel analysis to subagents.
- For complex problems, throw more compute at it via parallel
  subagents — one tack per subagent, focused execution.
- Reserve the main thread for synthesis and decisions; subagents
  handle the legwork.

When in doubt: spawn a subagent rather than read twenty files in the
main context.

## 8. Self-Improvement Loop

After any correction from the user, capture the rule so the mistake
doesn't repeat. Three storage layers, picked by scope:

- **`.devcontainer/LESSONS.md`** (root symlink for visibility,
  **committed**) — project-wide patterns useful to anyone on this
  codebase. Recurring pitfalls, team conventions surfaced via
  correction, gotchas about the code. Merge across devs via git.
- **`.devcontainer/LESSONS.local.md`** (**gitignored**) — personal or
  not-yet-generalisable lessons. Local setup quirks, tentative
  patterns. Safe default for ambiguous cases — promote to
  `.devcontainer/LESSONS.md` later if the pattern proves general.
- **Auto-memory `MEMORY.md`** (cross-project, see `# auto memory`
  section in the root CLAUDE.md) — cross-project user preferences
  and feedback that aren't tied to this codebase.

Entry shape (LESSONS.md / LESSONS.local.md): one bullet per lesson —
**rule** first, then *Why* and *How to apply* on the same or
following line. Keeps git diffs readable.

**Review all three at session start** for any lesson relevant to the
incoming task.

## 9. Demand Elegance

For non-trivial changes, pause and ask: **"Is there a more elegant
way?"** If a fix feels hacky, retry — *"Knowing everything I know
now, implement the elegant solution."* Skip this for obvious fixes;
don't over-engineer trivial work. Challenge your own diff before
presenting it.

## 10. Commits

**Run tests before proposing the commit.** Whether tests are manual,
automatic, or combined (long-running suites in the background while
you proceed), they must pass before you propose the commit. A
failing test is a not-done state — fix it first, don't commit and
"address in follow-up". This is §6 Verification operationalised at
the commit step.

**Never `git commit` without an explicit user request.** When tests
pass and the change looks done, *propose* the commit verbally —
including the proposed message — and wait for the user to confirm
(or amend the message) before running `git commit`. Don't commit on
your own initiative and ask for retroactive approval.

**Commit messages self-contained.** Describe the change in its own
words: what was added / modified / fixed and why. Do NOT reference
rollout plans, session IDs, phase numbers, or tracker artefacts that
aren't part of the commit itself — a commit is read by people without
the plan open (reviewers, future-you, `git blame`). Plan IDs decay;
the change description stays useful. Exception: the user explicitly
asks for a plan reference in the message.

## 11. Devcontainer signals

Some skills ship a `hooks.json` that `sync-skills.sh` merges into
Claude settings at container boot. SessionStart hooks can inject
`<system-reminder>` context surfacing state Claude can't detect
mid-conversation. Treat these signals as authoritative for the state
they describe.

Active signals :

- **scan-deps signal: project npm manifests changed since last
  firewall extract** → before any dependency-touching work, propose
  `/scan-deps` to the user. Don't run it autonomously. If the user
  declines or postpones, drop the topic and don't re-raise it the
  same session.

## 12. Project context bridge

These guidelines describe *how* to do dev work. They are deliberately
silent on stack, language, conventions, and environment — those are
project-specific and live in [CLAUDE-project.md](.devcontainer/claude/CLAUDE-project.md).
Read that file before starting work on this project.

## 13. Code style — perf + clarity

For code **you write** (§4 still wins for existing code) :

- **Single-read property access.** Any property read more than once
  in a scope is hoisted to a `const` at the top. Applies to deep
  chains (`a.b.c`) and to repeated `.length` alike. Gain: readability
  + a single dereference.
- **No nested `if` on the same value.** When two levels of `if` test
  the same variable against different thresholds, collapse to a flat
  `if / else if` chain ordered from most restrictive to broadest.
  Branching becomes linear, indentation drops one level.
- **Dependency-add hygiene.** Three conditions before `npm install`
  (or composer / pip / …) :
  - **No known CVE / vulnerability** — hard requirement, never
    relaxed.
  - **Latest stable version** available. Never write the version
    from memory — query the registry (`npm view <pkg> version`,
    `composer show -a <pkg>`, …) right before editing the
    manifest. Memory lags by major versions and silently picks an
    outdated baseline.
  - **Trust in the package** — any one of these signals is enough:
    actively maintained (recent commits, issues handled), widely
    adopted (downloads, dependents, stars), mature and stable
    (« frozen because it's rock-solid » — settled API, no open CVE),
    or small enough to audit in a few minutes. *Not maintained ≠
    outdated.*

Meta-rule : **perf ≥ modern idioms, as long as readability holds.**

## 14. Notification body convention

When you finish a turn — i.e. you are about to **Stop** (no tool call
queued, no explicit question for the user) — append a single short
recap line at the very end of your reply, formatted exactly as :

```
**Recap** — <summary ≤ 80 chars>
```

The summary is parsed by the `notify-queue` hook ([.devcontainer/skills/notify-queue/hook.js](.devcontainer/skills/notify-queue/hook.js))
and fed as the body of the host-side desktop notification. Without
this line, the hook falls back to a markdown-heuristic excerpt of
your first usable line (V1) — usually fine, but less precise than
a recap you crafted on purpose.

Guidelines for the summary :

- **≤ 80 characters.** Beyond that, it gets truncated.
- **Raw UTF-8 after the dash.** Type accents and em-dashes
  directly (`é`, `—`), not as `\uXXXX` escapes or HTML entities.
  No nested bold, no emoji, no backticks — the host notification
  renders as system text.
- **Action-oriented, past tense.** "Tests passing, PR ready",
  "Build failed — see logs", "Refactor done, 3 files touched".
  Not "I have completed the task".
- **Skip if your reply is just an acknowledgement.** No recap → V1
  fallback fires ; that's the right behaviour for "ok", "done", or
  a one-line answer.
- **Don't add the recap for mid-turn outputs.** Tool calls, plan
  proposals, clarifying questions — those aren't "Stop" events ;
  the hook won't see your recap there.

The recap is visible in the chat (unlike a hidden HTML comment which
the Claude Code VS Code extension renders as raw text anyway). Keep
it terse so it reads as a clean summary line, not noise.

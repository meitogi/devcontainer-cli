# CLAUDE.md — Local Ollama mode addendum

> **Read also** : [CLAUDE-dev.md](CLAUDE-dev.md) — the baseline dev rules
> still apply. This file layers local-mode adjustments on top.

You are running against a local Ollama backend (`http://ollama.internal:11434`).
The model has a far smaller context window than Anthropic cloud and weaker
tool-calling + agentic capabilities. Adjust your work pattern accordingly.

## Context window — assume ~32-64k tokens, not 1M

Default model on this Mac is `qwen3.6-35b-a3b` (or similar), typically
running with a 32-64k context in Ollama. That's 15-30× smaller than the
cloud Opus window. Plan accordingly :

- **Don't read whole files in one shot.** Use `Read` with `offset` +
  `limit` even for moderately-sized files (>500 lines). The cloud habit
  of "just Read the whole thing" doesn't work here.
- **Avoid spawning subagents.** `Agent` / `Explore` / `Plan` all stack
  their full output back into your context. One subagent return can eat
  30-50% of your budget.
- **No parallel multi-file reads.** Even 5 `Read` calls in parallel can
  blow the budget. Read one, decide, read the next.
- **Skip `WebFetch` for long pages.** A docs page summary easily runs
  3-5k tokens — with a 32k budget, that's 10-15% per fetch.

## Tool calling — expect failures

Local models often handle tool_use blocks worse than cloud models :

- **One tool per turn when possible.** Long chained "Read X then Edit Y
  then run tests" sequences lose arguments or misuse parameters.
- **Re-verify on apparent success.** Tool result parsing can
  mis-attribute output. Re-read a file you just edited if the change
  looks suspicious.
- **No multi-tool parallel calls.** Cloud-mode parallel calls (multiple
  Read/Bash in one block) often confuse local models. Serialize them.

## Coding style

- **One small change per turn.** Bigger refactors cumulate context fast.
- **No speculative exploration.** Don't browse the codebase just to
  understand — only read what you need for the current change.
- **No long internal narration.** Skip "Let me think about this..."
  paragraphs — local models often perform worse with extended
  chain-of-thought in tool-use contexts.

## Auto-compaction is unreliable

Cloud Claude compacts intelligently when the conversation grows long ;
local models often produce poor summaries that lose critical context.
**Prefer ending the session and starting fresh** over relying on
compaction. If a task takes longer than 20-30 turns, finish what you
can, persist the state somewhere durable, and recommend resuming in
a new session.

## Confabulation — sanity-check claims

It's the model. Cloud Claude rarely confabulates file paths, function
names, or syntax ; local models do this regularly. Before acting on a
specific claim about the code :

- If the file path is named, `ls` it.
- If a function is named, `grep` for it.
- If a flag / config value is asserted, read the actual config file.

The cost of one extra read is negligible vs the cost of editing the
wrong file.

## Escape hatch — back to cloud for load-bearing work

For anything load-bearing — security review, ambiguous architecture
decision, code that ships to production, anything where being wrong is
expensive — switch back to cloud :

```
claude-switch cloud
# then start a fresh Claude Code session
```

Local mode is for exploration, sketching, offline/private work, and
prompt experimentation. It's NOT for high-stakes work — use cloud for
those, and come back to local when latency and cost matter more than
quality.

## Session isolation

This local mode runs with `CLAUDE_CONFIG_DIR=/home/node/.claude-local`,
so :
- Session history, todos, and `.credentials.json` are isolated from cloud
  mode (you can't see what you did in cloud mode last week).
- Skills, commands, memory, and settings are symlinked from `~/.claude`,
  so they stay shared (any new skill installed in cloud propagates here).
- Cloud OAuth creds in `~/.claude/.credentials.json` are NEVER touched
  by anything you do here.

<!-- 1B-LIGHT-MODEL-DIRECTIVES-START -->
<!-- variant: V1-explicit-tiny-model -->

## You run on a small local reasoning model

This proxy bridges Claude Code to a local Ollama model with limited
context and weaker capabilities than cloud Claude. Adjust your behavior :

- **Be concise.** No preamble, no recap, no apology. If the user asks
  `ping` → answer `pong`. Code blocks only when they actually help
  (math alignment, file paths, code samples) — never as decoration.
- **No gratuitous markdown headers.** Avoid `## Section` headers in
  answers under ~10 lines. Direct prose is fine for short answers.
- **Pause before tool use.** Each tool call costs ~10s round-trip on
  this hardware. Read once, decide, act. Avoid speculative greps.
- **Ask for clarification before non-trivial work.** Stop and ask if
  the request is ambiguous — better cheap clarification than expensive
  wrong direction.
- **Don't list options unless asked.** Pick the most reasonable one
  and execute.
<!-- 1B-LIGHT-MODEL-DIRECTIVES-END -->

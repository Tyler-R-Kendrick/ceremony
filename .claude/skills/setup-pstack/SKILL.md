---
name: setup-pstack
description: Configure which models pstack uses per role and at what reasoning budget. Checks that pstack is in place as project skills, detects your available models, and writes an always-loaded rule that overrides the skill defaults. Use for /setup-pstack, "configure pstack models", "pstack budget", or changing pstack's model choices.
---

# Setup pstack

Write `~/.claude/rules/pstack-models.md`, a user rule that Claude Code loads into every session, which sets pstack's model per role.

## Check that pstack is in place

pstack needs no install in this repo. It is here as project skills in `.claude/skills/` and subagents in `.claude/agents/`, and Claude Code loads both in every session started in the repo. `.claude/pstack/PORTING.md` says what this port changed from the Cursor plugin. Before step 1, check these and report the result in one line:

- `.claude/skills/poteto-mode/SKILL.md` exists, and `ls .claude/skills` lists the pstack skill folders.
- `.claude/agents/poteto-agent.md` and `.claude/agents/comment-sicko.md` exist, and the Agent tool's `subagent_type` list names `poteto-agent` and `comment-sicko`. If the files exist and the list lacks them, the session started before the files did. Tell the user to restart Claude Code.
- Every pstack skill but this one is user-invoked only (`disable-model-invocation: true`), so your own skill listing leaves them out. That is expected. The user sees them with `/skills`, and typing `/poteto-help` shows that one runs.

If a file is missing, say which and stop.

## Steps

### 1. Detect available models

Enumerate the models you can pass to an `Agent` subagent in this session. They are the `model` values that the Agent tool's schema lists, such as `opus`, `sonnet`, `haiku`, and `fable`, each with an effort from the schema's `effort` values. That is the dependable source. If you cannot detect any, ask the user to name the models they have access to. Write a real model as `<model> <effort>`, such as `opus xhigh`. Never write a real model you have not confirmed is available. The aliases `inherit-parent` and `auto` are always valid even though they are not detected models.

### 2. Load current state

The default role-to-model mapping is the rule shape shown in step 5 below. If `~/.claude/rules/pstack-models.md` already exists, read it and treat its `# budget` line and its role values as the current choices. Otherwise start from those defaults. A line whose role is not in step 5, such as `how explorer` or `why investigators`, is from a retired role. Drop it.

A value that is a Cursor slug came from a rule copied over from Cursor, where pstack writes `~/.cursor/rules/pstack-models.mdc`. Before step 3, replace these values:

- A `claude-<family>-<version>-<effort>` slug, with or without a trailing `-fast`, becomes `<family> <effort>`. So `claude-opus-5-5-high-fast` becomes `opus high`.
- Any other slug, such as `gemini-4-carbon-high` or one that matches `grok-*`, becomes `inherit-parent`, because Claude Code runs only Claude models.

Every other value is the user's choice and stays, including every `inherit-parent` or `auto` value. Tell the user which values you replaced.

### 3. Budget, map, and confirm

**(a) Ask for a budget.** Prefer AskUserQuestion over free text. Offer these four options with these exact labels, and name the current budget when the rule records one. With no rule, say that `large` matches the skill defaults.

- `unlimited — max reasoning`
- `large — xhigh reasoning`
- `medium — high reasoning`
- `small — medium reasoning`

**(b) Apply it.** Build the working table from the skill defaults, and on a re-run keep any role you changed by family, list, or alias (`inherit-parent`, `auto`). Families are the ones Phase A of the **arena** skill defines, so Fable is its own family. Each role has a target effort, which is its default's effort moved by the budget. `large` keeps it, `unlimited` raises it one step, `medium` lowers it one step, and `small` lowers it two steps, on the ladder `max` > `xhigh` > `high` > `medium` > `low`. A target at either end of the ladder stays there. Most defaults are at `xhigh`, and each budget label names where those land. Set the effort of every real value in the role, panel entries included, to the role's target. The effort is the last token. If the result is not a detected model and effort, use the same family's detected value with the highest effort at or below the target, else mark the role as needing a choice. `inherit-parent` and `auto` do not change. So `unlimited` turns `opus xhigh` into `opus max` and `opus high` into `opus xhigh`, and it keeps `fable max`. `small` turns the first two into `opus medium` and `opus low`. Claude Code has no fast variant and no Gemini model for a subagent, so never write one.

**(c) Show the roles and confirm.** Show every role with its model, marking any real value not in the detected set as needing a choice. Also list each line step 2 dropped. Ask whether to accept as-is or change specific roles, offering the detected models plus `inherit-parent` and `auto` (both mean: this role runs on the parent chat model) as the options. Prefer AskUserQuestion over free text. For panel roles (arena runners, architect runners, interrogate reviewers) the value is a list, and one subagent runs per entry, alias entries included, so the list length sets the count. `arena cross-judge pool` is also a list, but Arena runs one judge. It tries only values from a vendor other than the parent's, in list order, so order it by preference. Fable and the other Claude models are one vendor. An `inherit-parent` or `auto` value never judges. Claude Code runs only Claude models, so with a Claude parent no value in this pool judges and Arena skips the judge. Say so when you show the role. `swarm workers` is the default model for every worker unless a race or comparison assigns another model per arm.

### 4. Validate

Every real value written must be in the detected set. `inherit-parent` and `auto` always pass. If a chosen real value is not available, stop and ask again.

### 5. Write the rule

Write `~/.claude/rules/pstack-models.md` with no frontmatter, so that Claude Code loads it in every session. Give it the comment lines, the `# defaults: 2` line, a `# budget` line with the chosen label and the effort that label names, and one line per role, using the same labels poteto-mode uses. Overwrite the whole file so re-runs stay idempotent. Never put the role lines in `CLAUDE.md` or `AGENTS.md`. Shape:

```
# pstack model configuration. One line per role. Delete a line to fall back to the skill default.
# A value is `<model> <effort>`: the Agent call's `model` and `effort`.
# `inherit-parent` or `auto` as a value: the role runs on the parent chat model (omit Agent `model`). Alias entries in a panel list still count toward its fan-out.
# defaults: 2
# budget: large (xhigh)
feature, refactoring: opus xhigh
bug-fix: opus xhigh
perf-issue: opus xhigh
hillclimb: opus xhigh
judgment and prose: opus xhigh
hardest tasks: fable max
reflect tooling: opus high
reflect judgment, divergent, synthesizer: opus xhigh
arena runners: fable high, opus high, inherit-parent
arena cross-judge pool: fable high, opus high, inherit-parent
swarm workers: opus high
architect runners: fable high, opus high, inherit-parent
interrogate reviewers: fable high, opus high, inherit-parent
```

### 6. Confirm

Tell the user the rule was written and that it applies to new sessions. Re-running this skill updates it.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with /create-verification-skill." On yes, run `/create-verification-skill`: read `.claude/skills/create-verification-skill/SKILL.md` and follow it, because the Skill tool refuses a user-invoked skill. On no, move on without pushing.

### 8. Offer a formal verification skill (optional)

Check whether the project already has a formal verification skill (a project skill that runs a model checker, a proof, or another verifier against the code). If not, offer once: "want a formal verification skill, so agents can prove a key property of your code holds in every case in scope, not only the cases tests reach? I can generate one with /create-formal-verification-skill." On yes, run `/create-formal-verification-skill`: read `.claude/skills/create-formal-verification-skill/SKILL.md` and follow it, because the Skill tool refuses a user-invoked skill. On no, move on without pushing.

## Claude Code notes

- pstack skills are user-invoked only (`disable-model-invocation: true`), so the Skill tool refuses them. To run one that this skill names, as the **name** skill or as `/name`, read `.claude/skills/<name>/SKILL.md` and follow it. A **name** principle skill is `.claude/skills/principle-<name>/SKILL.md`.
- When the session has no `AskUserQuestion` tool, as in a non-interactive (`-p`) run, ask in plain text.

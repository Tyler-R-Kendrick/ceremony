---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for /swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
disable-model-invocation: true
---

# Swarm

## Start

Open a todolist with one entry per phase before launching anything.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
3. Pick the worker model from the `swarm workers` line in `~/.claude/rules/pstack-models.md`. If the rule or that line is missing, use `opus high`. For `auto` or `inherit-parent`, omit `model` so the workers run on the parent model. If the Agent tool rejects a value, use the default and say so. If it rejects the default, use the closest valid model of the same family from its error message. For a model race, name each arm's model up front. Pick each subagent's reasoning level for the job, per the Subagents section of the **poteto-mode** skill.
4. Give each worker its own writable output when it writes. When workers verify or measure commits, each brief names the exact SHAs. A measurement brief also names the method (sample count, what one sample is, order). The worker records both in its result.

## Phase B: Fan out

Spawn all N workers in one message with `subagent_type: "general-purpose"`, `isolation: "worktree"`, in the background, and the step 3 model, left unset for `auto` or `inherit-parent`. Claude Code has no cloud VM for a worker, so each worktree is a separate checkout on the user's computer. Omit `isolation` only when the worker must run in the parent's own checkout.

A worktree starts from the default branch. When a worker must start from another pushed branch or commit, name it in the brief and tell the worker to check it out first.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence. A worker that can prove a defect reports `ISSUES` and lists every issue it can prove, not only the first.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results. Drop a result that does not record the SHAs and method its brief names, and respawn that worker once. After a second miss, record a gap. A gap does not count as a pass. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

## Phase D: Report

Return one consolidated in-chat report with a result table, issue one-liners, gaps or dropouts, and the race rule when used.

## Claude Code notes

- pstack skills are user-invoked only (`disable-model-invocation: true`), so the Skill tool refuses them. To run one that this skill names, as the **name** skill or as `/name`, read `.claude/skills/<name>/SKILL.md` and follow it. A **name** principle skill is `.claude/skills/principle-<name>/SKILL.md`.
- A todolist is the session's task list (`TaskCreate` and `TaskUpdate`, or `TodoWrite`). When the session has none of these tools, keep the list in your reply and update it at each phase.
- A model value is `<model> <effort>`, such as `opus xhigh`. Pass `model: "opus"` and `effort: "xhigh"` on the Agent call, or only `model` when the Agent tool's schema has no `effort` field. `/setup-pstack` writes the role lines to `~/.claude/rules/pstack-models.md`, which Claude Code loads into every session.

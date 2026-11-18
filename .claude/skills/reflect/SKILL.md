---
name: reflect
description: Spawn three parallel review subagents over the active transcript, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect.
disable-model-invocation: true
---

# Reflect

Mine the current conversation for durable learnings, then route them into skill edits.

Invoke when the user says "reflect" or "/reflect". Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## 1. Locate the active transcript

Before fanning out, find this conversation's transcript. Claude Code keeps this workspace's transcripts in `~/.claude/projects/<slug>/`, where `<slug>` is the workspace path with each character that is not a letter or digit turned into `-` (so `/Users/you/proj` becomes `-Users-you-proj`). Do not glob across `~/.claude/projects/*/`. That crosses workspace boundaries and reads private chats from unrelated projects.

```bash
ls -t <transcripts>/*.jsonl <transcripts>/*/subagents/*.jsonl 2>/dev/null | head -10
```

That covers the session (`<id>.jsonl`) and subagent (`<parent>/subagents/agent-<child>.jsonl`) layouts. For each candidate, read its first JSONL line whose `type` is `user`. Take the file whose `message.content` contains the conversation's opening user prompt. If none matches, pass a tight digest of the session instead.

## 2. Spawn three reviewers in parallel

One message, three `Agent` calls, `subagent_type: "general-purpose"`. Reviewers need MCP access to look up the tickets, chat threads, and observability traces the transcript references, and `general-purpose` keeps the session's MCP servers.

Each reviewer and the synthesizer name a role line in the `pstack-models.md` rule and a default. Set `model` to that line's value, or to the default if the rule or the line is missing. Leave `model` unset when the value is `auto` or `inherit-parent`. If the Agent tool rejects a value, use the default and say so. If it rejects the default, use the closest valid model of the same family from its error message. Pick each subagent's reasoning level for the job, per the Subagents section of the **poteto-mode** skill.

| Lens | Role line | Default `model` | Prompt template |
|---|---|---|---|
| Judgment | `reflect judgment, divergent, synthesizer` | `opus xhigh` | `references/judgment-reviewer.md` |
| Tooling | `reflect tooling` | `opus high` | `references/tooling-reviewer.md` |
| Divergent | `reflect judgment, divergent, synthesizer` | `opus xhigh` | `references/divergent-reviewer.md` |

Pass each template verbatim, substituting the transcript path or digest where marked. Reviewers return findings in the `Agent` result.

## 3. Synthesize

One `Agent` call, `subagent_type: "general-purpose"`, `model` from the `reflect judgment, divergent, synthesizer` line (default `opus xhigh`). It spot-verifies citations through MCP, which `general-purpose` keeps. Pass `references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. It returns an Accepted / Rejected / Backlog list.

## 4. Structural enforcement check

Move any Accepted item that a lint rule, script, metadata flag, or runtime check would enforce more reliably to Backlog. See the **encode-lessons-in-structure** principle skill.

## 5. Apply

Present the synthesizer's full Accepted / Rejected / Backlog output and wait for explicit approval before applying any Accepted edit. The user picks the subset and may redirect routings. Skill changes affect every future agent in the org. Do not auto-apply.

File each Backlog item to your team's devex or backlog tracker without waiting. Only the Accepted list waits for approval.

Never edit a skill under `plugins/cache/`. Before approval, show its destination, `.claude/skills/<skill>/` or `~/.claude/skills/<skill>/`. After approval, copy the skill folder there and edit the copy. Never open a PR or push.

Follow each approved row's Routing exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): the parent does it directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): hand to the `skill-creator` skill and run its draft / test / iterate loop.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): hand to `skill-creator` and run its description-optimization loop.
- `new skill via skill-creator: <kebab-name>`: hand creation to `skill-creator`. Do not invent the shape ad hoc.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done.

## 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed to the devex tracker: `<issue title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.

## Claude Code notes

- pstack skills are user-invoked only (`disable-model-invocation: true`), so the Skill tool refuses them. To run one that this skill names, as the **name** skill or as `/name`, read `.claude/skills/<name>/SKILL.md` and follow it. A **name** principle skill is `.claude/skills/principle-<name>/SKILL.md`.
- A model value is `<model> <effort>`, such as `opus xhigh`. Pass `model: "opus"` and `effort: "xhigh"` on the Agent call, or only `model` when the Agent tool's schema has no `effort` field. `/setup-pstack` writes the role lines to `~/.claude/rules/pstack-models.md`, which Claude Code loads into every session.
- `skill-creator` is Anthropic's plugin, installed with `/plugin install skill-creator@claude-plugins-official`. Upstream names Cursor's built-in `create-skill` here. When `skill-creator` is not installed, author the skill by hand per https://code.claude.com/docs/en/skills.
- Claude Code's SKILL.md validator is `claude plugin validate .claude/skills`.

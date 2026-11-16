# pstack, ported to Claude Code project skills

This folder records a port of **pstack**, a Cursor plugin by Lauren Tan, to Claude Code. The port lives in this repo as project skills and project subagents. Every skill and both subagents are Lauren Tan's work. The port changes only the wording that names Cursor as the host.

| | |
| --- | --- |
| Upstream | https://github.com/cursor/plugins/tree/main/pstack |
| Commit | `bf0c7cd80abdbf7fe47b634978a7d1b4071f71a7` (2026-11-14) |
| Version | 0.15.42 (`pstack/plugin.json`) |
| License | MIT, Copyright (c) 2026 Lauren Tan. [`LICENSE`](LICENSE) is upstream's file, byte for byte. |
| Ported on | 2026-11-16, checked with Claude Code 2.1.325 |

## Layout

| Upstream | Here |
| --- | --- |
| `pstack/skills/<name>/` (58 skills, with their `references/`, `playbooks/`, and `scripts/`) | `.claude/skills/<name>/` |
| `pstack/agents/poteto-agent.md`, `pstack/agents/comment-sicko.md` | `.claude/agents/` |
| `pstack/LICENSE` | `.claude/pstack/LICENSE` |

Claude Code loads `.claude/skills/` and `.claude/agents/` in every session started in this repo. A user runs a skill by typing `/<name>`, such as `/poteto-mode` or `/poteto-help`. 57 of the 58 skills keep upstream's `disable-model-invocation: true`, which Claude Code supports: the user can type them, and Claude cannot load them on its own. `setup-pstack` is the one skill that Claude can load from the user's words, as upstream.

## Formats checked before porting

The port follows the formats in Claude Code's own documentation, read on 2026-11-16, and not memory.

- https://code.claude.com/docs/en/skills. `SKILL.md` frontmatter takes `name`, `description`, `disable-model-invocation`, `paths`, `allowed-tools`, and more. It ignores a field it does not know. A skill is a folder and may ship scripts and other files. A user invokes a skill with `/name`. A skill with `disable-model-invocation: true` has no description in Claude's context and the Skill tool does not run it.
- https://code.claude.com/docs/en/sub-agents. A subagent is a Markdown file in `.claude/agents/` with `name` and `description`, and optional fields such as `tools`, `model`, and `background`. The Agent tool starts one (the tool was named Task before v2.1.63). A call takes `subagent_type`, and can take `model` (an alias such as `opus`, not a full model ID), `effort`, and `isolation: "worktree"`. `SendMessage` to an agent's ID or name resumes it. The built-in read-only type is `Explore`.
- https://code.claude.com/docs/en/memory. Claude Code loads every `.md` file in `~/.claude/rules/` into each session.
- https://code.claude.com/docs/en/tools-reference and https://code.claude.com/docs/en/commands, for tool and command names (`AskUserQuestion`, `TaskCreate`, `/loop`, `/run`).

Upstream also ships its own map from Cursor names to Claude Code names, `pstack/docs/harness/claude-code.md`. Where the Claude Code documentation was silent, the port follows that map, so the choices are the author's. Where the two differ, the port follows the Claude Code documentation: a subagent is resumed with `SendMessage`, where the map says to spawn a new one.

## What changed, and why

93 of the 145 files under `.claude/skills/` are byte-identical to upstream. 52 skill files and both subagent files changed. Every change belongs to one of the kinds below. `diff -r <upstream>/pstack/skills .claude/skills` shows each one.

### 1. Frontmatter

- `skills/poteto-mode/SKILL.md`: removed `icon: crown` and `color: yellow`. They are Cursor fields that Claude Code does not act on.
- `agents/poteto-agent.md`: `is_background: true` became `background: true`, the Claude Code field with the same meaning.
- Neither subagent pins a model upstream, so the port adds no `model` field. Both run on the session's model unless the Agent call names one.
- `skills/typescript-best-practices/SKILL.md` keeps `paths`, which Claude Code supports.
- `skills/setup-pstack/SKILL.md`: the description now says "always-loaded rule" for "always-applied rule" and names the install check.

### 2. Tool and field names

| Cursor (upstream) | Claude Code (here) |
| --- | --- |
| `Task` tool, `Task` call | `Agent` tool, `Agent` call |
| `subagent_type: generalPurpose` | `subagent_type: "general-purpose"` |
| `readonly: true` | `subagent_type: "Explore"` |
| `readonly: false`, "agent mode (readonly strips MCP)" | `general-purpose` or `poteto-agent`, which keep the session's MCP servers |
| `environment: "cloud"`, a Cursor cloud agent, a cloud VM | `isolation: "worktree"`. A worktree is a separate checkout on the same machine, and the skill says so. |
| `cloud_base_branch` | Name the branch in the brief. A worktree starts from the default branch. |
| `run_in_background: true` | "in the background". Claude Code starts subagents in the background by default. |
| resume a subagent | `SendMessage` to its agent ID or name |
| `AskQuestion`, `allow_multiple: true` | `AskUserQuestion`, `multiSelect: true` |
| Shell | Bash |

Example, `skills/how/SKILL.md`:

- Before: "Spawn one Task subagent with `subagent_type: generalPurpose` and `readonly: true` that explores and explains in one pass."
- After: "Spawn one subagent with the Agent tool and `subagent_type: "Explore"`, Claude Code's read-only type, that explores and explains in one pass."

### 3. Models

Cursor names a model with one slug that holds the family, the version, the effort, and the speed. Claude Code's Agent call takes a `model` alias and a separate `effort`, has no fast variant to pick per subagent, and runs only Claude models. So a model value in the port is `<model> <effort>`.

| Upstream slug | Here |
| --- | --- |
| `claude-opus-5-5-xhigh` | `opus xhigh` |
| `claude-opus-5-5-high-fast` | `opus high` |
| `claude-fable-5-2-max` | `fable max` |
| `claude-fable-5-2-high` | `fable high` |
| `gemini-4-carbon-high` | `inherit-parent` (the parent model) |

- The words "slug" and "fast or standard speed" are gone from the model rules. "Pick each subagent's reasoning level and fast or standard speed for the job" is now "Pick each subagent's reasoning level for the job" in 21 files.
- `skills/poteto-mode/SKILL.md`, **Match the model to the job**: the sentences on fast mode, on Gemini's levels, and on Fable's missing fast slug are replaced by one sentence that says Claude Code has no fast variant per subagent. The rules for a rejected value are kept, with "value" for "slug".
- `skills/arena/SKILL.md`: a family is now the entry's model word. `fable` is one family, and `opus`, `sonnet`, and `haiku` are the other.

Example, `skills/swarm/SKILL.md`:

- Before: "Pick the worker model from the `swarm workers` line in `~/.cursor/rules/pstack-models.mdc`. If the rule or that line is missing, use `claude-opus-5-5-high-fast`."
- After: "Pick the worker model from the `swarm workers` line in `~/.claude/rules/pstack-models.md`. If the rule or that line is missing, use `opus high`."

### 4. Paths

| Upstream | Here |
| --- | --- |
| `~/.cursor/rules/pstack-models.mdc` | `~/.claude/rules/pstack-models.md` |
| `.cursor/skills/`, `~/.cursor/skills/`, `~/.cursor/plugins/` | `.claude/skills/`, `~/.claude/skills/`, `~/.claude/plugins/` |
| `~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl` | `~/.claude/projects/<slug>/<uuid>.jsonl`, with subagents in `<uuid>/subagents/agent-<id>.jsonl` |
| `.cursor/worktrees/<repo>/<name>` | `.claude/worktrees/<name>` |

The transcript slug differs too. Cursor drops the leading slash, and Claude Code turns every character that is not a letter or digit into `-`, so `/Users/you/proj` is `-Users-you-proj`. Cursor's system prompt names the transcript folder, and Claude Code's does not, so each skill that reads transcripts now gives the folder rule. This touches `reflect`, `recall`, `automate-me`, `show-me-your-work`, and the `session-pickup` and `eval` playbooks. In `reflect`, the transcript's first user line is found by `type` being `user`, because a Claude Code transcript starts with other event lines.

`skills/poteto-mode/scripts/worktree-audit.sh` is the one script the port edits: three lines that set the transcript folder and its slug. No other script changed.

`agents/poteto-agent.md` searched `~/.cursor/plugins/` for the `poteto-mode` skill. It now reads `.claude/skills/poteto-mode/SKILL.md`.

### 5. Skills and commands from outside pstack

| Upstream | Here |
| --- | --- |
| Cursor's built-in `create-skill` | Anthropic's `skill-creator` plugin (`/plugin install skill-creator@claude-plugins-official`), with https://code.claude.com/docs/en/skills as the fallback. The routing label `new skill via create-skill:` in `reflect` is `new skill via skill-creator:`. |
| Cursor's `/loop` | Claude Code's `/loop`, a bundled skill |
| `deslop` from Cursor's `cursor-team-kit` plugin | Not ported. The skills say to run `/deslop` when the session has it, and otherwise to do the pass by hand. |
| `control-ui`, `control-cli` from `cursor-team-kit` | Not ported. The skills name a project `verify-*` skill, or Claude Code's bundled `/run` skill. |
| Cursor's built-in babysit skill | "any other babysit skill or command the session offers" |
| Cursor's Plan Mode | Claude Code's plan mode |

### 6. Notes added to skills

27 skills end with a `## Claude Code notes` section. Nothing above that heading is new prose except the edits listed here. The notes are short and are one or more of these:

- **Routing.** pstack skills call each other by name ("the **arena** skill", `/why`). The Skill tool refuses a user-invoked skill, so the note says to read `.claude/skills/<name>/SKILL.md` and follow it. `poteto-mode` says the same in its first paragraph.
- **Todolist.** Claude Code's task tools (`TaskCreate`, `TodoWrite`) are absent on some models, so the note says to keep the list in the reply then.
- **Model values.** How `<model> <effort>` maps to the Agent call.
- **`AskUserQuestion`** is absent in a non-interactive run.
- **`skill-creator`** install line and fallback.
- `statechart`: the skill folder, how to supply TLC without mise, and where the tests are.
- `ketchup`, `ketchup-video`: the terminal cannot embed a picture or a video, so give the file path.
- `poteto-mode`: Bugbot, worktrees for cloud agents, and the one-line skip for a Cursor-only step.

`make-bot-ui` has its note at the top, because the whole skill depends on Cursor Automations.

### 7. `setup-pstack`

Kept and rewritten for Claude Code. It is not an installer. Upstream, it configures a model for each role and writes a rule file, and that job exists in Claude Code too. Changes:

- A new first section says that pstack is already in the repo as project skills, and how to check it.
- It writes `~/.claude/rules/pstack-models.md` with no frontmatter, in place of `~/.cursor/rules/pstack-models.mdc` with `alwaysApply: true`. The file is a user rule, because the models a person can use are personal.
- It detects models from the Agent tool's schema.
- The defaults are the mapped values in section 3.
- Upstream's migration of old `grok-*` slugs is replaced by a rule that maps any Cursor slug found in the file.
- Steps 7 and 8 say to read the sibling skill's `SKILL.md`, because the Skill tool refuses it.

### 8. `poteto-help`

- "Get set up" says there is nothing to install.
- The Custom Mode lines are replaced. Claude Code has no Custom Modes, so the skill says to start each task with `/poteto-mode` and to type it again after a compaction.
- Links to `README.md` and `docs/guide/` go to upstream at the pinned commit, because this repo does not carry those files.
- The paragraph on Claude Code describes this port, and says not to install upstream's Claude Code plugin beside it.

## What was left out, and why

| Left out | Why |
| --- | --- |
| `automations/benny/` | It is built on Cursor Automations. |
| `plugin.json`, `.cursor-plugin/`, `assets/logo.png` | Cursor plugin manifests and logo. Project skills need no manifest. |
| `docs/`, all of it: `docs/guide/` with its images, and `docs/harness/claude-code.md` | The guide is written for Cursor and is 81 KB of prose plus 2.3 MB of images. `poteto-help` links to it upstream. The adapter is folded into the skills. |
| `README.md`, `.gitignore` | The README describes the Cursor plugin. `poteto-help` links to it upstream. |
| `skills/statechart/scripts/test/` | 377 files, 3.8 MB, about 16,000 lines of test corpus. The tests are at https://github.com/cursor/plugins/tree/bf0c7cd80abdbf7fe47b634978a7d1b4071f71a7/pstack/skills/statechart/scripts/test. `scripts/package.json` still has its `test` script, which has nothing to run here. |

The `statechart` scripts and launcher are byte-identical to upstream, and the launcher keeps its executable bit. So do `poteto-mode/scripts/check-plan.mjs`, `poteto-mode/scripts/watch-pr/watch-pr`, `poteto-mode/scripts/worktree-audit.sh`, and `show-me-your-work/scripts/log.sh`.

## What has no Claude Code equivalent

Each skill says these plainly where they come up.

- **Models from another vendor.** Claude Code runs only Claude models. A panel's third seat (Gemini upstream) runs on the parent model. Arena's cross-judge must come from another vendor than the parent, so with a Claude parent Arena skips the judge and says so.
- **Fast variants.** The Agent call cannot pick a speed, so that choice is gone.
- **Cursor cloud agents.** A worktree isolates files, not the machine. Workers share this computer's CPU, ports, and credentials.
- **Cursor Automations.** `make-bot-ui` cannot run as written. Its note points at Claude Code's cloud scheduled tasks with an API trigger as the nearest feature, and that feature has another endpoint, token, and wake.
- **Custom Modes.** Nothing keeps `/poteto-mode` on every turn.
- **The agent store, the Project tracker, and the Project store.** The playbooks now name a folder that the root agent picks.
- **Forking another agent's state** (`orchestrate`). The playbook says to hand over the worktree or resume the worker.
- **`/visualize`** (`ketchup`) and inline pictures and video in the reply.
- **A built-in PR tool.** The playbook already falls back to the forge CLI.
- **Bugbot** is a GitHub review bot, not a host feature. Its triage steps are unchanged and apply when a PR has Bugbot comments.

Two things to know when using the port:

- The subagent descriptions are upstream's. Claude Code uses a description to decide when to delegate, so Claude can pick `comment-sicko`, which deletes comments, without being asked. `.claude/settings.json` can deny `Agent(comment-sicko)` if that is not wanted.
- `poteto-agent` has `background: true`, so it always runs in the background.

## Checks run on the port

- `claude plugin validate .claude` passes (Claude Code 2.1.325).
- Every `SKILL.md` and subagent file has frontmatter that parses, with `name` equal to its folder or file name.
- Every relative Markdown link resolves, including links between skills such as `../statechart/SKILL.md`.
- No skill name is the name of a Claude Code command.
- `statechart` ran on a three-state TLA+ spec with one INVARIANT, with a local `tla2tools.jar`, OpenJDK 21, and Node 22.23, and wrote `chart.mmd`, `report.md`, and `tlc.out`. A second run with an invariant that breaks exited 1 and reported the shortest path. The command:

  ```sh
  TLA2TOOLS=/path/to/tla2tools.jar JAVA=java .claude/skills/statechart/scripts/statechart SPEC.tla --out DIR
  ```

## How to re-sync from upstream

1. Clone https://github.com/cursor/plugins twice: once at the commit in the table above (`OLD`), once at the commit you want (`NEW`).
2. List what upstream changed: `git -C NEW diff <old-commit> HEAD --stat -- pstack/skills pstack/agents pstack/LICENSE`.
3. For each changed file that this port did not edit, copy the new file over. `diff -rq OLD/pstack/skills .claude/skills` lists the files this port edited. Leave out `skills/statechart/scripts/test/`.
4. For each changed file that this port did edit, merge upstream's change into the ported file: `git merge-file .claude/skills/<path> OLD/pstack/skills/<path> NEW/pstack/skills/<path>`. Resolve conflicts in favor of upstream's substance and this file's host names.
5. For a new skill, copy its folder, then apply sections 1 to 6 to it.
6. Search the result for Cursor names that came in. No hit should remain outside a sentence that explains a difference:

   ```sh
   grep -rnE '`Task`|\bTask (tool|subagent|call)|AskQuestion|generalPurpose|readonly|environment: "(cloud|local)"|cloud_base_branch|run_in_background|file_attachments|\bclaude-[a-z]+-[0-9]|\bgrok-[0-9]|\bgpt-[0-9]|gemini|pstack-models\.mdc|\.cursor/|\.cursor-plugin|agent-transcripts|create-skill|cursor-team-kit|Custom Mode|is_background|cloud agent|cloud VM' .claude/skills .claude/agents
   ```

   Upstream's `scripts/generate-pstack-harness-trees.mjs` holds the author's own list of Cursor names, and `pstack/docs/harness/claude-code.md` holds the mapping for any new one.
7. Run the checks in the section above again, and run `chmod +x` on the five executable scripts if a copy dropped the bit.
8. Update the commit, date, and version in this file.

## Upstream's own Claude Code plugin

Upstream publishes a generated Claude Code plugin at `harness/pstack/claude-code/` in the same repository (`/plugin marketplace add cursor/plugins`, then `/plugin install pstack@cursor-plugins`). It differs from this port in three ways:

- It is a plugin, so each command has a prefix, such as `/pstack:poteto-mode`, and it installs for a user. This port is project skills with no prefix, and it travels with the repo.
- Its skills keep the Cursor names. One line under each title tells Claude to read the adapter file and map the names as it goes. This port maps the names in the text.
- It ships `docs/guide/`.

Do not install that plugin beside this port. Every skill would then exist twice, once as `/name` and once as `/pstack:name`.

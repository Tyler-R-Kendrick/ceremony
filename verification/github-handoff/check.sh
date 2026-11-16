#!/bin/sh
# Run every configuration of the GitHub hand-off model and compare each
# result with the result recorded in README.md.
#   verification/github-handoff/check.sh        from the repo root
# Exit 0: every configuration gave its recorded result.
# Exit 1: a result changed; TLC's output for it is printed.
set -u
here=$(cd "$(dirname "$0")" && pwd)
tlc="$here/../tlc.sh"
changed=0
findings=0

# check <Config> <pass | name of the invariant that must be violated> <what it means>
check() {
  out=$("$tlc" github-handoff GitHubHandoff "$1" 2>&1)
  if printf '%s\n' "$out" | grep -q "Model checking completed. No error has been found."; then
    got=pass
  else
    got=$(printf '%s\n' "$out" | sed -n 's/^Error: Invariant \(.*\) is violated\.$/\1/p' | head -n 1)
    [ -n "$got" ] || got="TLC error"
  fi
  if [ "$got" = "$2" ]; then
    printf '%-9s %-24s %s\n' "$4" "$1" "$3"
    [ "$4" = FINDING ] && findings=$((findings + 1))
  else
    changed=$((changed + 1))
    printf '%-9s %-24s recorded: %s, now: %s\n' CHANGED "$1" "$2" "$got"
    printf '%s\n' "$out" | grep -v '^Picked up JAVA_TOOL_OPTIONS' | sed 's/^/    /'
  fi
}

check GitHubHandoff pass "the rules that hold today hold" ok
check NoDeadEndOneAtATime pass "NoDeadEnd holds without the findings' triggers" ok
check DeadEndGitHubSilent AppReadyNeverStranded "finding 1 is still in the code" FINDING
check DeadEndReplayedReturn AppReadyNeverStranded "finding 1 is still in the code" FINDING
check DeadEndExpiry ExpiredHandoffNeverStranded "finding 2 is still in the code" FINDING
check DeadEndLaterStep LaterStepsNeverStranded "finding 3 is still in the code" FINDING
check DeadEndWrongAccount WrongAccountNeverStranded "finding 4 is still in the code" FINDING
check BrokenAdmit ConvertedAtMostOnce "the removed check is caught" ok
check BrokenFence CancelledStaysCancelled "the removed check is caught" ok
check BrokenSave CancelledStaysCancelled "the removed check is caught" ok
check BrokenInstallCheck InstallationCheckedBeforeToken "the removed check is caught" ok

if [ "$changed" -gt 0 ]; then
  echo "$changed result(s) changed. See .claude/skills/verify-github-handoff/SKILL.md."
  exit 1
fi
echo "All results are as recorded. NoDeadEnd still does not hold: $findings finding configurations fail as recorded (README.md, Findings)."

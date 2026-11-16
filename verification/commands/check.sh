#!/bin/sh
# Run every check of the protected-command model and compare each result with
# what is expected today. Exit 0 only when every row matches.
#   verification/commands/check.sh
# README.md in this folder says what each config is and what a mismatch means.
set -u
here=$(cd "$(dirname "$0")" && pwd)
area=$(basename "$here")
tlc="$here/../tlc.sh"

# config : expected result : what the row is
# A result is "pass", the name of the rule TLC found broken, or "Deadlock".
rows='
Holds:pass:code as written, rules that hold
Sketch:pass:code plus the three sketched guards, every rule
FindingBlindRepeat:NeverBlindRepeat:finding 1, code as written
FindingOverwritten:CompleteStaysVerified:finding 2, code as written
FindingDeadEnd:Deadlock:finding 3, code as written
FindingUnblocked:UncertainStaysBlocked:finding 4, code as written
FindingReopenedRepeat:NeverBlindRepeat:finding 4 with finding 1 guarded
BrokenTakeoverReruns:OneCallPerCommand:broken variant, must be caught
BrokenHandlerBeforeIntent:EveryCallHasIntent:broken variant, must be caught
BrokenNoAssertFence:SupersededWorkerNeverCommits:broken variant, must be caught
'

out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

echo "$rows" | while IFS=: read -r config expected what; do
  [ -n "$config" ] || continue
  "$tlc" "$area" Commands "$config" >"$out/$config.out" 2>&1 &
done
wait

status=0
printf '%-26s %-29s %-29s %s\n' CONFIG EXPECTED GOT ''
for line in $(echo "$rows" | tr ' ' '_'); do
  config=${line%%:*}
  rest=${line#*:}
  expected=${rest%%:*}
  what=$(echo "${rest#*:}" | tr '_' ' ')
  file="$out/$config.out"
  if grep -q 'Model checking completed. No error has been found.' "$file"; then
    got=pass
  elif grep -q '^Error: Deadlock reached' "$file"; then
    got=Deadlock
  elif grep -q '^Error: Invariant .* is violated' "$file"; then
    got=$(sed -n 's/^Error: Invariant \(.*\) is violated.*/\1/p' "$file" | head -n 1)
  else
    got=TOOL-ERROR
  fi
  if [ "$got" = "$expected" ]; then
    mark="ok        $what"
  else
    mark="MISMATCH  $what"
    status=1
  fi
  printf '%-26s %-29s %-29s %s\n' "$config" "$expected" "$got" "$mark"
  if [ "$got" = TOOL-ERROR ]; then
    sed 's/^/    | /' "$file" | grep -v 'Picked up JAVA_TOOL_OPTIONS' | tail -n 15
  fi
done

if [ "$status" -eq 0 ]; then
  echo "All rows match. The four findings are still present in the code as modelled."
else
  echo "At least one row does not match. For the steps of a row, run:"
  echo "  verification/tlc.sh $area Commands <CONFIG>"
fi
exit "$status"

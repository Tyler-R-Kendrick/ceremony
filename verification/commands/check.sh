#!/bin/sh
# Run every check of the protected-command model and compare each result with
# what is expected today, and run conformance.test.ts on the real code.
# Exit 0 only when every row matches.
#   verification/commands/check.sh
# README.md in this folder says what each row is and what a mismatch means.
set -u
here=$(cd "$(dirname "$0")" && pwd)
area=$(basename "$here")
tlc="$here/../tlc.sh"

# config : expected result : what the row is
# A result is "pass", the name of the rule TLC found broken, or "Deadlock".
rows='
Holds:pass:code as written, rules that hold
Sketch:pass:code plus the three sketched guards, every rule
FindingBlindRepeat:pass:finding 1, fixed
FindingOverwritten:pass:finding 2, fixed
FindingDeadEnd:Deadlock:finding 3, code as written
FindingUnblocked:UncertainStaysBlocked:finding 4, code as written
FindingReopenedRepeat:NeverBlindRepeat:finding 4 with finding 1 guarded
BrokenTakeoverReruns:OneCallPerCommand:broken variant, must be caught
BrokenHandlerBeforeIntent:EveryCallHasIntent:broken variant, must be caught
BrokenNoAssertFence:SupersededWorkerNeverCommits:broken variant, must be caught
Commands:Deadlock:code as written, every rule at once, first break found
Lifecycle:Deadlock:the chart config, first break found
'

out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

lines=$(echo "$rows" | tr ' ' '_')

# The runs are independent, so they go in parallel. Each JVM gets its own
# temp folder: TLC unpacks its standard modules there, and two runs that
# share one can delete each other's copy.
for line in $lines; do
  config=${line%%:*}
  mkdir "$out/$config.tmp"
  JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:-} -Djava.io.tmpdir=$out/$config.tmp" \
    "$tlc" "$area" Commands "$config" >"$out/$config.out" 2>&1 &
done
(
  cd "$here/../.." &&
    node --no-experimental-webstorage --import tsx --test \
      "verification/$area/conformance.test.ts" >"$out/conformance.out" 2>&1
  echo "$?" >"$out/conformance.status"
) &
wait

status=0
printf '%-26s %-29s %-29s %s\n' CONFIG EXPECTED GOT ''
for line in $lines; do
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

if [ "$(cat "$out/conformance.status" 2>/dev/null)" = 0 ]; then
  got=pass
  mark="ok        the model's facts and findings on the real code"
else
  got=FAIL
  mark="MISMATCH  the model's facts and findings on the real code"
  status=1
fi
printf '%-26s %-29s %-29s %s\n' conformance.test.ts pass "$got" "$mark"
if [ "$got" = FAIL ]; then
  grep -E '^not ok|^# fail|message:|expected:|actual:' "$out/conformance.out" |
    sed 's/^/    | /' | head -n 30
fi

if [ "$status" -eq 0 ]; then
  echo "All rows match. Findings 1 and 2 are fixed; findings 3 and 4 are still present in the code."
else
  echo "At least one row does not match. For the steps of a model row, run:"
  echo "  verification/tlc.sh $area Commands <CONFIG>"
fi
exit "$status"

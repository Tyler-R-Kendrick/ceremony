#!/bin/sh
# Check the ceremony step machine: the model, then the real controller.
#   verification/ceremony-steps/check.sh
#
# 1. TLC on CeremonySteps.cfg, the code as written, with every rule
#    including TryAgainStartsClean. It must hold.
# 2. TLC on each Finding*.cfg (an open finding fails today; a fixed one
#    holds) and each Broken*.cfg (a check removed on purpose: it must fail).
# 3. TLC on DurableSteps.tla, the database path: Durable*.cfg must hold and
#    each BrokenDurable*.cfg must fail.
# 4. conformance.test.ts on the real CeremonyController, and
#    durable-conformance.test.ts on the durable controller over SQLite.
#
# Exit 0 when every result is the one listed below. Any other result prints
# the TLC output for it and exits 1.
set -u
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

# config, the result expected today, and what that result is
expected="
CeremonySteps               holds                            the code as written
FindingRequestHuman         holds                            finding F1, fixed
BrokenNoRevisionCheck       breaks:YouActOnTheScreenYouSee   broken on purpose
BrokenNoRevisionBump        breaks:YouActOnTheScreenYouSee   broken on purpose
BrokenRetryRestartsRevision breaks:YouActOnTheScreenYouSee   broken on purpose
BrokenNoOfferedCheck        breaks:ConnectedMeansConfirmed   broken on purpose
BrokenNoBusyCheck           breaks:EndScreensStayPut         broken on purpose
BrokenNoExpiredGuard        breaks:EndScreensStayPut         broken on purpose
BrokenNoExpiredGuardOnError breaks:EndScreensStayPut         broken on purpose
BrokenNoHumanExpiredGuard   breaks:EndScreensStayPut         broken on purpose
BrokenNoEndExemption        breaks:EndScreensStayPut         broken on purpose
BrokenNoCallbackGuard       breaks:EndScreensStayPut         broken on purpose
BrokenNoRetryAfterCancel    breaks:EveryScreenOffersAWayOn   broken on purpose
Durable                     holds                            the durable controller as written
DurableReload               holds                            the durable controller as written, a reload never moves a final step
DurableLeaseHeld            holds                            the durable controller while every lease lasts
BrokenDurableNoLease        breaks:OneWorkerAppliesAnswers   broken on purpose
BrokenDurableCachedCopy     breaks:OneWorkerAppliesAnswers   broken on purpose
"

# Durable*.cfg and BrokenDurable*.cfg are configs of DurableSteps.tla.
spec() {
  case $1 in
    Durable* | BrokenDurable*) echo DurableSteps ;;
    *) echo CeremonySteps ;;
  esac
}

# TLC unpacks its standard modules into Java's temp folder and deletes them on
# exit, so runs that share that folder break each other. Each run gets its own.
# The other flags keep thirteen small JVMs cheap; the model has a few thousand states.
run() {
  mkdir -p "$out/tmp-$1"
  JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:-} -Djava.io.tmpdir=$out/tmp-$1 -Xmx512m -XX:TieredStopAtLevel=1 -XX:ParallelGCThreads=1" \
    "$here/../tlc.sh" ceremony-steps "$(spec "$1")" "$1" >"$out/$1.log" 2>&1
}

result() {
  if grep -q "No error has been found" "$out/$1.log"; then
    echo holds
  elif grep -q "Invariant .* is violated" "$out/$1.log"; then
    sed -n 's/^Error: Invariant \(.*\) is violated.*/breaks:\1/p' "$out/$1.log" | head -1
  elif grep -q "Deadlock reached" "$out/$1.log"; then
    echo deadlock
  else
    echo tool-error
  fi
}

# The first run also fetches the pinned TLC, so it runs alone.
run CeremonySteps
for config in $(echo "$expected" | awk 'NF && $1 != "CeremonySteps" { print $1 }'); do
  run "$config" &
done
wait

status=0
findings=0
echo "$expected" | awk 'NF' >"$out/expected"
while read -r config want what; do
  got=$(result "$config")
  if [ "$got" = "$want" ]; then
    case $what in
      open*) findings=$((findings + 1)); mark="FINDING " ;;
      *) mark="ok      " ;;
    esac
    printf '%s %-28s %-32s %s\n' "$mark" "$config" "$got" "$what"
  else
    status=1
    printf '%s %-28s %-32s %s\n' "MISMATCH" "$config" "$got" "expected $want ($what)"
    grep -v "^Picked up JAVA_TOOL_OPTIONS" "$out/$config.log" | sed 's/^/    /'
  fi
done <"$out/expected"

if (cd "$root" && node --import tsx --test verification/ceremony-steps/conformance.test.ts) >"$out/conformance.log" 2>&1; then
  printf '%s %-28s %s\n' "ok      " "conformance.test.ts" "the real controller has the checks the model assumes; F1 and F2 are fixed"
else
  status=1
  printf '%s %-28s %s\n' "MISMATCH" "conformance.test.ts" "the real controller no longer matches the model"
  grep -E "^not ok|error:|expected|actual" "$out/conformance.log" | sed 's/^/    /'
fi

if (cd "$root" && node --import tsx --test verification/ceremony-steps/durable-conformance.test.ts) >"$out/durable.log" 2>&1; then
  printf '%s %-28s %s\n' "ok      " "durable-conformance.test.ts" "the durable controller has the lease and reload the model assumes; one worker applies answers"
else
  status=1
  printf '%s %-28s %s\n' "MISMATCH" "durable-conformance.test.ts" "the durable controller does not keep the rules of the database path"
  grep -E "^not ok|error:|expected|actual" "$out/durable.log" | sed 's/^/    /'
fi

if [ "$status" = 0 ]; then
  echo "As expected: the rules hold for the code as written. Open findings: $findings (see README.md)."
else
  echo "Not as expected. Read .claude/skills/verify-ceremony-steps/SKILL.md before changing anything."
fi
exit "$status"

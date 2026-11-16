#!/bin/sh
# Check the lease and revision model of src/server/persistence against what
# README.md in this folder records.  Run from anywhere:
#   verification/persistence/check.sh
# It runs every config in this folder with the pinned TLC (../tlc.sh), all at
# once, and compares each result with the expected one below.
# Exit 0: every config did what is recorded.  Exit 1: something changed.
set -u
here=$(cd "$(dirname "$0")" && pwd)
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

# config | expected | what it is
#   expected is "holds", or the name of the rule that must break
table='
Fence|holds|rules 1-3 on the code as written
RevisionNoDelete|holds|rule 4 for a key that is never deleted
Chart|holds|the small model behind chart.mmd
FindingRevisionReused|StaleRevisionNeverWrites|OPEN FINDING F1: rule 4 on the code as written
BrokenNoGenerationCheck|StaleFenceNeverCommits|broken variant, index.ts:188
BrokenNoRowLock|StaleFenceNeverCommits|broken variant, index.ts:166
BrokenNoGenerationBump|StaleFenceNeverCommits|broken variant, index.ts:282
BrokenClaimLiveLease|LiveLeaseNeverTakenOver|broken variant, index.ts:282
BrokenNoExpiryCheck|ExpiredFenceNeverPasses|broken variant, index.ts:190
BrokenNoRevisionCheck|StaleRevisionNeverWrites|broken variant, index.ts:238
'

configs=$(printf '%s\n' "$table" | cut -d'|' -f1)
for config in $configs; do
  # TLC unpacks its standard modules into the Java temp folder and removes
  # them when it ends, so runs that share that folder break each other.
  mkdir "$out/$config.tmp"
  JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:-} -Djava.io.tmpdir=$out/$config.tmp" \
    "$here/../tlc.sh" persistence Fence "$config" >"$out/$config.out" 2>&1 &
done
wait

status=0
old_ifs=$IFS
IFS='
'
for row in $table; do
  IFS='|' read -r config expected what <<ROW
$row
ROW
  IFS='
'
  log="$out/$config.out"
  if grep -q '^Model checking completed. No error has been found.' "$log"; then
    got=holds
  else
    got=$(sed -n 's/^Error: Invariant \(.*\) is violated\.$/\1/p' "$log" | head -n 1)
    [ -n "$got" ] || got=error
  fi
  if [ "$got" = "$expected" ]; then
    case $expected in
      holds) printf 'ok    %-24s holds: %s\n' "$config" "$what" ;;
      *) printf 'ok    %-24s breaks %s, as recorded: %s\n' "$config" "$expected" "$what" ;;
    esac
  else
    status=1
    printf 'FAIL  %-24s expected %s, got %s: %s\n' "$config" "$expected" "$got" "$what"
    printf '      see it with: verification/tlc.sh persistence Fence %s\n' "$config"
    if [ "$got" = error ]; then
      grep -v '^Picked up' "$log" | tail -n 15 | sed 's/^/      | /'
    fi
  fi
done
IFS=$old_ifs

if [ "$status" -eq 0 ]; then
  echo 'All configs did what README.md records. Finding F1 is still open.'
else
  echo 'Something changed. Read .claude/skills/verify-persistence/SKILL.md before you go on.'
fi
exit "$status"

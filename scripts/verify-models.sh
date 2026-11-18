#!/bin/sh
# Run every TLA+ verification in verification/: each area's check.sh, which
# compares every config's result with its expected row, and the kernel flow
# model, which must pass. Exit 0 only when all of them do.
#   npm run verify:models
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
failed=""
run() {
  echo "== $*"
  if ! "$@"; then
    failed="$failed
  $*"
  fi
}
run sh verification/ceremony-steps/check.sh
run sh verification/commands/check.sh
run sh verification/github-handoff/check.sh
run sh verification/persistence/check.sh
run sh verification/tlc.sh connect-github ConnectGitHub
if [ -n "$failed" ]; then
  echo "failed:$failed"
  exit 1
fi
echo "every model verification passed"

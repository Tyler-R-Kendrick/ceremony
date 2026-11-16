#!/bin/sh
# Run the TLC model checker on a spec in this folder with a pinned tool version.
#   verification/tlc.sh <area> <Spec> [Config]
# e.g. verification/tlc.sh persistence Fence
# TLA2TOOLS overrides the jar; JAVA overrides the java binary (Java 11 or later).
set -eu
area=$1
spec=$2
config=${3:-$spec}
here=$(cd "$(dirname "$0")" && pwd)
version=1.7.4
sum=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
jar=${TLA2TOOLS:-}
if [ -z "$jar" ]; then
  cache=${XDG_CACHE_HOME:-$HOME/.cache}/ceremony-tla
  jar=$cache/tla2tools-$version.jar
  if [ ! -f "$jar" ]; then
    mkdir -p "$cache"
    curl -fsSL -o "$jar.part" \
      "https://github.com/tlaplus/tlaplus/releases/download/v$version/tla2tools.jar"
    echo "$sum  $jar.part" | sha256sum -c - >/dev/null
    mv "$jar.part" "$jar"
  fi
fi
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$here/$area"
exec "${JAVA:-java}" -XX:+UseParallelGC -cp "$jar" tlc2.TLC \
  -metadir "$work" -workers 1 -config "$config.cfg" "$spec.tla"

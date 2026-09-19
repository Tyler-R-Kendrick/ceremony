/**
 * Peak resident memory of a process tree, sampled.
 *
 * `/usr/bin/time -v` reports the largest single process, which is the wrong
 * number when the question is whether four concurrent test files plus their
 * browsers fit in a runner. This sums every process's RSS on an interval and
 * reports the worst moment.
 */
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const args = process.argv.slice(2);
const label = args.shift();

function totalRssKb() {
  let total = 0;
  let procs = 0;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = readFileSync(`/proc/${entry}/status`, "utf8");
      const match = /^VmRSS:\s+(\d+) kB$/m.exec(status);
      if (match) {
        total += Number(match[1]);
        procs++;
      }
    } catch {
      /* the process exited between readdir and read */
    }
  }
  return { total, procs };
}

const baseline = totalRssKb().total;
let peak = 0;
let peakProcs = 0;
const child = spawn(args[0], args.slice(1), {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, NODE_OPTIONS: "" },
});
let out = "";
child.stdout.on("data", (chunk) => (out += chunk));
child.stderr.on("data", (chunk) => (out += chunk));
const timer = setInterval(() => {
  const { total, procs } = totalRssKb();
  if (total > peak) {
    peak = total;
    peakProcs = procs;
  }
}, 200);

child.on("exit", (code) => {
  clearInterval(timer);
  const pass = (out.match(/^# pass (\d+)$/m) ?? [])[1] ?? "?";
  const fail = (out.match(/^# fail (\d+)$/m) ?? [])[1] ?? "?";
  const names = [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]);
  console.log(
    JSON.stringify({
      label,
      exit: code,
      pass,
      fail,
      failed: names.slice(0, 12),
      baselineMb: Math.round(baseline / 1024),
      peakMb: Math.round(peak / 1024),
      overBaselineMb: Math.round((peak - baseline) / 1024),
      peakProcs,
    }),
  );
});

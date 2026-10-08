#!/usr/bin/env bash
# Measures the cost of proving the R_cap program with Stwo at a grid of batch sizes, and writes
# the measurement that becomes family 7's cost-model fixture (docs/tasks.md §8.5).
#
#   REPS=3 bash cairo/rcap/measure.sh [sizes...]        (default: every args file present, REPS=1)
#
# Linux only (`scarb prove` is not available on Windows); on this machine it runs in the
# Ubuntu-24.04 WSL distro with /root/.toolenv sourced. Set SCARB_TARGET_DIR to an ext4 path.
# Each size: `scarb execute` for the step count, then REPS times `scarb prove --execute` timed with
# /usr/bin/time for wall seconds and peak resident memory, each followed by `scarb verify`.
# Executing and proving in one step matters: a separate execute followed by prove makes proofs that
# fail to verify. The recorded seconds are the minimum over the repetitions, the statistic least
# disturbed by other work on the machine; the recorded memory is the maximum; every run's seconds
# are kept beside them. Results go to cairo/rcap/measurements/<date>.json; nothing is hash-bound
# here, the bench does that when a measurement is adopted (config/proof_budget.json).
set -euo pipefail
root="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$root"
target="${SCARB_TARGET_DIR:-$root/target}"
reps="${REPS:-1}"
mkdir -p "$root/measurements"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$root/measurements/$stamp.json"

if [ "$#" -gt 0 ]; then
  files=(); for s in "$@"; do files+=("$root/args/batch-$(printf '%04d' "$s").json"); done
else
  files=("$root"/args/batch-*.json)
fi

program_sha="$(sha256sum "$root/src/lib.cairo" | cut -c1-64)"
scarb_version="$(scarb --version | head -n 1)"
machine="$(uname -srm); $(nproc) cpus; $(free -g | awk '/Mem:/ {print $2}') GB RAM; swap $(free -g | awk '/Swap:/ {print $2}') GB"
load="$(cut -d' ' -f1-3 /proc/loadavg)"
scarb build >/dev/null

statistic="one run per size"
if [ "$reps" -gt 1 ]; then statistic="minimum wall seconds and maximum peak memory over $reps runs per size"; fi
echo "{" > "$out"
echo "  \"program\": \"cairo/rcap/src/lib.cairo\", \"program_sha256\": \"$program_sha\"," >> "$out"
echo "  \"toolchain\": \"$scarb_version\", \"machine\": \"$machine\", \"load_average_at_start\": \"$load\", \"started\": \"$stamp\"," >> "$out"
echo "  \"statistic\": \"$statistic\"," >> "$out"
echo "  \"runs\": [" >> "$out"
first=1
for f in "${files[@]}"; do
  size="$(basename "$f" .json | sed 's/batch-0*//')"
  echo "== batch $size =="
  rm -rf "$target/execute"
  steps="$(scarb execute --print-resource-usage --arguments-file "$f" 2>&1 | grep -i -E 'n_steps|steps' | head -n 1 | grep -o -E '[0-9][0-9,]*' | head -n 1 | tr -d ',')"
  best=""; all=""; rss_max=0; verified="true"; status_all=0; proof_bytes=0
  for r in $(seq 1 "$reps"); do
    rm -rf "$target/execute"
    status=0
    /usr/bin/time -v -o "$root/measurements/time-$size-$r.txt" scarb prove --execute --arguments-file "$f" >"$root/measurements/prove-$size-$r.log" 2>&1 || status=$?
    wall="$(grep 'Elapsed (wall clock)' "$root/measurements/time-$size-$r.txt" | awk '{print $NF}')"
    rss_kb="$(grep 'Maximum resident set size' "$root/measurements/time-$size-$r.txt" | awk '{print $NF}')"
    # wall is h:mm:ss or m:ss
    secs="$(echo "$wall" | awk -F: '{ if (NF == 3) print $1*3600 + $2*60 + $3; else print $1*60 + $2 }')"
    if [ "$status" = "0" ] && scarb verify --execution-id 1 >>"$root/measurements/prove-$size-$r.log" 2>&1; then :; else verified="false"; fi
    if [ "$status" != "0" ]; then status_all=$status; fi
    proof="$(ls "$target"/execute/*/execution1/proof/proof.json 2>/dev/null | head -n 1 || true)"
    if [ -n "$proof" ]; then proof_bytes="$(stat -c %s "$proof")"; fi
    rss_mib=$(( ${rss_kb:-0} / 1024 ))
    if [ "$rss_mib" -gt "$rss_max" ]; then rss_max=$rss_mib; fi
    all="${all:+$all, }$secs"
    if [ -z "$best" ] || awk "BEGIN { exit !($secs < $best) }"; then best="$secs"; fi
    echo "   run $r: steps=${steps:-?} prove=${secs}s rss=${rss_mib}MiB status=$status"
  done
  if [ "$first" != "1" ]; then sed -i '$ s/ }$/ },/' "$out"; fi
  first=0
  echo "    { \"batch\": $size, \"steps\": ${steps:-null}, \"prove_seconds\": ${best:-null}, \"prove_seconds_all\": [$all], \"peak_rss_mib\": $rss_max, \"proof_bytes\": $proof_bytes, \"verified\": $verified, \"exit\": $status_all }" >> "$out"
done
echo "  ]" >> "$out"
echo "}" >> "$out"
echo "wrote $out"

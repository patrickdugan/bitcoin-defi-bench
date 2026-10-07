#!/usr/bin/env bash
# Measures the cost of proving the R_cap program with Stwo at a grid of batch sizes, and writes
# the measurement that becomes family 7's cost-model fixture (docs/tasks.md §8.5).
#
#   bash cairo/rcap/measure.sh [sizes...]        (default: every args file present)
#
# Linux only (`scarb prove` is not available on Windows); on this machine it runs in the
# Ubuntu-24.04 WSL distro with /root/.toolenv sourced. Set SCARB_TARGET_DIR to an ext4 path.
# Each size: `scarb execute` for the step count, then `scarb prove --execute` timed with
# /usr/bin/time for wall seconds and peak resident memory, then `scarb verify`. Executing and
# proving in one step matters: a separate execute followed by prove makes proofs that fail to
# verify. Results go to cairo/rcap/measurements/<date>.json; nothing is hash-bound here, the
# bench does that when a measurement is adopted.
set -euo pipefail
root="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$root"
target="${SCARB_TARGET_DIR:-$root/target}"
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
scarb build >/dev/null

echo "{" > "$out"
echo "  \"program\": \"cairo/rcap/src/lib.cairo\", \"program_sha256\": \"$program_sha\"," >> "$out"
echo "  \"toolchain\": \"$scarb_version\", \"machine\": \"$machine\", \"started\": \"$stamp\"," >> "$out"
echo "  \"runs\": [" >> "$out"
first=1
for f in "${files[@]}"; do
  size="$(basename "$f" .json | sed 's/batch-0*//')"
  echo "== batch $size =="
  rm -rf "$target/execute"
  # Steps from a plain execution; the proof run below repeats the execution, which is cheap.
  steps="$(scarb execute --print-resource-usage --arguments-file "$f" 2>&1 | grep -i -E 'n_steps|steps' | head -n 1 | grep -o -E '[0-9][0-9,]*' | head -n 1 | tr -d ',')"
  rm -rf "$target/execute"
  /usr/bin/time -v -o "$root/measurements/time-$size.txt" scarb prove --execute --arguments-file "$f" >"$root/measurements/prove-$size.log" 2>&1 || status=$?
  status="${status:-0}"
  wall="$(grep 'Elapsed (wall clock)' "$root/measurements/time-$size.txt" | awk '{print $NF}')"
  rss_kb="$(grep 'Maximum resident set size' "$root/measurements/time-$size.txt" | awk '{print $NF}')"
  verified="false"
  if [ "$status" = "0" ] && scarb verify --execution-id 1 >>"$root/measurements/prove-$size.log" 2>&1; then verified="true"; fi
  proof="$(ls "$target"/execute/*/execution1/proof/proof.json 2>/dev/null | head -n 1 || true)"
  proof_bytes="0"; [ -n "$proof" ] && proof_bytes="$(stat -c %s "$proof")"
  # wall is h:mm:ss or m:ss
  secs="$(echo "$wall" | awk -F: '{ if (NF == 3) print $1*3600 + $2*60 + $3; else print $1*60 + $2 }')"
  [ "$first" = "1" ] || echo "    ," >> "$out"
  first=0
  echo "    { \"batch\": $size, \"steps\": ${steps:-null}, \"prove_seconds\": ${secs:-null}, \"peak_rss_mib\": $(( ${rss_kb:-0} / 1024 )), \"proof_bytes\": $proof_bytes, \"verified\": $verified, \"exit\": $status }" >> "$out"
  echo "   steps=${steps:-?} prove=${secs:-?}s rss=$(( ${rss_kb:-0} / 1024 ))MiB verified=$verified"
  unset status
done
echo "  ]" >> "$out"
echo "}" >> "$out"
echo "wrote $out"

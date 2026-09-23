#!/usr/bin/env bash
# Times a cron job, captures its RAW exit code, and appends one heartbeat line.
#
#   run-job.sh <job_id> -- <command> [args...]
#
# Nothing about the wrapped job changes: it keeps its own stdout, its own exit
# code (this script exits with it), its own logging. The only new thing is the
# heartbeat line.
#
# The raw code is what gets recorded, never a flattened "failed". The bronze
# mirror means 1=source A failed, 2=source B failed, 3=both, and the binding's
# exit_code_map is what turns that into a sentence on the panel.
#
# A job may publish business metrics by appending JSON objects to the file named
# by JOB_FACTS_FILE, which this script exports. Guarded by the variable's
# existence, so running the job by hand behaves identically.
#
# The job must never fail because the monitor is down: this writes to a file,
# and only the collector depends on the database.
set -u

HEARTBEAT_DIR="${JOB_HEARTBEAT_DIR:-$HOME/.job-heartbeat}"

if [ "$#" -lt 3 ] || [ "$2" != "--" ]; then
    echo "usage: run-job.sh <job_id> -- <command> [args...]" >&2
    exit 64
fi

JOB_ID="$1"; shift 2

mkdir -p "$HEARTBEAT_DIR" || exit 65
FACTS_FILE="$(mktemp "${TMPDIR:-/tmp}/job-facts-${JOB_ID}.XXXXXX")"
export JOB_FACTS_FILE="$FACTS_FILE"

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STARTED_MS="$(date -u +%s%3N)"

"$@"
RC=$?

ENDED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DURATION_MS=$(( $(date -u +%s%3N) - STARTED_MS ))

# Merge whatever the job published. Each line is one JSON object; later keys
# win. Any parse error yields {} rather than losing the heartbeat.
FACTS="$(python3 - "$FACTS_FILE" <<'PY' 2>/dev/null || echo '{}'
import json, sys
merged = {}
try:
    with open(sys.argv[1], encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if isinstance(row, dict):
                merged.update(row)
except OSError:
    pass
print(json.dumps(merged))
PY
)"
rm -f "$FACTS_FILE"

printf '{"job":%s,"started_at":"%s","ended_at":"%s","exit_code":%d,"duration_ms":%d,"facts":%s}\n' \
    "\"$JOB_ID\"" "$STARTED_AT" "$ENDED_AT" "$RC" "$DURATION_MS" "${FACTS:-\{\}}" \
    >> "$HEARTBEAT_DIR/$JOB_ID.jsonl"

exit $RC

# The cron wrapper and heartbeat collector

## The wrapper: `run-job.sh`

Each cron job runs under a lightweight wrapper that times the job, captures its RAW exit code, and publishes a one-line heartbeat. The wrapper does not edit the job's output, logging or behaviour — it is invisible except for the heartbeat.

### Contract

```bash
run-job.sh <job_id> -- <command> [args...]
```

- `job_id`: stable identifier used as the heartbeat filename
- `command [args...]`: the actual cron command, unchanged

The wrapper exits with the same code the wrapped job returns. A job exiting 2 produces heartbeat `"exit_code":2`; the binding's `exit_code_map` is what turns `2` into a sentence on the panel (e.g., "source B failed").

### Business metrics: JOB_FACTS_FILE

The wrapper exports `JOB_FACTS_FILE` pointing to a temporary file. A job that wants to publish a metric appends one JSON object per line:

```bash
echo '{"rows_synced": 2693}' >> "$JOB_FACTS_FILE"
```

Later keys win. An object that is not JSON is silently dropped; a parse error does not lose the heartbeat. Running the job without the wrapper (by hand, or via direct cron) works identically — the env var simply does not exist, and the script skips the append.

### Heartbeat directory

```bash
$JOB_HEARTBEAT_DIR/job_id.jsonl
```

Defaults to `~/.job-heartbeat`. Each line is one JSON heartbeat:

```json
{"job":"job_c","started_at":"2026-09-22T01:00:01Z","ended_at":"2026-09-22T01:00:14Z","exit_code":0,"duration_ms":13204,"facts":{"rows_synced":2693}}
```

The collector reads this directory every five minutes. If the heartbeat directory cannot be created, the wrapper exits 65 but the job still runs — a missing monitor is not a reason for the job to fail.

## The collector: `ops/collector/run.py`

Runs every five minutes, discovering inventory and collecting telemetry into Postgres. Three probes run independently; if one fails, the others still complete and the collector's heartbeat records the failure.

### Installation

1. **Create the restricted role** (one time):

   ```bash
   docker exec -i flowops-postgres psql -U flow -d flows -v ON_ERROR_STOP=1 <<'SQL'
   CREATE ROLE flow_collector LOGIN PASSWORD 'set-a-real-password-here';
   GRANT USAGE ON SCHEMA flow TO flow_collector;
   GRANT SELECT, INSERT, UPDATE, DELETE
     ON flow.inventory_objects, flow.object_runs, flow.object_checks
     TO flow_collector;
   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA flow TO flow_collector;
   -- Reads bindings to know which tables to check; can never write them.
   GRANT SELECT ON flow.pipeline_bindings, flow.pipelines TO flow_collector;
   SQL
   ```

   Verify the role is restricted:

   ```bash
   PGPASSWORD='set-a-real-password-here' psql -h 127.0.0.1 -p 5435 -U flow_collector -d flows \
     -c "DELETE FROM flow.pipeline_bindings" 2>&1 | head -3
   ```

   Expected: `ERROR: permission denied for table pipeline_bindings`.

2. **Store the DSN** with mode 600:

   ```bash
   echo 'postgresql://flow_collector:password@127.0.0.1:5435/flows?options=-csearch_path%3Dflow' > ~/.flow-collector-dsn
   chmod 600 ~/.flow-collector-dsn
   ```

3. **Create the read-only role on each target database** (one time, per target).

   The collector reads production tables through `lineage_probe_ro` in
   `warehouse`. It is read-only **at the server**, not by convention:

   ```sql
   CREATE ROLE lineage_probe_ro LOGIN PASSWORD 'set-a-real-password-here';
   GRANT USAGE ON SCHEMA bronze, silver, gold, public TO lineage_probe_ro;
   GRANT SELECT ON ALL TABLES IN SCHEMA bronze, silver, gold, public TO lineage_probe_ro;
   ALTER ROLE lineage_probe_ro SET default_transaction_read_only = on;
   ALTER ROLE lineage_probe_ro SET statement_timeout = '15s';
   ```

   What it can do: `SELECT` in `bronze`, `silver`, `gold` and `public` — enough
   to list tables from `pg_tables`, count rows, and read a freshness column.

   What it cannot do: anything that writes. `CREATE TABLE`, `INSERT`, `UPDATE`,
   `DELETE` and temp tables are all refused by Postgres with
   `cannot execute ... in a read-only transaction`, because the two `ALTER ROLE`
   settings apply to every session the role opens regardless of what the client
   asks for. A bug in `probe_table.py` cannot damage production data; the
   role-level `statement_timeout` bounds the damage a slow query can do too.

   Verify both halves before wiring anything:

   ```bash
   docker exec -e PGPASSWORD="$(cat ~/.flow-probe-ro-pw)" warehouse-postgres \
     psql -U lineage_probe_ro -d warehouse -tAq \
     -c "SELECT count(*) FROM silver.table_a" \
     -c "CREATE TABLE should_fail (x int)"
   ```

   Expected: a row count, then `ERROR: cannot execute CREATE TABLE in a
   read-only transaction`.

   Store the password in `~/.flow-probe-ro-pw` with mode 600 and reference it
   from the target config by path — never inline.

4. **Write the target configuration** (`~/.flow-collector-targets.json`,
   mode 600).

   Keys are the inventory object's `source`; the value describes how to reach
   that database. The collector prefers `COLLECTOR_TARGETS_FILE` over the inline
   `COLLECTOR_TARGET_DSNS` variable, so the secret path never appears in the
   crontab:

   ```json
   {
     "warehouse": {
       "container": "warehouse-postgres",
       "user": "lineage_probe_ro",
       "db": "warehouse",
       "password_file": "/etc/lineos/probe_ro_pw",
       "schemas": ["bronze", "silver", "gold"]
     }
   }
   ```

   `password_file` is read at startup; use it instead of a `password` key so no
   credential is ever stored in this file. `schemas` defaults to `["public"]`
   when omitted. A target given as a plain DSN string still works for the
   freshness check but is **skipped by table discovery**, which needs a container
   to `docker exec` into — the log says so explicitly.

   The probes reach the target through `docker exec`, not a host IP. Container
   IPs are reassigned on recreation, and a mirror on this host has already died
   silently that way once.

   ### How table discovery works

   Every cycle, for each configured target, the collector lists `pg_tables` in
   the configured schemas and upserts one inventory object of `kind='table'` per
   table. Against `warehouse` this finds **50 tables**.

   Without this step nothing creates a `table` object at all, so no table can be
   bound and the `table` half of the health rules is unreachable rather than
   merely unused.

   Discovery reads **names only** — no counts, no timestamps. Counting fifty
   tables every five minutes just to populate a dropdown would put real read load
   on a production database for nothing. The row count and the freshness
   timestamp arrive with the freshness check, and only for the tables somebody
   actually bound to a pipeline node.

   Freshness timestamps are emitted as canonical UTC by the SQL itself
   (`to_char(... AT TIME ZONE 'UTC', ...)`), not normalised after the fact. This
   host runs BRT, and `psql`'s two-digit offset (`-03`) once parsed as UTC
   without raising anything — a silent three-hour error in every freshness
   comparison. Do not move that conversion back into the parser.

5. **Install the collector in crontab**:

   ```bash
   crontab -l > /tmp/crontab.backup
   ```

   Add this line (all on one line):

   ```
   */5 * * * * COLLECTOR_DSN_FILE=/etc/lineos/collector-dsn COLLECTOR_TARGETS_FILE=/etc/lineos/collector-targets.json /usr/bin/flock -n /tmp/flow-collector.lock /opt/lineos/ops/run-job.sh flow_collector -- /opt/lineos/venv/bin/python /opt/lineos/ops/collector/run.py >> /var/log/lineos/collector.log 2>&1
   ```

   The collector reads `COLLECTOR_DSN_FILE` when `COLLECTOR_DSN` is not set in the environment. `flock -n` ensures only one collector runs at a time; `-n` makes it skip if the lock is held.



## Notes

- The wrapper writes to a file; only the collector depends on the database. A stopped collector does not affect the wrapped jobs.
- The collector's heartbeat is itself wrapped in `run-job.sh`, so its own failures are recorded in `~/.job-heartbeat/flow_collector.jsonl`.


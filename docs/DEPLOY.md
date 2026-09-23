# Deploy

## First run

```bash
git clone https://github.com/dpadoveis/lineOS && cd lineOS
cp .env.example .env        # set FLOW_DB_PASSWORD
docker compose up -d        # postgres + api + frontend
```

Open `http://localhost:8020`. The first screen is **Set up lineOS**: the account
created there is the server's admin. After it, who may sign up is
`FLOW_REGISTRATION`:

| Value | Who can create an account |
| --- | --- |
| `invite` (default) | only someone who opened a live share link in that browser tab — sharing a diagram by link or by email is the invitation |
| `open` | anyone who reaches the app — fine on a private network, wrong on the internet |
| `closed` | nobody |

Nothing else is required. The images carry no instance data; every setting
comes from `.env`.

## Settings

All of them live in `.env` (see `.env.example` for the full list and comments):

| Variable | Default | What it does |
| --- | --- | --- |
| `FLOW_DB_PASSWORD` | — (required) | the Postgres password, fixed at the volume's first boot |
| `FLOW_BIND_IP`, `FLOW_HTTP_PORT` | `127.0.0.1`, `8020` | where the app listens |
| `FLOW_BASE` | `/` | the subpath, e.g. `/lineos/`; rebuild the frontend after changing it |
| `FLOW_PUBLIC_BASE_URL` | `http://localhost:8020/` | the address written into sharing emails |
| `FLOW_SESSION_COOKIE_SECURE` | `false` | turn on once the app is served over HTTPS only |
| `FLOW_REGISTRATION` | `invite` | see above |
| `FLOW_SMTP_*` | empty | optional; without it "Send by email" opens the user's mail client |
| `FLOW_API_PORT`, `FLOW_DB_PORT` | `8010`, `5433` | loopback ports for `npm run dev` and for the collector |

## Behind a reverse proxy

Put a proxy with HTTPS in front of port `8020` and pass paths through
untouched; the frontend's nginx serves the SPA and proxies `/api` itself. Then
set `FLOW_PUBLIC_BASE_URL` to the public address and
`FLOW_SESSION_COOKIE_SECURE=true`.

To share a host with other apps, serve lineOS under a subpath:

```bash
# .env
FLOW_BASE=/lineos/
FLOW_PUBLIC_BASE_URL=https://example.com/lineos/
```

```bash
docker compose up -d --build frontend
```

and forward `/lineos/` from the proxy. The subpath is fixed at build time,
because Vite rewrites the asset URLs.

The frontend's nginx rate-limits the credential routes (`/api/auth/`, 10 a
minute per address). Behind a proxy every visitor shares the proxy's address,
so rate-limit on the proxy as well.

## Data Lineage

The **collector** (`ops/collector`) runs on the host from cron and writes
telemetry to the stack's Postgres through a restricted role —
[`ops/README.md`](../ops/README.md) has the steps.

The **dataset tabs** (schema, preview, stats) read a Postgres of yours,
read-only. That is an override, so the base stack never depends on it:

```bash
# .env: LINEAGE_SOURCE_NETWORK, _HOST, _DB, _USER, _PASSWORD_FILE (see .env.example)
docker compose -f docker-compose.yml -f docker-compose.lineage.yml up -d
```

The role must be read-only at the server (`ALTER ROLE ... SET
default_transaction_read_only = on`); `ops/README.md` §3 shows how.

## Updating

```bash
git pull
docker compose up -d --build
```

Schema changes run at the API's startup (`backend/app/migrations.py`), and are
idempotent.

## Backups

```bash
docker compose exec -T postgres pg_dump -U lineos -d lineos -Fc > lineos.dump
docker run --rm -v lineos_files:/d -v "$PWD:/b" alpine tar czf /b/files.tgz -C /d .
```

## Coming from a Flow Editor deployment

The stack used to be the compose project `flow-editor`, with the database
`flows` owned by `flow` and the volume `flow_files`. lineOS starts with fresh
names (`lineos`, `lineos_pgdata`, `lineos_files`). To carry the data over,
restore a `pg_dump` of the old database into the new one and copy the files
volume, or point a `docker-compose.override.yml` at the old volumes and
database. The old `/flow-editor/` subpath is `FLOW_BASE=/flow-editor/`.

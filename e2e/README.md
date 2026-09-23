# End to end

> ⚠️ **These tests really write to the database of whatever API they reach.**
> They register accounts, create diagrams and share them. The default
> `npm run dev` proxies `/api` to `127.0.0.1:8010`, which is **your stack's
> API** — running the suite against it dirties your real database and, if any
> ownerless flow is still around, the first test sign-up **adopts** it. Start a
> disposable API first.

The suite is not wired into CI yet (see `docs/ROADMAP.md` §0.4), and the specs
expect a server where anyone may sign up — the disposable API below runs with
`REGISTRATION=open`.

## A disposable API on 8011

With the stack up (`docker compose up -d`), a second API on a database of its
own:

```bash
# a database for tests only (once)
docker compose exec postgres psql -U lineos -d lineos -c "CREATE DATABASE lineos_e2e"

# the API pointed at it, on 8011 (the image and network come from the stack)
docker run -d --rm --name lineos-api-e2e --network lineos_lineos -p 127.0.0.1:8011:8000 \
  -e DATABASE_URL="postgresql+psycopg://lineos:$(grep FLOW_DB_PASSWORD .env | cut -d= -f2)@postgres:5432/lineos_e2e" \
  -e DB_SCHEMA=flow -e REGISTRATION=open lineos-api
```

When you are done: `docker rm -f lineos-api-e2e`.

## Running

```bash
npm install --no-save @playwright/test && npx playwright install chromium

FLOW_API_TARGET=http://127.0.0.1:8011 npm run dev &     # Vite talking to the test API
npx playwright test --config e2e/playwright.config.js
```

## Cleaning up, if you ran it in the wrong place

Test accounts use the `@test.local` domain, and the diagrams they created belong
to those accounts. Deleting the user sets `owner_id` back to `NULL` (the foreign
key is `ON DELETE SET NULL`), which is the "flow waiting for an owner" state:

```sql
DELETE FROM flow.flows WHERE owner_id IN (SELECT id FROM flow.users WHERE email LIKE '%@test.local');
DELETE FROM flow.users WHERE email LIKE '%@test.local';
```

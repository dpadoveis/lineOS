# End to end

> ⚠️ **These tests really write to the database of whatever API they reach.**
> They register accounts, create diagrams and share them. The default
> `npm run dev` proxies `/api` to `127.0.0.1:8010`, which is **this host's
> production API** — running the suite against it dirties the real database
> and, if any ownerless flow is still around, the first test sign-up **adopts**
> yours. Start a disposable API first.

## A disposable API on 8011

```bash
# a database for tests only (once)
docker exec flow-postgres psql -U flow -d postgres -c "CREATE DATABASE flows_e2e OWNER flow"

# the API pointed at it, on 8011
docker run -d --rm --name flow-api-e2e --network flow-net -p 127.0.0.1:8011:8000 \
  -e DATABASE_URL="postgresql+psycopg://flow:$(grep FLOW_DB_PASSWORD ../.env | cut -d= -f2)@postgres:5432/flows_e2e" \
  -e DB_SCHEMA=flow flow-editor-api
```

## Running

```bash
FLOW_API_TARGET=http://127.0.0.1:8011 npm run dev &     # Vite talking to the test API

BT_BASE_URL=http://localhost:5173 BT_TEST_DIR="$PWD/e2e" \
  bt test --config ~/tools/browser-test/playwright.config.js --project chromium-dark
```

When you are done: `docker rm -f flow-api-e2e`.

The Playwright engine is the shared `~/tools/browser-test` environment (the
project installs no Playwright of its own); the specs live here, in the project.

## Cleaning up, if you ran it in the wrong place

Test accounts use the `@test.local` domain, and the diagrams they created belong
to those accounts. Deleting the user sets `owner_id` back to `NULL` (the foreign
key is `ON DELETE SET NULL`), which is the "flow waiting for an owner" state:

```sql
DELETE FROM flow.flows WHERE owner_id IN (SELECT id FROM flow.users WHERE email LIKE '%@test.local');
DELETE FROM flow.users WHERE email LIKE '%@test.local';
```

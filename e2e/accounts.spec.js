// End-to-end coverage of accounts and sharing.
//
// WARNING: THESE TESTS WRITE TO THE DATABASE OF WHATEVER API THEY REACH. They
// register accounts, create diagrams and share them. The default `npm run dev`
// proxies to the PRODUCTION API (127.0.0.1:8010): running it that way dirties
// the real database and, if any ownerless flow is left, the first test sign-up
// ADOPTS the real flows. Start the disposable API on 8011 first -- the steps are
// in e2e/README.md.
//
// Every run creates accounts with a unique email (@test.local), so it never
// depends on the database being cleaned between rounds.
import { test, expect } from '@playwright/test';

const PASSWORD = 'test-password-123';
const account = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.local`;

async function signUp(page, email, name) {
  await page.goto('/');
  await page.getByRole('button', { name: "I don't have an account yet" }).click();
  await page.getByPlaceholder('How your name shows on shared diagrams').fill(name);
  await page.getByPlaceholder('you@company.com').fill(email);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Your diagrams' })).toBeVisible();
}

async function createDiagram(page, name) {
  await page.getByRole('button', { name: /New diagram/ }).click();
  await expect(page.locator('.fe-canvas')).toBeVisible();
  // Drop a tool on the plane and save it as a new flow.
  await page.locator('.fe-tool-row').first().click();
  await expect(page.locator('.fe-node')).toHaveCount(1);
  page.once('dialog', (d) => d.accept(name));
  await page.locator('.fe-save-anchor .fe-btn').click();
  await page.getByText('Save as new…').click();
  await expect(page.locator('.fe-doc-name')).toContainText(name);
}

test('signing up lands on the home and the new diagram shows up there', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await signUp(page, account('owner'), 'Test Owner');
  await expect(page.getByText('Nothing here yet')).toBeVisible();

  await createDiagram(page, 'Pipeline E2E');

  await page.locator('.fe-home-link').click();
  await expect(page.getByRole('heading', { name: 'Your diagrams' })).toBeVisible();
  await expect(page.locator('.fe-card-name')).toContainText('Pipeline E2E');
  await expect(page.locator('.fe-perm-full')).toBeVisible();

  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});

test('the Share menu opens with its three options and creates a link', async ({ page, context }) => {
  await signUp(page, account('share'), 'The Sharer');
  await createDiagram(page, 'Shared diagram');

  await page.locator('.fe-actions-anchor .fe-btn').click();
  await page.getByText('Share diagram').click();
  await expect(page.getByText('Share with a user')).toBeVisible();
  await expect(page.getByText('Share a link')).toBeVisible();
  await expect(page.getByText('Send by email')).toBeVisible();

  await page.getByText('Share a link').click();
  await page.locator('.fe-share-form .fe-select').selectOption('view');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: /Create/ }).click();
  await expect(page.locator('.fe-share-notice')).toContainText('link copied');

  const url = await page.evaluate(() => navigator.clipboard.readText());
  expect(url).toContain('#/share/');

  // The link opens the diagram in another tab, with no account, read-only.
  const anonymous = await (await page.context().browser().newContext()).newPage();
  await anonymous.goto(url);
  await expect(anonymous.locator('.fe-readonly')).toBeVisible();
  await expect(anonymous.locator('.fe-node')).toHaveCount(1);
  // Without edit permission the Actions menu offers no sharing entry.
  await anonymous.locator('.fe-actions-anchor .fe-btn').click();
  await expect(anonymous.getByText('Share diagram')).toHaveCount(0);
});

test('sharing with a user grants edit access', async ({ page, browser }) => {
  const guestEmail = account('guest');
  const other = await (await browser.newContext()).newPage();
  await signUp(other, guestEmail, 'Guest');

  await signUp(page, account('owner2'), 'Owner Two');
  await createDiagram(page, 'Coworking');

  await page.locator('.fe-actions-anchor .fe-btn').click();
  await page.getByText('Share diagram').click();
  await page.getByText('Share with a user').click();
  await page.getByPlaceholder('teammate@company.com').fill(guestEmail);
  await page.locator('.fe-share-form .fe-select').selectOption('edit');
  await page.locator('.fe-share-form button[type="submit"]').click();
  await expect(page.locator('.fe-share-item')).toContainText('Guest');

  // The guest finds the diagram on their own home, under "Shared with you".
  await other.reload();
  await expect(other.getByText('Shared with you')).toBeVisible();
  await expect(other.locator('.fe-card-name')).toContainText('Coworking');
  await expect(other.locator('.fe-perm-edit')).toBeVisible();

  await other.locator('.fe-card-main').click();
  await expect(other.locator('.fe-canvas')).toBeVisible();
  // They can edit, but not manage who else gets in.
  await expect(other.locator('.fe-readonly')).toHaveCount(0);
  await other.locator('.fe-actions-anchor .fe-btn').click();
  await expect(other.getByText('Share diagram')).toHaveCount(0);
});

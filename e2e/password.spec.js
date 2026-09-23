// Changing the password through the interface: account menu -> modal -> the new
// password works on the next sign-in.
//
// WARNING: the same caveats as accounts.spec.js -- it writes to the database of
// whatever API it reaches. Start the disposable API on 8011 (see e2e/README.md)
// before running it.
import { test, expect } from '@playwright/test';
const PASSWORD = 'test-password-123';
const account = () => `password-${Date.now()}@test.local`;

test('the account menu and changing the password', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // The 403 from the wrong-current-password attempt is caused by the test itself.
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('403')) errors.push(m.text());
  });

  const email = account();
  await page.goto('/');
  await page.getByRole('button', { name: "I don't have an account yet" }).click();
  await page.getByPlaceholder('How your name shows on shared diagrams').fill('Alice Example');
  await page.getByPlaceholder('you@company.com').fill(email);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Your diagrams' })).toBeVisible();

  await page.locator('.fe-home-user').click();
  await expect(page.locator('.fe-account-menu')).toBeVisible();

  await page.locator('.fe-account-menu').getByText('Change password').click();
  await expect(page.locator('.fe-modal-title')).toHaveText('Change password');

  // Wrong current password -> the server's message.
  await page.locator('input[autocomplete="current-password"]').fill('wrong-one');
  const newFields = page.locator('input[autocomplete="new-password"]');
  await newFields.nth(0).fill('new-strong-password-1');
  await newFields.nth(1).fill('new-strong-password-1');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.locator('.fe-modal-error')).toContainText('current password is incorrect');

  // Now the right one.
  await page.locator('input[autocomplete="current-password"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.locator('.fe-home-notice')).toContainText('Password changed');

  // The new password works on the next sign-in.
  await page.locator('.fe-home-user').click();
  await page.locator('.fe-account-menu').getByText('Sign out').click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await page.getByPlaceholder('you@company.com').fill(email);
  await page.getByPlaceholder('••••••••').fill('new-strong-password-1');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Your diagrams' })).toBeVisible();

  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});

// The tool catalog: registering a tool and editing one already registered.
//
// WARNING: like every spec here, this WRITES to whatever API it reaches, and
// the catalog is server-wide (it is not scoped to an account). Run it against
// the disposable API on 8011 -- see e2e/README.md -- or it pollutes the real
// sidebar for everyone. Each run names its tool with a timestamp, so repeated
// rounds never collide.
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

async function newDiagram(page) {
  await page.getByRole('button', { name: /New diagram/ }).click();
  await expect(page.locator('.fe-canvas')).toBeVisible();
}

test('a registered tool is edited from the sidebar and the catalog follows', async ({ page }) => {
  const stamp = Date.now();
  const before = `Trino ${stamp}`;
  const after = `Trino ${stamp} renamed`;

  await signUp(page, account('tools'), 'Tool Owner');
  await page.getByRole('button', { name: /New diagram/ }).click();
  await expect(page.locator('.fe-canvas')).toBeVisible();

  // Register one, so there is something to edit.
  await page.getByRole('button', { name: /New tool/ }).first().click();
  await page.getByPlaceholder('Trino, Databricks, internal service…').fill(before);
  await page.getByRole('button', { name: 'Create tool' }).click();
  await expect(page.locator('.fe-tool-name').first()).toHaveText(before);

  // Edit it: the button below "New tool" opens the same form, filled in.
  await page.getByRole('button', { name: /Edit tool/ }).click();
  await expect(page.locator('.fe-modal-title')).toHaveText('Edit tool');
  const nameField = page.getByPlaceholder('Trino, Databricks, internal service…');
  await expect(nameField).toHaveValue(before);
  await nameField.fill(after);
  await page.locator('.fe-field').filter({ hasText: 'Category' }).locator('select').selectOption('STREAM');
  await page.getByRole('button', { name: 'Save changes' }).click();

  await expect(page.locator('.fe-tool-name').first()).toHaveText(after);
  await expect(page.locator('.fe-tool-cat').first()).toHaveText('STREAM');

  // It is the catalog on the server that changed, not the open document.
  await page.reload();
  await expect(page.locator('.fe-tool-name').first()).toHaveText(after);
});


test('a built-in tool is editable, and the edit replaces it in the sidebar', async ({ page }) => {
  const stamp = Date.now();
  await signUp(page, account('builtin'), 'Builtin Editor');
  await newDiagram(page);

  // Which built-in is picked cannot be hardcoded: the catalog is server-wide,
  // so an earlier run may already have materialised the one we had in mind.
  // A built-in row is the one offering "+" instead of the remove "x".
  const builtinRow = page.locator('.fe-tool-row', { has: page.locator('.fe-tool-plus') }).first();
  const builtin = (await builtinRow.locator('.fe-tool-name').textContent()).trim();
  const renamed = `${builtin} ${stamp}`;

  await page.getByRole('button', { name: /Edit tool/ }).click();
  const picker = page.locator('.fe-field').filter({ hasText: 'Tool' }).locator('select');
  // The option value of a built-in is "b" + its name (a registered tool is
  // "c" + its id) -- see keyOf() in ToolModal.jsx.
  await picker.selectOption(`b${builtin}`);
  await page.getByPlaceholder('Trino, Databricks, internal service…').fill(renamed);
  await page.getByRole('button', { name: 'Save changes' }).click();

  // The source entry is gone from the list; the row standing for it is in.
  await expect(page.locator('.fe-tool-name', { hasText: new RegExp(`^${builtin}$`) })).toHaveCount(0);
  await expect(page.locator('.fe-tool-name', { hasText: renamed })).toHaveCount(1);
  await page.reload();
  await expect(page.locator('.fe-tool-name', { hasText: renamed })).toHaveCount(1);
});

test('the danger zone refuses to delete a tool that a diagram uses', async ({ page }) => {
  const stamp = Date.now();
  const name = `Doomed ${stamp}`;
  await signUp(page, account('danger'), 'Danger Zone');
  await newDiagram(page);

  await page.getByRole('button', { name: /New tool/ }).first().click();
  await page.getByPlaceholder('Trino, Databricks, internal service…').fill(name);
  await page.getByRole('button', { name: 'Create tool' }).click();
  await expect(page.locator('.fe-tool-name').first()).toHaveText(name);

  // Unused: the delete is offered.
  await page.getByRole('button', { name: /Edit tool/ }).click();
  await expect(page.locator('.fe-danger-sub')).toContainText('Not used in any diagram');
  await expect(page.getByRole('button', { name: 'Delete tool' })).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel' }).click();

  // Put it on the plane and save the diagram: now it is in use.
  await page.locator('.fe-tool-row').first().click();
  await expect(page.locator('.fe-node')).toHaveCount(1);
  page.once('dialog', (d) => d.accept('Uses the tool'));
  await page.locator('.fe-save-anchor .fe-btn').click();
  await page.getByText('Save as new…').click();
  await expect(page.locator('.fe-doc-name')).toContainText('Uses the tool');

  await page.getByRole('button', { name: /Edit tool/ }).click();
  await expect(page.locator('.fe-danger-sub')).toContainText('In use in 1 diagram');
  await expect(page.locator('.fe-danger-list')).toContainText('Uses the tool');
  await expect(page.getByRole('button', { name: 'Delete tool' })).toBeDisabled();
});

test('an unused tool is deleted from the danger zone', async ({ page }) => {
  const name = `Throwaway ${Date.now()}`;
  await signUp(page, account('delete'), 'Deleter');
  await newDiagram(page);

  await page.getByRole('button', { name: /New tool/ }).first().click();
  await page.getByPlaceholder('Trino, Databricks, internal service…').fill(name);
  await page.getByRole('button', { name: 'Create tool' }).click();
  await expect(page.locator('.fe-tool-name').first()).toHaveText(name);

  await page.getByRole('button', { name: /Edit tool/ }).click();
  await expect(page.getByRole('button', { name: 'Delete tool' })).toBeEnabled();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Delete tool' }).click();

  await expect(page.locator('.fe-statusbar')).toContainText('removed from the catalog');
  await expect(page.locator('.fe-tool-name', { hasText: name })).toHaveCount(0);
});

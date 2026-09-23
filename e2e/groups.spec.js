// Grouping nodes: creating the box out of a selection, moving it with its
// content, and the membership that follows the geometry.
//
// WARNING: the same caveats as accounts.spec.js -- it writes to the database of
// whatever API it reaches. Start the disposable API on 8011 (see e2e/README.md)
// before running it.
import { test, expect } from '@playwright/test';

const PASSWORD = 'test-password-123';
const account = () => `groups-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.local`;

async function signUp(page) {
  await page.goto('/');
  await page.getByRole('button', { name: "I don't have an account yet" }).click();
  await page.getByPlaceholder('How your name shows on shared diagrams').fill('Group tester');
  await page.getByPlaceholder('you@company.com').fill(account());
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Your diagrams' })).toBeVisible();
  await page.getByRole('button', { name: /New diagram/ }).click();
  await expect(page.locator('.fe-canvas')).toBeVisible();
}

const centreOf = async (locator) => {
  const b = await locator.boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

// A drag on the plane: press, move in two steps (one alone is swallowed as a
// click by some builds), release.
async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

// Two nodes, dragged apart so neither sits on top of the other.
async function twoNodes(page) {
  const rows = page.locator('.fe-tool-row');
  await rows.nth(0).click();
  await drag(page, await centreOf(page.locator('.fe-node').nth(0)), { x: 620, y: 320 });
  await rows.nth(1).click();
  const added = page.locator('.fe-node').nth(1);
  await drag(page, await centreOf(added), { x: 980, y: 560 });
  await expect(page.locator('.fe-node')).toHaveCount(2);
}

async function selectBoth(page) {
  // A click on the empty plane first: Ctrl+click ADDS to what is selected, and
  // the last node dropped is still selected at this point.
  await page.mouse.click(300, 700);
  await page.keyboard.down('Control');
  await page.locator('.fe-node').nth(0).click({ position: { x: 60, y: 6 } });
  await page.locator('.fe-node').nth(1).click({ position: { x: 60, y: 6 } });
  await page.keyboard.up('Control');
  await expect(page.locator('.fe-status-msg')).toContainText('2 nodes selected');
}

test('Ctrl+click, group, and the box carries its nodes', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await signUp(page);
  await twoNodes(page);
  await selectBoth(page);

  // Right click on one of the selected nodes offers the group.
  await page.locator('.fe-node').nth(1).click({ button: 'right', position: { x: 60, y: 6 } });
  await expect(page.locator('.fe-context-item', { hasText: 'Create group' })).toBeVisible();
  await page.locator('.fe-context-item', { hasText: 'Create group' }).click();

  const box = page.locator('.fe-group');
  await expect(box).toHaveCount(1);
  await expect(box.locator('.fe-group-count')).toHaveText('2 nodes');

  // The box surrounds both cards.
  const bb = await box.boundingBox();
  for (const i of [0, 1]) {
    const nb = await page.locator('.fe-node').nth(i).boundingBox();
    expect(nb.x).toBeGreaterThanOrEqual(bb.x);
    expect(nb.y).toBeGreaterThanOrEqual(bb.y);
    expect(nb.x + nb.width).toBeLessThanOrEqual(bb.x + bb.width);
  }

  // Dragging the box by its title bar moves everything inside it, by the same
  // amount and without rearranging anything.
  const before = await Promise.all([0, 1].map((i) => page.locator('.fe-node').nth(i).boundingBox()));
  await drag(page, { x: bb.x + 90, y: bb.y + 17 }, { x: bb.x + 90 - 168, y: bb.y + 17 - 96 });
  const after = await Promise.all([0, 1].map((i) => page.locator('.fe-node').nth(i).boundingBox()));
  after.forEach((nb, i) => {
    expect(Math.round(nb.x - before[i].x)).toBe(-168);
    expect(Math.round(nb.y - before[i].y)).toBe(-96);
  });
  await expect(box.locator('.fe-group-count')).toHaveText('2 nodes');

  expect(errors).toEqual([]);
});

test('a node dragged out of the box leaves the group, and one dragged in joins it', async ({ page }) => {
  await signUp(page);
  await twoNodes(page);
  await selectBoth(page);
  await page.locator('.fe-node').nth(1).click({ button: 'right', position: { x: 60, y: 6 } });
  await page.locator('.fe-context-item', { hasText: 'Create group' }).click();

  const box = page.locator('.fe-group');
  const count = box.locator('.fe-group-count');
  await expect(count).toHaveText('2 nodes');

  // Out: the card is dragged well clear of the box.
  const first = page.locator('.fe-node').nth(0);
  const bb = await box.boundingBox();
  await drag(page, await centreOf(first), { x: bb.x + bb.width + 260, y: bb.y + 60 });
  await expect(count).toHaveText('1 node');

  // ...and the other one has not moved with it: it is still inside.
  const other = await page.locator('.fe-node').nth(1).boundingBox();
  expect(other.x).toBeGreaterThan(bb.x);

  // In again: dropping it back inside is all it takes to rejoin.
  await drag(page, await centreOf(first), { x: bb.x + 120, y: bb.y + bb.height - 60 });
  await expect(count).toHaveText('2 nodes');
});

test('the box is renamed, recoloured, resized and survives a save', async ({ page }) => {
  await signUp(page);
  await twoNodes(page);
  await selectBoth(page);
  await page.locator('.fe-node').nth(1).click({ button: 'right', position: { x: 60, y: 6 } });
  await page.locator('.fe-context-item', { hasText: 'Create group' }).click();

  const box = page.locator('.fe-group');
  await box.locator('.fe-group-name').dblclick();
  await page.locator('.fe-group-rename').fill('Ingestion');
  await page.keyboard.press('Enter');
  await expect(box.locator('.fe-group-name')).toHaveText('Ingestion');

  // Colour: the swatch opens the palette, the chip paints the box.
  await box.locator('.fe-group-swatch').click();
  await page.locator('.fe-group-chip').nth(4).click();
  await expect(page.locator('.fe-group-palette')).toHaveCount(0);
  const painted = await box.evaluate((el) => getComputedStyle(el).borderColor);
  expect(painted).toBe('rgb(232, 149, 106)');

  // Resize by the corner handle. Zoom out first: the box is taller than the
  // viewport here, and its corner has to be on screen to be grabbed.
  await page.locator('.fe-zoom-btn', { hasText: '−' }).click();
  const bb = await box.boundingBox();
  // Grabbed by the middle of the handle: the box corner is rounded, so the
  // very corner pixel belongs to the plane behind it.
  await drag(page, await centreOf(box.locator('.fe-group-resize')), { x: bb.x + bb.width + 180, y: bb.y + bb.height + 120 });
  const grown = await box.boundingBox();
  expect(grown.width).toBeGreaterThan(bb.width + 150);
  expect(grown.height).toBeGreaterThan(bb.height + 90);

  // The whole thing goes to the server and comes back.
  page.once('dialog', (d) => d.accept('Flow with a group'));
  await page.locator('.fe-save-anchor .fe-btn').click();
  await page.getByText('Save as new…').click();
  await expect(page.locator('.fe-doc-name')).toContainText('Flow with a group');

  // Reopened from the library, the box comes back with its name, its colour
  // and the two nodes it holds -- membership included, since the count is
  // recomputed from the coordinates that were stored.
  await page.locator('.fe-home-link').click();
  await expect(page.getByRole('heading', { name: 'Your diagrams' })).toBeVisible();
  await page.locator('.fe-card-name', { hasText: 'Flow with a group' }).click();
  await expect(page.locator('.fe-group')).toHaveCount(1);
  await expect(page.locator('.fe-group-name')).toHaveText('Ingestion');
  await expect(page.locator('.fe-group-count')).toHaveText('2 nodes');
  expect(await page.locator('.fe-group').evaluate((el) => getComputedStyle(el).borderColor)).toBe('rgb(232, 149, 106)');
});

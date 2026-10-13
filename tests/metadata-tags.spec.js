/**
 * Tests for model metadata (designer, parent, license, source, notes) and tags.
 * Covers adding new values, applying existing values, in both single-edit and multi-edit.
 * Assumes test-fixtures/scan-me has cube.stl and test.stl.
 * Run: npm test -- metadata-tags.spec.js
 * Note: Close any running Printventory instance first (single-instance lock).
 */
const { test, expect, _electron: electron } = require('@playwright/test');
const { getElectronLaunchOptions, getSmallFixtureScanPath, cleanTestArtifacts, dismissOnboarding, acceptTerms, runDirectoryScan, saveCurrentModel } = require('./test-utils');


let app;
let window;

async function ensureGridLoaded() {
  await window.evaluate(async () => {
    if (typeof window.performCombinedSearch === 'function') await window.performCombinedSearch();
  });
  await window.waitForFunction(
    (n) => {
      const el = document.getElementById('view-count');
      if (!el) return false;
      const m = el.textContent.match(/(\d+)\s+model/);
      return m ? parseInt(m[1], 10) >= n : false;
    },
    2,
    { timeout: 15000 }
  );
}

/**
 * Show the Nth model (1-based) in the single-edit details panel. Clicking the model that is
 * already open toggles the panel closed, so only click when a different model (or none) is shown.
 */
async function openNthModelDetails(n) {
  const targetPath = await getNthModelPath(n);
  const item = window.locator('.file-grid .file-item[data-filepath]').nth(n - 1);
  const openPath = await window.evaluate(() => {
    const details = document.getElementById('model-details');
    if (!details || details.classList.contains('hidden')) return null;
    return typeof getCurrentModelFilePath === 'function' ? getCurrentModelFilePath() : null;
  });
  if (openPath !== targetPath) {
    await item.click();
  }
  await expect(window.locator('#model-details')).not.toHaveClass(/hidden/);
  await expect(window.locator('#model-name')).toBeVisible({ timeout: 5000 });
  await window.waitForTimeout(300);
}

/** Click first model in grid and wait for single-edit details panel. */
async function openFirstModelDetails() {
  await openNthModelDetails(1);
}


/**
 * Models sharing a parent model are shown as one collapsed group in the grid; expand groups so
 * their models are individually clickable (the parent-model tests below create such a group).
 */
async function expandParentGroups() {
  const collapsed = window.locator('.file-grid .parent-model-group[aria-expanded="false"]');
  for (let i = await collapsed.count(); i > 0; i--) {
    const group = collapsed.first();
    await group.click();
    await expect(group).not.toHaveAttribute('aria-expanded', 'false').catch(() => {});
  }
}

/** Get file path of the first model in the grid (for IPC verification). */
async function getFirstModelPath() {
  return await getNthModelPath(1);
}

/**
 * Get file path of the Nth model (1-based). The grid re-renders after each auto-save, so wait
 * for a real cell with a path rather than reading a cell that is mid-rebuild.
 */
async function getNthModelPath(n) {
  await expandParentGroups();
  const item = window.locator('.file-grid .file-item[data-filepath]').nth(n - 1);
  await expect(item).toHaveAttribute('data-filepath', /.+/);
  return await item.getAttribute('data-filepath');
}

/** Get model data from main process via renderer. */
async function getModelData(filePath) {
  return await window.evaluate(async (path) => {
    return await window.electron.getModel(path);
  }, filePath);
}

/** Tag names on a model, as stored in the database. */
async function getTagNames(filePath) {
  const model = await getModelData(filePath);
  return (model?.tags || []).map((t) => (typeof t === 'string' ? t : t.name));
}

/**
 * Multi-edit stays on after an auto-save (it used to exit on Save), and Ctrl+E toggles it,
 * so only press the shortcut when the panel is closed. Then select both models.
 */
async function ensureMultiEditAllSelected() {
  const panel = window.locator('#multi-edit-panel');
  if (await panel.evaluate((el) => el.classList.contains('hidden'))) {
    await window.keyboard.press('Control+e');
  }
  await expect(panel).not.toHaveClass(/hidden/);
  await window.locator('#select-all-button').click();
  await expect(window.locator('.selected-count')).toContainText('2');
}

/** Fields auto-save (the Save buttons are hidden in CSS); wait until the value reaches the database. */
async function expectSaved(filePath, field, value) {
  await expect.poll(async () => (await getModelData(filePath))?.[field], { timeout: 10000 }).toBe(value);
}

test.describe('Metadata and tags', () => {
  test.beforeAll(async () => {
    cleanTestArtifacts();
    // Small fixture only: getTestScanPath() prefers the large C:\TEST_FILES corpus when present.
    app = await electron.launch(getElectronLaunchOptions({
      PRINTVENTORY_TEST_SCAN_PATH: getSmallFixtureScanPath()
    }));
    window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    await acceptTerms(window);
    await dismissOnboarding(window);
    await runDirectoryScan(window, 120000, 2);
    await ensureGridLoaded();
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  // --- Single-edit: add new values ---
  test('Single-edit: add new designer and save', async () => {
    await openFirstModelDetails();
    await window.locator('#add-new-designer-button').click();
    await expect(window.locator('#new-designer-dialog')).toBeVisible();
    await window.locator('#new-designer-name').fill('TestDesigner');
    await window.locator('#add-designer-button').click();
    await window.waitForTimeout(300);
    await expect(window.locator('#model-designer')).toHaveValue('TestDesigner');
    const filePath = await getFirstModelPath();
    await expectSaved(filePath, 'designer', 'TestDesigner');
  });

  test('Single-edit: apply existing designer to another model', async () => {
    await openNthModelDetails(2);
    await window.locator('#model-designer').selectOption({ label: 'TestDesigner' });
    const filePath = await getNthModelPath(2);
    await expectSaved(filePath, 'designer', 'TestDesigner');
  });

  test('Single-edit: add new parent model and save', async () => {
    await openFirstModelDetails();
    await window.locator('#add-new-parent-button').click();
    await expect(window.locator('#new-parent-dialog')).toBeVisible();
    await window.locator('#new-parent-name').fill('TestParent');
    await window.locator('#add-parent-button').click();
    await window.waitForTimeout(300);
    await expect(window.locator('#model-parent')).toHaveValue('TestParent');
    const filePath = await getFirstModelPath();
    await expectSaved(filePath, 'parentModel', 'TestParent');
  });

  test('Single-edit: apply existing parent model', async () => {
    await openNthModelDetails(2);
    await window.locator('#model-parent').selectOption({ label: 'TestParent' });
    const filePath = await getNthModelPath(2);
    await expectSaved(filePath, 'parentModel', 'TestParent');
  });

  test('Single-edit: add new license and save', async () => {
    await openFirstModelDetails();
    await window.locator('#add-new-license-button').click();
    await expect(window.locator('#new-license-dialog')).toBeVisible();
    await window.locator('#new-license-name').fill('MIT');
    await window.locator('#add-license-button').click();
    await window.waitForTimeout(300);
    await expect(window.locator('#model-license')).toHaveValue('MIT');
    const filePath = await getFirstModelPath();
    await expectSaved(filePath, 'license', 'MIT');
  });

  test('Single-edit: apply existing license', async () => {
    await openNthModelDetails(2);
    await window.locator('#model-license').selectOption({ label: 'MIT' });
    const filePath = await getNthModelPath(2);
    await expectSaved(filePath, 'license', 'MIT');
  });

  test('Single-edit: set source and notes and save', async () => {
    await openFirstModelDetails();
    await window.locator('#model-source').fill('https://example.com/model');
    await window.locator('#open-notes-modal-button').click();
    await window.locator('#notes-richtext').fill('Test notes here');
    await window.locator('#save-notes-button').click();
    await saveCurrentModel(window);
    await window.waitForTimeout(500);
    const filePath = await getFirstModelPath();
    const model = await getModelData(filePath);
    expect(model.source).toBe('https://example.com/model');
    expect(model.notes).toBe('Test notes here');
  });

  test('Single-edit: set formatted notes with bold and italic and save', async () => {
    await openFirstModelDetails();
    await window.locator('#open-notes-modal-button').click();
    const rich = window.locator('#notes-richtext');
    // The modal focuses the editor ~100ms after opening and focus can re-render it from the
    // saved notes, so wait for focus before clearing, then clear the way a user would.
    await expect(rich).toBeFocused();
    await window.keyboard.press('ControlOrMeta+a');
    await window.keyboard.press('Delete');
    await expect(rich).toHaveText('');
    await window.keyboard.type('Hello World');
    for (let i = 0; i < 5; i++) {
      await window.keyboard.press('Shift+ArrowLeft');
    }
    await window.locator('.notes-toolbar [data-md="bold"]').click();
    await window.waitForTimeout(200);
    await window.locator('#save-notes-button').click();
    await window.waitForTimeout(400);

    const sidebarNotes = await window.locator('#model-notes').inputValue();
    expect(sidebarNotes).toBe('Hello **World**');
    const sidebarPreview = await window.locator('#model-notes-preview').evaluate((el) => el.innerHTML);
    expect(sidebarPreview).toContain('<strong>World</strong>');

    await saveCurrentModel(window);
    await window.waitForTimeout(500);


    const filePath = await getFirstModelPath();
    const model = await getModelData(filePath);
    expect(model.notes).toBe('Hello **World**');
  });


  test('Single-edit: add new tag via dialog and verify', async () => {
    await openFirstModelDetails();
    await window.locator('#add-tag-button').click();
    await expect(window.locator('#new-tag-dialog')).toBeVisible();
    await window.locator('#new-tag-name').fill('single-tag');
    await window.locator('#add-tag-submit').click();
    await window.waitForTimeout(500);
    await expect(window.locator('#model-tags')).toContainText('single-tag');
    const filePath = await getFirstModelPath();
    const model = await getModelData(filePath);
    const tagNames = (model.tags || []).map((t) => (typeof t === 'string' ? t : t.name));
    expect(tagNames).toContain('single-tag');
  });

  test('Single-edit: apply existing tag from dropdown', async () => {
    await openNthModelDetails(2);
    await window.locator('#tag-select').selectOption({ label: 'single-tag' });
    await window.waitForTimeout(400);
    await expect(window.locator('#model-tags')).toContainText('single-tag');
    const filePath = await getNthModelPath(2);
    const model = await getModelData(filePath);
    const tagNames = (model.tags || []).map((t) => (typeof t === 'string' ? t : t.name));
    expect(tagNames).toContain('single-tag');
  });

  test('Single-edit: apply existing tag from List dialog', async () => {
    await openFirstModelDetails();
    await window.locator('#add-tag-button').click();
    await expect(window.locator('#new-tag-dialog')).toBeVisible();
    await window.locator('#new-tag-name').fill('list-tag');
    await window.locator('#add-tag-submit').click();
    await window.waitForTimeout(400);
    await openNthModelDetails(2);
    await window.locator('.list-button[data-field="tag"][data-target="tag-select"]').click();
    await expect(window.locator('#searchable-list-dialog')).toBeVisible();
    await window.locator('#searchable-list-items li', { hasText: /^list-tag$/ }).click();
    await expect(window.locator('#searchable-list-dialog')).toBeHidden();
    await expect(window.locator('#model-tags')).toContainText('list-tag');
    const listFilePath = await getNthModelPath(2);
    const listModel = await getModelData(listFilePath);
    const listTagNames = (listModel.tags || []).map((t) => (typeof t === 'string' ? t : t.name));
    expect(listTagNames).toContain('list-tag');
  });

  test('Tag Manager: rename a tag updates tagged models', async () => {
    const filePath = await getFirstModelPath();
    await window.evaluate(async (path) => {
      const model = await window.electron.getModel(path);
      const tags = Array.isArray(model.tags) ? model.tags.slice() : [];
      if (!tags.includes('Mlitary')) tags.push('Mlitary');
      await window.electron.saveModel({ ...model, tags });
    }, filePath);

    await window.locator('#tag-button').click();
    await expect(window.locator('#tag-manager-dialog')).toBeVisible();
    const tagChip = window.locator('#tag-manager-list .tag[data-tag-name="Mlitary"]');
    await expect(tagChip).toBeVisible();
    await tagChip.locator('.tag-text').click();
    const input = tagChip.locator('input.tag-edit-input');
    await expect(input).toBeVisible();
    await input.fill('Military');
    await input.press('Enter');
    await expect(window.locator('#tag-manager-list .tag[data-tag-name="Military"]')).toBeVisible();
    await expect(window.locator('#tag-manager-list .tag[data-tag-name="Mlitary"]')).toHaveCount(0);

    const updated = await getModelData(filePath);
    const names = (updated.tags || []).map((t) => (typeof t === 'string' ? t : t.name));
    expect(names).toContain('Military');
    expect(names).not.toContain('Mlitary');

    await window.locator('#tag-manager-dialog button:has-text("Close")').click();
    await expect(window.locator('#tag-manager-dialog')).toBeHidden();
  });

  // --- Multi-edit: metadata and tags ---
  test('Multi-edit: enter mode and select all', async () => {
    await window.keyboard.press('Control+e');
    await window.waitForTimeout(400);
    await expect(window.locator('#multi-edit-panel')).not.toHaveClass(/hidden/);
    await window.locator('#select-all-button').click();
    await window.waitForTimeout(300);
    await expect(window.locator('.selected-count')).toContainText('2');
  });

  test('Multi-edit: set designer and save applies to all', async () => {
    await window.locator('#multi-designer').selectOption({ label: 'TestDesigner' });
    const path1 = await getNthModelPath(1);
    const path2 = await getNthModelPath(2);
    await expectSaved(path1, 'designer', 'TestDesigner');
    await expectSaved(path2, 'designer', 'TestDesigner');
  });

  test('Multi-edit: set source and save applies to all', async () => {
    await ensureMultiEditAllSelected();
    await window.locator('#multi-source').fill('https://multi.example.com');
    const path1 = await getNthModelPath(1);
    const path2 = await getNthModelPath(2);
    await expectSaved(path1, 'source', 'https://multi.example.com');
    await expectSaved(path2, 'source', 'https://multi.example.com');
  });

  test('Multi-edit: add existing tag to selection (auto-save)', async () => {
    await ensureMultiEditAllSelected();
    await window.locator('#multi-tag-select').selectOption({ label: 'single-tag' });
    const path1 = await getNthModelPath(1);
    const path2 = await getNthModelPath(2);
    await expect.poll(() => getTagNames(path1), { timeout: 10000 }).toContain('single-tag');
    await expect.poll(() => getTagNames(path2), { timeout: 10000 }).toContain('single-tag');
  });

  test('Multi-edit: add new tag via dialog and apply', async () => {
    await ensureMultiEditAllSelected();
    await window.locator('#multi-edit-panel').locator('.add-tag-button').click();
    await expect(window.locator('#new-tag-dialog')).toBeVisible();
    await window.locator('#new-tag-name').fill('multi-tag');
    await window.locator('#add-tag-submit').click();
    const path1 = await getNthModelPath(1);
    await expect.poll(() => getTagNames(path1), { timeout: 10000 }).toContain('multi-tag');
  });

  test('Multi-edit: Edit Tags opens Tag Manager', async () => {
    await ensureMultiEditAllSelected();
    await expect(window.locator('#multi-edit-tags-button')).toBeVisible();
    await window.locator('#multi-edit-tags-button').click();
    await expect(window.locator('#tag-manager-dialog')).toBeVisible();
    await expect(window.locator('#tag-manager-list .tag').first()).toBeVisible();
    await window.locator('#tag-manager-dialog button:has-text("Close")').click();
    await expect(window.locator('#tag-manager-dialog')).toBeHidden();
  });

  test('Multi-edit: set license and parent then save', async () => {
    await ensureMultiEditAllSelected();
    await window.locator('#multi-license').selectOption({ label: 'MIT' });
    await window.locator('#multi-parent').selectOption({ label: 'TestParent' });
    const path1 = await getNthModelPath(1);
    await expectSaved(path1, 'license', 'MIT');
    await expectSaved(path1, 'parentModel', 'TestParent');
  });

  test('Multi-edit: exit and confirm panel hidden', async () => {
    await window.locator('#exit-multi-edit-button').click();
    await window.waitForTimeout(300);
    await expect(window.locator('#multi-edit-panel')).toHaveClass(/hidden/);
  });
});

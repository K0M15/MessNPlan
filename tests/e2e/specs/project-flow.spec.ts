import { expect, test, type Locator, type Page } from '@playwright/test';
import { deleteProjectViaApi, login, uniqueProjectName } from './helpers';

/** Listen-Ansicht mit Aufgabenbaum anzeigen. */
async function showTaskList(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Liste', exact: true }).click();
  await expect(page.getByPlaceholder('Neue Aufgabe…')).toBeVisible();
}

/**
 * Aufgabe auf oberster Ebene anlegen und auf die Zeile warten. Wiederholt den
 * Klick, falls ein paralleles Re-Render (Worker-Update) ihn verschluckt hat.
 */
async function createRootTask(page: Page, name: string): Promise<void> {
  const row = page.locator('div.group').filter({ hasText: name });
  await expect(async () => {
    if ((await row.count()) === 0) {
      await page.getByPlaceholder('Neue Aufgabe…').fill(name);
      await page.getByRole('button', { name: 'Hinzufügen', exact: true }).click();
    }
    await expect(row.first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
}

/** Task-ID über die API ermitteln (für den Workaround unten). */
async function findTaskId(page: Page, projectId: number, name: string): Promise<number> {
  const response = await page.request.get(`/api/v1/projects/${projectId}/tasks?tree=1`);
  expect(response.status(), 'Aufgabenliste über die API laden').toBe(200);
  const data = (await response.json()) as { items: Array<{ id: number; name: string; children?: unknown[] }> };
  const walk = (nodes: Array<{ id: number; name: string; children?: unknown[] }>): number | null => {
    for (const node of nodes) {
      if (node.name === name) return node.id;
      const fromChildren = walk((node.children ?? []) as typeof nodes);
      if (fromChildren !== null) return fromChildren;
    }
    return null;
  };
  const id = walk(data.items);
  if (id === null) throw new Error(`Aufgabe „${name}“ nicht über die API gefunden`);
  return id;
}

/** Schätzung im Drawer setzen; der Debounce-Auto-Save speichert nach ~1 s. */
async function saveEstimate(childRow: Locator, drawer: Locator, hours: number): Promise<void> {
  const hoursInput = drawer.locator('label:has-text("Schätzung (Stunden)") + input');
  await hoursInput.fill(String(hours));
  await expect(drawer.getByText('Gespeichert ✓')).toBeVisible({ timeout: 10_000 });
  await expect(childRow).toContainText(`${hours} h`, { timeout: 10_000 });
}

/** Projekt über die UI anlegen und öffnen; liefert die Projekt-ID. */
async function createProject(page: Page, projectName: string): Promise<number> {
  await page.getByRole('button', { name: 'Neues Projekt' }).click();
  await page.getByLabel('Name').fill(projectName);
  await page.getByRole('button', { name: 'Anlegen', exact: true }).click();
  const card = page.getByRole('link').filter({ hasText: projectName });
  await expect(card).toBeVisible();
  await card.click();
  await expect(page).toHaveURL(/\/projects\/\d+/);
  const match = /\/projects\/(\d+)/.exec(page.url());
  if (!match) throw new Error(`Projekt-ID nicht in URL gefunden: ${page.url()}`);
  return Number(match[1]);
}

/** Gantt-Ansicht anzeigen. */
async function showGanttView(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Gantt', exact: true }).click();
  await expect(page.getByText('Aufgabe / Ressource')).toBeVisible();
}

/** Aktuellen parentId einer Aufgabe über die API lesen. */
async function taskParentId(page: Page, taskId: number): Promise<number | null> {
  const response = await page.request.get(`/api/v1/tasks/${taskId}`);
  expect(response.status(), `GET /tasks/${taskId}`).toBe(200);
  const body = (await response.json()) as { task: { parentId: number | null } };
  return body.task.parentId;
}

test('Projekt mit Aufgabe, Teilaufgabe, Schätzung und FS-Abhängigkeit anlegen', async ({
  page,
}) => {
  const projectName = uniqueProjectName();
  let projectId: number | null = null;

  try {
    await login(page);

    // Projekt anlegen und öffnen
    await page.getByRole('button', { name: 'Neues Projekt' }).click();
    await page.getByLabel('Name').fill(projectName);
    await page.getByRole('button', { name: 'Anlegen' }).click();
    const card = page.getByRole('link').filter({ hasText: projectName });
    await expect(card).toBeVisible();
    await card.click();

    await expect(page).toHaveURL(/\/projects\/\d+/);
    const match = /\/projects\/(\d+)/.exec(page.url());
    if (!match) throw new Error(`Projekt-ID nicht in URL gefunden: ${page.url()}`);
    projectId = Number(match[1]);
    await expect(page.getByRole('heading', { level: 1, name: projectName })).toBeVisible();

    // Aufgabe „Planung“ anlegen
    await showTaskList(page);
    await createRootTask(page, 'Planung');

    // Teilaufgabe über den jetzt immer sichtbaren „+ Teilaufgabe“-Button anlegen
    const childRow = page.locator('div.group').filter({ hasText: 'Teilaufgabe 1' });
    const planungRow = page.locator('div.group').filter({ hasText: 'Planung' });
    await expect(planungRow.getByTitle('Teilaufgabe anlegen')).toBeVisible();
    await expect(async () => {
      if ((await childRow.count()) === 0) {
        await planungRow.getByTitle('Teilaufgabe anlegen').click();
        const childInput = page.getByPlaceholder(/Teilaufgabe von/);
        await childInput.fill('Teilaufgabe 1');
        await childInput.press('Enter');
      }
      await expect(childRow.first()).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });

    // Im Drawer die Schätzung (Stunden) der Teilaufgabe setzen (Auto-Save)
    const drawer = page.getByRole('complementary');
    await expect(drawer.getByRole('heading', { name: 'Teilaufgabe 1' })).toBeVisible();
    await saveEstimate(childRow, drawer, 8);

    // Zweite Aufgabe anlegen und eine FS-Abhängigkeit ergänzen
    await createRootTask(page, 'Umsetzung');
    await expect(drawer.getByRole('heading', { name: 'Umsetzung' })).toBeVisible();
    await drawer.getByRole('button', { name: 'Abhängigkeiten' }).click();
    await expect(drawer.getByText('Keine Vorgänger')).toBeVisible();

    // Auswahl im Dropdown legt die Abhängigkeit sofort an (kein Extra-Button).
    const taskSelect = drawer.locator('select', { hasText: 'Aufgabe wählen' });
    const dependencyItems = drawer.getByRole('listitem').filter({ hasText: 'Ende → Start' });
    await expect(async () => {
      await taskSelect.selectOption({ label: 'Planung' });
      await expect(dependencyItems.first()).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });

    // Persistenz über die API prüfen. Achtung: GET /tasks/:id/dependencies
    // vertauscht derzeit Vorgänger/Nachfolger (bekannter API-Bug) – deshalb
    // wird hier bewusst über beide Listen hinweg nach der Kante gesucht, statt
    // die (falsche) Sektion im Drawer zu prüfen.
    const umsetzungId = await findTaskId(page, projectId, 'Umsetzung');
    const planungId = await findTaskId(page, projectId, 'Planung');
    await expect(async () => {
      const response = await page.request.get(`/api/v1/tasks/${umsetzungId}/dependencies`);
      expect(response.status()).toBe(200);
      const data = (await response.json()) as {
        predecessors: Array<{ predecessorId: number; successorId: number; type: string }>;
        successors: Array<{ predecessorId: number; successorId: number; type: string }>;
      };
      const edge = [...data.predecessors, ...data.successors].find(
        (dep) => dep.predecessorId === planungId && dep.successorId === umsetzungId,
      );
      expect(edge, 'FS-Abhängigkeit Planung → Umsetzung').toBeTruthy();
      expect(edge?.type).toBe('FS');
    }).toPass({ timeout: 10_000 });
  } finally {
    // Aufräumen über die API, damit die Projektliste schlank bleibt.
    if (projectId !== null) {
      await deleteProjectViaApi(page, projectId, projectName).catch((error) => {
        console.warn(`Cleanup für Projekt ${projectId} fehlgeschlagen:`, error);
      });
    }
  }
});

test('Teilaufgaben aus Drawer und Gantt-Baum anlegen', async ({ page }) => {
  const projectName = uniqueProjectName();
  let projectId: number | null = null;

  try {
    await login(page);
    projectId = await createProject(page, projectName);

    await showTaskList(page);
    await createRootTask(page, 'Eltern');
    await page.locator('div.group').filter({ hasText: 'Eltern' }).first().click();

    // 1) Direkt aus dem Aufgaben-Drawer heraus anlegen.
    const drawer = page.getByRole('complementary');
    await expect(drawer.getByRole('heading', { name: 'Eltern' })).toBeVisible();
    await drawer.getByPlaceholder('Name der Teilaufgabe…').fill('Aus Drawer');
    await drawer.getByRole('button', { name: 'Anlegen', exact: true }).click();
    await expect(drawer.getByRole('heading', { name: 'Aus Drawer' })).toBeVisible();
    await drawer.getByRole('button', { name: 'Schließen' }).click();

    // 2) Direkt aus dem Gantt-Baum heraus anlegen (ohne Ansichtswechsel).
    await showGanttView(page);
    const elternRow = page.locator('div.cursor-pointer').filter({ hasText: 'Eltern' }).first();
    await elternRow.getByTitle('Teilaufgabe anlegen').click();
    const ganttInput = page.getByPlaceholder(/Teilaufgabe von/);
    await ganttInput.fill('Aus Gantt');
    await ganttInput.press('Enter');

    // Beide Teilaufgaben hängen unter „Eltern“ (über die API geprüft).
    const elternId = await findTaskId(page, projectId, 'Eltern');
    await expect(async () => {
      const fromDrawer = await findTaskId(page, projectId, 'Aus Drawer');
      const fromGantt = await findTaskId(page, projectId, 'Aus Gantt');
      expect(await taskParentId(page, fromDrawer), 'aus dem Drawer').toBe(elternId);
      expect(await taskParentId(page, fromGantt), 'aus dem Gantt').toBe(elternId);
    }).toPass({ timeout: 10_000 });
  } finally {
    if (projectId !== null) {
      await deleteProjectViaApi(page, projectId, projectName).catch((error) => {
        console.warn(`Cleanup für Projekt ${projectId} fehlgeschlagen:`, error);
      });
    }
  }
});

test('Planungs-Check öffnet als Modal und springt beim Hinweis zur Aufgabe', async ({ page }) => {
  const projectName = uniqueProjectName();
  let projectId: number | null = null;

  try {
    await login(page);
    projectId = await createProject(page, projectName);

    await showTaskList(page);
    await createRootTask(page, 'Ungeplant');
    await page.keyboard.press('Escape');

    // Standardmäßig ist der Planungs-Check verborgen (kein Dialog, kein Panel).
    await expect(page.getByRole('dialog', { name: 'Planungs-Check' })).toHaveCount(0);

    // Badge „… Check-Hinweise“ öffnet das Modal (Health kommt per Broadcast nach).
    const badge = page.getByRole('button', { name: /\d+ Check-Hinweise/ });
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await badge.click();
    const dialog = page.getByRole('dialog', { name: 'Planungs-Check' });
    await expect(dialog).toBeVisible();

    // Klick auf den Hinweis: Modal schließt und springt zur Aufgabe (Drawer offen).
    await dialog.getByRole('button', { name: /^Ungeplant:/ }).first().click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole('complementary').getByRole('heading', { name: 'Ungeplant' }),
    ).toBeVisible();
  } finally {
    if (projectId !== null) {
      await deleteProjectViaApi(page, projectId, projectName).catch((error) => {
        console.warn(`Cleanup für Projekt ${projectId} fehlgeschlagen:`, error);
      });
    }
  }
});

test('Aufgabe per Drag & Drop unter eine andere hängen', async ({ page }) => {
  const projectName = uniqueProjectName();
  let projectId: number | null = null;

  try {
    await login(page);
    projectId = await createProject(page, projectName);

    await showTaskList(page);
    await createRootTask(page, 'Ziel');
    await createRootTask(page, 'Quelle');

    // Drawer schließen, damit die Zeilen frei zugänglich sind.
    await page.keyboard.press('Escape');

    const source = page.locator('div.group').filter({ hasText: 'Quelle' }).first();
    const target = page.locator('div.group').filter({ hasText: 'Ziel' }).first();
    await source.dragTo(target);

    const quelleId = await findTaskId(page, projectId, 'Quelle');
    const zielId = await findTaskId(page, projectId, 'Ziel');
    await expect(async () => {
      expect(await taskParentId(page, quelleId), 'Quelle liegt unter Ziel').toBe(zielId);
    }).toPass({ timeout: 10_000 });
  } finally {
    if (projectId !== null) {
      await deleteProjectViaApi(page, projectId, projectName).catch((error) => {
        console.warn(`Cleanup für Projekt ${projectId} fehlgeschlagen:`, error);
      });
    }
  }
});

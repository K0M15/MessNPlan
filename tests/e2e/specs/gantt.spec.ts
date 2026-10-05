import { expect, test } from '@playwright/test';
import { login, openFirstProject } from './helpers';

test('Gantt-Zoom, Planungs-Check und Aufgabenliste im Demo-Projekt', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await login(page);
  await openFirstProject(page);

  // Canvas-Gantt ist sichtbar (Kopfzeile + Body).
  await expect(page.locator('canvas').first()).toBeVisible();

  // Alle Zoom-Stufen anklicken – ohne Fehler und weiterhin mit Canvas.
  for (const label of ['Stunden', 'Tage', 'Wochen', 'Monate', 'Alles']) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator('canvas').first()).toBeVisible();
  }

  // Health-Panel „Planungs-Check“ ist standardmäßig eingeblendet.
  await expect(page.getByRole('heading', { name: 'Planungs-Check' })).toBeVisible();

  // Listen-Tab zeigt den Aufgabenbaum mit Zeilen.
  await page.getByRole('button', { name: 'Liste', exact: true }).click();
  await expect(page.getByPlaceholder('Neue Aufgabe…')).toBeVisible();
  await expect(page.locator('div.group').first()).toBeVisible();

  expect(pageErrors).toEqual([]);
});

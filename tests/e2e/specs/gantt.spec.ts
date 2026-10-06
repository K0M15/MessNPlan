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

  // Planungs-Check ist standardmäßig verborgen und öffnet sich per Badge als Modal.
  const checkBadge = page.getByRole('button', { name: /Check-Hinweise|Planung vollständig/ });
  await expect(checkBadge).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Planungs-Check' })).toHaveCount(0);
  await checkBadge.click();
  const healthDialog = page.getByRole('dialog', { name: 'Planungs-Check' });
  await expect(healthDialog.getByRole('heading', { name: 'Planungs-Check' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(healthDialog).toBeHidden();

  // Listen-Tab zeigt den Aufgabenbaum mit Zeilen.
  await page.getByRole('button', { name: 'Liste', exact: true }).click();
  await expect(page.getByPlaceholder('Neue Aufgabe…')).toBeVisible();
  await expect(page.locator('div.group').first()).toBeVisible();

  expect(pageErrors).toEqual([]);
});

import { expect, test } from '@playwright/test';
import { login, openFirstProject } from './helpers';

const HOLIDAY_NAME = 'E2E-Test';
const HOLIDAY_DATE = '2031-06-15';

test('Projekt-Einstellungen speichern und Feiertag anlegen/löschen', async ({ page }) => {
  await login(page);
  const projectId = await openFirstProject(page);

  /** Feiertag-Reste früherer (abgebrochener) Läufe über die API entfernen. */
  const removeLeftoverHolidays = async (): Promise<void> => {
    const response = await page.request.get(`/api/v1/projects/${projectId}/holidays`);
    if (!response.ok()) return;
    const data = (await response.json()) as { items: Array<{ id: number; name: string }> };
    for (const holiday of data.items.filter((h) => h.name === HOLIDAY_NAME)) {
      await page.request.delete(`/api/v1/projects/${projectId}/holidays/${holiday.id}`);
    }
  };
  await removeLeftoverHolidays();

  // Einstellungs-Modal öffnen und stabil darauf scopen
  await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  const settingsModal = page
    .locator('div.fixed.inset-0')
    .filter({ has: page.getByRole('heading', { name: 'Projekt-Einstellungen' }) });
  await expect(settingsModal).toBeVisible();

  // Zeitzone (Allgemein) vorhanden …
  const timezone = settingsModal.locator('#settings-timezone');
  await expect(timezone).toBeVisible();
  const timezoneValue = await timezone.inputValue();
  expect(timezoneValue.length, 'Zeitzone ist gesetzt').toBeGreaterThan(0);

  // … Arbeitszeit (Kalender-Tab) vorhanden, dann unverändert speichern.
  await settingsModal.getByRole('button', { name: 'Arbeitszeiten & Feiertage' }).click();
  const workdayStart = settingsModal.locator('#settings-workday-start');
  const workdayEnd = settingsModal.locator('#settings-workday-end');
  await expect(workdayStart).toBeVisible();
  const startValue = await workdayStart.inputValue();
  const endValue = await workdayEnd.inputValue();
  expect(startValue).toMatch(/^\d{2}:\d{2}$/);
  expect(endValue).toMatch(/^\d{2}:\d{2}$/);

  await settingsModal.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(page.getByText('Projekteinstellungen gespeichert')).toBeVisible();
  await expect(workdayStart).toHaveValue(startValue);
  await expect(workdayEnd).toHaveValue(endValue);

  // Feiertag anlegen
  const emptyHint = settingsModal.getByText('Noch keine Feiertage hinterlegt.');
  const holidayItem = settingsModal.locator('li').filter({ hasText: HOLIDAY_NAME });
  await expect(emptyHint.or(settingsModal.locator('li'))).toBeVisible();
  const startedEmpty = await emptyHint.isVisible();

  const holidayDate = settingsModal
    .getByPlaceholder('Bezeichnung')
    .locator('xpath=preceding-sibling::input[@type="date"]');
  await holidayDate.fill(HOLIDAY_DATE);
  await settingsModal.getByPlaceholder('Bezeichnung').fill(HOLIDAY_NAME);
  await settingsModal.getByRole('button', { name: 'Anlegen', exact: true }).click();

  await expect(page.getByText('Feiertag angelegt')).toBeVisible();
  await expect(holidayItem).toBeVisible();
  await expect(holidayItem).toContainText('15.06.31'); // Anzeigeformat dd.MM.yy

  // Feiertag wieder löschen (Bestätigungsdialog akzeptieren)
  page.once('dialog', (dialog) => void dialog.accept());
  await holidayItem.getByRole('button', { name: 'löschen' }).click();

  await expect(page.getByText('Feiertag gelöscht')).toBeVisible();
  await expect(holidayItem).toBeHidden();
  if (startedEmpty) {
    await expect(emptyHint).toBeVisible();
  }
});

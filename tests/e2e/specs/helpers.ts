import { expect, type Page } from '@playwright/test';

/** Zugangsdaten des Seed-Admins (überschreibbar per Env). */
export const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
export const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'admin1234!';

/**
 * Meldet sich per UI an und wartet auf die Projektübersicht.
 * Jeder Test loggt sich selbst ein: Das Access-Cookie der API läuft nach 15
 * Minuten ab und der Refresh rotiert serverseitig (Reuse-Erkennung), ein
 * geteilter Storage-State wäre daher nicht stabil.
 */
export async function login(
  page: Page,
  email: string = ADMIN_EMAIL,
  password: string = ADMIN_PASSWORD,
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('E-Mail').fill(email);
  await page.getByLabel('Passwort').fill(password);
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Projekte' })).toBeVisible({ timeout: 20_000 });
}

/** Meldet die aktive Session ab und erwartet die Login-Seite. */
export async function logout(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Abmelden' }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByText('Bitte anmelden')).toBeVisible();
}

/** Öffnet das erste Projekt der Liste (Demo-Projekt aus dem Seed). */
export async function openFirstProject(page: Page): Promise<number> {
  const card = page.locator('main ul li a').first();
  await expect(card).toBeVisible();
  await card.click();
  await expect(page).toHaveURL(/\/projects\/\d+/);
  await expect(page.getByRole('link', { name: '← Alle Projekte' })).toBeVisible();
  const match = /\/projects\/(\d+)/.exec(page.url());
  if (!match) throw new Error(`Projekt-ID nicht in URL gefunden: ${page.url()}`);
  return Number(match[1]);
}

/** Eindeutiger Projektname für Testdaten (Räume dank Cleanup). */
export function uniqueProjectName(prefix = 'E2E'): string {
  return `${prefix} ${Date.now()}`;
}

/** Projekt über die API löschen (Namensbestätigung) – teilt Cookies/BaseURL mit dem Browser-Kontext. */
export async function deleteProjectViaApi(
  page: Page,
  projectId: number,
  name: string,
): Promise<void> {
  const response = await page.request.delete(`/api/v1/projects/${projectId}`, {
    data: { name },
  });
  expect(response.status(), `Projekt ${projectId} über die API löschen`).toBe(204);
}

import { expect, test } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, login, logout } from './helpers';

test.describe('Authentifizierung', () => {
  test('Login mit falschen Zugangsdaten zeigt eine Fehlermeldung', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('E-Mail').fill('falsch@example.com');
    await page.getByLabel('Passwort').fill('voellig-falsch');
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click();

    await expect(page.getByText('E-Mail oder Passwort ist falsch')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('Login mit gültigen Zugangsdaten zeigt die Projekte-Seite', async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    await expect(page.getByRole('heading', { name: 'Projekte' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Abmelden' })).toBeVisible();
  });

  test('Logout führt zurück zum Login', async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await logout(page);

    await expect(page.getByRole('button', { name: 'Anmelden', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'ProjectPlaner' })).toBeVisible();
  });
});

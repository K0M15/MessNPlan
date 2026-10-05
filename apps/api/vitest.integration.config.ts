import { defineConfig } from 'vitest/config';

/**
 * Integrationstests gegen eine echte MySQL aus Testcontainers.
 *
 * - `globalSetup` startet den Container und wendet die Migrationen an (einmal pro Suite).
 * - `setupFiles` injizieren den Container-DSN in `process.env`, BEVOR die Testdatei
 *   `src/config.ts` importiert (Details siehe src/__tests__/integration/setupEnv.ts).
 * - Dateien laufen sequenziell, da sie sich eine Datenbank teilen.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    globalSetup: ['src/__tests__/integration/globalSetup.ts'],
    setupFiles: ['src/__tests__/integration/setupEnv.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});

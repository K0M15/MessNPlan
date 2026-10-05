import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Integrationstests (echte MySQL/Testcontainers) laufen separat über
    // `npm run test:integration` mit vitest.integration.config.ts.
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
    testTimeout: 15_000,
  },
});

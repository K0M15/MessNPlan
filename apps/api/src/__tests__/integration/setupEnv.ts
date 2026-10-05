/**
 * Mechanik der Test-Env (wichtig für die Reihenfolge):
 *
 * 1. `globalSetup.ts` startet den MySQL-Container und stellt die DSN über
 *    `provide('databaseUrl', …)` bereit.
 * 2. Diese Datei ist als `setupFiles` konfiguriert und wird pro Testdatei
 *    ausgeführt, BEVOR Vitest die eigentliche Testdatei importiert. Hier wird
 *    die DSN per `inject` gelesen und in `process.env` geschrieben.
 * 3. Erst danach importiert die Testdatei `src/config.ts`. `dotenv` in
 *    config.ts überschreibt bereits gesetzte Variablen nicht, der Container-DSN
 *    gewinnt also gegenüber der lokalen `.env`.
 *
 * `LOG_LEVEL` muss ein gültiger Enum-Wert von config.ts sein; im Testmodus ist
 * der Logger ohnehin stumm (siehe src/logger.ts).
 */
import { inject } from 'vitest';

declare module 'vitest' {
  interface ProvidedContext {
    databaseUrl: string;
  }
}

const databaseUrl = inject('databaseUrl');
if (!databaseUrl) {
  throw new Error('Provided context "databaseUrl" fehlt – globalSetup nicht gelaufen?');
}

process.env.DATABASE_URL = databaseUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'integration-test-jwt-secret-0123456789abcdef';
process.env.COOKIE_SECURE = 'false';
process.env.APP_ORIGIN = 'http://localhost:5173';
process.env.LOG_LEVEL = 'error';

// Selbsttest der Mechanik: config.ts MUSS den Container-DSN sehen. Falls dotenv
// oder eine frühere Modul-Evaluierung doch übersteuert, scheitert die Suite
// hier sofort statt versehentlich gegen die Dev-DB zu laufen.
const { config } = await import('../../config.js');
if (config.DB_HOST !== undefined || config.DATABASE_URL !== databaseUrl) {
  const masked = (config.DATABASE_URL ?? '(nicht gesetzt)').replace(/:[^:@/]+@/, ':***@');
  throw new Error(`config.DB_* zeigt nicht auf den Testcontainer (${masked})`);
}

#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { createTaskApi } from './api/factory.js';
import { InternalSshVerifier } from './http/verify.js';
import { SERVER_NAME, SERVER_VERSION } from './server.js';
import { runStdio } from './transports/stdio.js';
import { startHttpServer } from './transports/http.js';

const HELP = `projectplaner-mcp ${SERVER_VERSION} – MCP-Server für ProjectPlaner

Verwendung:
  projectplaner-mcp [--http] [--port <port>] [--host <host>]

Transporte:
  (ohne Argumente)   stdio – für Claude Desktop, IDEs und andere MCP-Hosts
  --http             Streamable HTTP unter /mcp (SSH-signiert geschützt)
    --port <port>    HTTP-Port (Standard: PP_MCP_PORT, sonst 3900)
    --host <host>    Bind-Adresse (Standard: PP_MCP_HOST, sonst 0.0.0.0)

Konfiguration (Umgebungsvariablen):
  PP_API_URL              Basis-URL der API (Standard http://localhost:3000)
  PP_EMAIL / PP_PASSWORD  Service-Login (REST-Session, voller Zugriff)
  PP_KEY_ID / PP_PRIVATE_KEY_PATH / PP_KEY_TYPE
                          SSH-signierte externe API (nur Anlegen)
  PP_PROJECT_ID           optionale Projektbindung des SSH-Schlüssels
  PP_INTERNAL_URL         interner Verify-Endpunkt (Standard = PP_API_URL)
  PP_INTERNAL_TOKEN       Token für /internal/* (Standard: JWT_SECRET)
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      http: { type: 'boolean', default: false },
      port: { type: 'string' },
      host: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  const config = loadConfig();
  const api = createTaskApi(config);

  if (!values.http) {
    await runStdio(api);
    return;
  }

  const port = values.port === undefined ? config.port : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Ungültiger Port: ${values.port}`);
  }
  const host = values.host ?? config.host;
  if (config.internalToken === undefined || config.internalToken === '') {
    throw new Error(
      'HTTP-Transport erfordert PP_INTERNAL_TOKEN (oder JWT_SECRET) für /internal/verify-ssh',
    );
  }

  const verifier = new InternalSshVerifier({
    internalUrl: config.internalUrl ?? config.apiUrl,
    token: config.internalToken,
  });
  const running = await startHttpServer({ host, port, api, verifier });
  console.error(
    `[${SERVER_NAME}] Streamable HTTP lauscht auf http://${host}:${running.port}/mcp (SSH-signiert)`,
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[${SERVER_NAME}] ${signal} empfangen – beende Server …`);
    void running.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error(
    `[${SERVER_NAME}] Start fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});

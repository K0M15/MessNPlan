import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = fileURLToPath(new URL('../index.ts', import.meta.url));

/**
 * Smoke-Test: startet den echten stdio-Server (dist-frei über tsx) als
 * Subprozess und spricht über den SDK-Client mit ihm.
 */
describe('stdio-Transport', () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', entry],
    env: {
      // Zugangsdaten nötig für die Start-Validierung; es werden keine
      // Netzwerkaufrufe ausgeführt, solange nur tools/list läuft.
      PP_EMAIL: 'bot@example.com',
      PP_PASSWORD: 'smoke-test-passwort',
      PP_API_URL: 'http://127.0.0.1:9',
    },
  });
  const client = new Client({ name: 'stdio-smoke', version: '1.0.0' });

  afterAll(async () => {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  });

  it('liefert über tools/list alle neun Tools', async () => {
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(9);
    expect(tools.map((tool) => tool.name)).toContain('create_task');
    expect(tools.map((tool) => tool.name)).toContain('get_gantt_summary');
  });
});

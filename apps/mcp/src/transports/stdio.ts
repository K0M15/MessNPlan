import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from '../server.js';
import type { TaskApi } from '../api/types.js';

/** Startet den Server über stdio (Claude Desktop, IDEs). */
export async function runStdio(api: TaskApi): Promise<void> {
  const server = createMcpServer(api);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

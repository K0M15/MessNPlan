import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools.js';
import type { TaskApi } from './api/types.js';

export const SERVER_NAME = 'projectplaner-mcp';
export const SERVER_VERSION = '0.1.0';

/** Erstellt einen MCP-Server mit allen ProjectPlaner-Tools. */
export function createMcpServer(api: TaskApi): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'ProjectPlaner-MCP: Projekte und Aufgaben lesen, Aufgaben anlegen, Abhängigkeiten und ' +
        'Ressourcen-Zuteilungen pflegen, Planung neu berechnen und Health-/Gantt-Auswertungen ' +
        'abrufen. IDs immer aus list_projects/list_tasks beziehen.',
    },
  );
  registerTools(server, api);
  return server;
}

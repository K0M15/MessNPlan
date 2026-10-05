import type { McpConfig } from '../config.js';
import { RestSessionApi } from './rest.js';
import { SshSignedApi } from './ssh.js';
import type { TaskApi } from './types.js';

export interface CreateTaskApiDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Baut den Zugriffsweg passend zur validierten Konfiguration. */
export function createTaskApi(config: McpConfig, deps: CreateTaskApiDeps = {}): TaskApi {
  if (config.authMode === 'rest') {
    if (config.email === undefined || config.password === undefined) {
      throw new Error('authMode "rest" erfordert PP_EMAIL und PP_PASSWORD');
    }
    return new RestSessionApi({
      baseUrl: config.apiUrl,
      email: config.email,
      password: config.password,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
  }

  if (config.keyId === undefined || config.privateKeyPath === undefined) {
    throw new Error('authMode "ssh" erfordert PP_KEY_ID und PP_PRIVATE_KEY_PATH');
  }
  return new SshSignedApi({
    baseUrl: config.apiUrl,
    keyId: config.keyId,
    privateKeyPath: config.privateKeyPath,
    ...(config.keyType ? { keyType: config.keyType } : {}),
    ...(config.projectId !== undefined ? { projectId: config.projectId } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
}

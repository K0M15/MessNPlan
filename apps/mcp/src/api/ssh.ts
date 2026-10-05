import { createHash, createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { joinUrl, parseResponse } from './util.js';
import {
  ApiError,
  UnsupportedOperationError,
  type AssignmentDto,
  type CreateAssignmentPayload,
  type CreateDependencyPayload,
  type CreateTaskPayload,
  type DependencyDto,
  type GanttPayload,
  type GanttQuery,
  type HealthPayload,
  type ProjectDto,
  type ResourceDto,
  type ScheduleComputeResult,
  type TaskApi,
  type TaskDto,
} from './types.js';
import type { SshKeyType } from '../config.js';

// ---------------------------------------------------------------------------
// Signatur (Schema siehe docs/API-external.md)
// ---------------------------------------------------------------------------

export interface SignSshRequestOptions {
  keyId: number;
  privateKey: KeyObject;
  keyType: SshKeyType;
  /** HTTP-Methode in beliebiger Schreibweise (wird großgeschrieben). */
  method: string;
  /** Pfad inkl. Query, exakt wie vom Server gesehen (z.B. /api/v1/external/projects/1/tasks). */
  url: string;
  /** Roher Body (bei leerem Body ""). */
  body: string;
  /** Unix-Sekunden. */
  timestamp: number;
}

export function buildCanonicalString(options: {
  keyId: number | string;
  timestamp: number | string;
  method: string;
  url: string;
  bodyHashHex: string;
}): string {
  return [
    String(options.keyId),
    String(options.timestamp),
    options.method.toUpperCase(),
    options.url,
    options.bodyHashHex,
  ].join('\n');
}

/** Erzeugt die drei SSH-Header für einen externen API-Request. */
export function signSshRequest(options: SignSshRequestOptions): Record<string, string> {
  const canonical = buildCanonicalString({
    keyId: options.keyId,
    timestamp: options.timestamp,
    method: options.method,
    url: options.url,
    bodyHashHex: createHash('sha256').update(options.body, 'utf8').digest('hex'),
  });
  const data = Buffer.from(canonical, 'utf8');
  // Ed25519 signiert die Nachricht direkt; RSA nutzt PKCS#1 v1.5 mit SHA-256.
  const signature =
    options.keyType === 'ssh-rsa'
      ? sign('sha256', data, options.privateKey)
      : sign(null, data, options.privateKey);

  return {
    'x-pp-key-id': String(options.keyId),
    'x-pp-timestamp': String(options.timestamp),
    'x-pp-signature': signature.toString('base64'),
  };
}

// ---------------------------------------------------------------------------
// SSH-signierter API-Client
// ---------------------------------------------------------------------------

export interface SshSignedApiOptions {
  baseUrl: string;
  keyId: number;
  /** PKCS#8-PEM (z. B. via `ssh-keygen -p -m PKCS8`). */
  privateKeyPath: string;
  keyType?: SshKeyType;
  /** Optional: Frühprüfung gegen die Projektbindung des Schlüssels. */
  projectId?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function inferKeyType(privateKey: KeyObject): SshKeyType {
  if (privateKey.asymmetricKeyType === 'rsa') return 'ssh-rsa';
  if (privateKey.asymmetricKeyType === 'ed25519') return 'ssh-ed25519';
  throw new Error(
    `Nicht unterstützter Schlüsseltyp "${privateKey.asymmetricKeyType ?? 'unbekannt'}" ` +
      '(erlaubt: ssh-ed25519, ssh-rsa)',
  );
}

/**
 * Client der SSH-signierten externen API (`/api/v1/external`).
 * Die externe API ist auf Anlegen beschränkt – lesende Operationen werden mit
 * `UnsupportedOperationError` abgelehnt.
 */
export class SshSignedApi implements TaskApi {
  readonly kind = 'ssh' as const;

  private readonly baseUrl: string;
  private readonly keyId: number;
  private readonly privateKey: KeyObject;
  private readonly keyType: SshKeyType;
  private readonly boundProjectId: number | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(options: SshSignedApiOptions) {
    this.baseUrl = options.baseUrl;
    this.keyId = options.keyId;
    this.privateKey = createPrivateKey(readFileSync(options.privateKeyPath));
    const inferred = inferKeyType(this.privateKey);
    if (options.keyType && options.keyType !== inferred) {
      throw new Error(
        `PP_KEY_TYPE "${options.keyType}" passt nicht zum geladenen Schlüssel (${inferred})`,
      );
    }
    this.keyType = options.keyType ?? inferred;
    this.boundProjectId = options.projectId;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  // ---- Mutationen (externe API) -----------------------------------------

  async createTask(projectId: number, input: CreateTaskPayload): Promise<{ task: TaskDto }> {
    this.assertProject(projectId);
    return this.external('POST', `/api/v1/external/projects/${projectId}/tasks`, input);
  }

  async addDependency(
    projectId: number,
    input: CreateDependencyPayload,
  ): Promise<{ dependency: DependencyDto }> {
    this.assertProject(projectId);
    return this.external('POST', `/api/v1/external/projects/${projectId}/dependencies`, input);
  }

  async assignResource(
    projectId: number,
    taskId: number,
    input: CreateAssignmentPayload,
  ): Promise<{ assignment: AssignmentDto }> {
    this.assertProject(projectId);
    return this.external(
      'POST',
      `/api/v1/external/projects/${projectId}/tasks/${taskId}/assignments`,
      input,
    );
  }

  // ---- Lesende Operationen ----------------------------------------------

  listProjects(): Promise<ProjectDto[]> {
    throw new UnsupportedOperationError('list_projects');
  }

  getProject(_projectId: number): Promise<{ project: ProjectDto; members: unknown[] }> {
    throw new UnsupportedOperationError('get_project');
  }

  listTasks(_projectId: number): Promise<TaskDto[]> {
    throw new UnsupportedOperationError('list_tasks');
  }

  listResources(_projectId: number): Promise<ResourceDto[]> {
    throw new UnsupportedOperationError('list_resources');
  }

  computeSchedule(_projectId: number): Promise<{ result: ScheduleComputeResult }> {
    throw new UnsupportedOperationError('compute_schedule');
  }

  getHealth(_projectId: number): Promise<HealthPayload> {
    throw new UnsupportedOperationError('get_health');
  }

  getGantt(_projectId: number, _query?: GanttQuery): Promise<GanttPayload> {
    throw new UnsupportedOperationError('get_gantt_summary');
  }

  // ---- Intern ------------------------------------------------------------

  private assertProject(projectId: number): void {
    if (this.boundProjectId !== undefined && this.boundProjectId !== projectId) {
      throw new ApiError(403, {
        detail:
          `SSH-Schlüssel ist an Projekt ${this.boundProjectId} gebunden ` +
          `(PP_PROJECT_ID); Anfrage für Projekt ${projectId} abgelehnt`,
      });
    }
  }

  private async external<T>(method: 'POST', path: string, body: unknown): Promise<T> {
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const fullUrl = joinUrl(this.baseUrl, path);
    // Kanonischer String nutzt den Pfad exakt wie der Server ihn sieht.
    const parsed = new URL(fullUrl);
    const headers = new Headers({
      accept: 'application/json',
      ...(bodyString ? { 'content-type': 'application/json' } : {}),
      ...signSshRequest({
        keyId: this.keyId,
        privateKey: this.privateKey,
        keyType: this.keyType,
        method,
        url: parsed.pathname + parsed.search,
        body: bodyString,
        timestamp: Math.floor(this.now() / 1000),
      }),
    });

    const response = await this.fetchImpl(fullUrl, {
      method,
      headers,
      body: bodyString || undefined,
    });
    return parseResponse<T>(response);
  }
}

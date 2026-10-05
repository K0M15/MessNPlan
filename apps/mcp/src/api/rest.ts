import { parseResponse, joinUrl } from './util.js';
import {
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

export const ACCESS_COOKIE = 'pp_at';
export const REFRESH_COOKIE = 'pp_rt';
const REFRESH_PATH = '/api/v1/auth';

export interface RestSessionApiOptions {
  baseUrl: string;
  email: string;
  password: string;
  fetchImpl?: typeof fetch;
}

/**
 * REST-Zugriff mit Service-Login. Verwaltet `pp_at`/`pp_rt` als manuellen
 * Cookie-Jar (kein Browser): Bei 401 wird zuerst der Refresh-Token rotiert
 * (single-flight), danach einmalig erneut versucht; schlägt der Refresh fehl,
 * erfolgt ein neuer Login mit den Service-Zugangsdaten.
 */
export class RestSessionApi implements TaskApi {
  readonly kind = 'rest' as const;

  private readonly baseUrl: string;
  private readonly email: string;
  private readonly password: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cookies = new Map<string, string>();
  private refreshInFlight: Promise<boolean> | null = null;
  private loginInFlight: Promise<void> | null = null;

  constructor(options: RestSessionApiOptions) {
    this.baseUrl = options.baseUrl;
    this.email = options.email;
    this.password = options.password;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  // ---- Projekte ----------------------------------------------------------

  async listProjects(): Promise<ProjectDto[]> {
    const data = await this.request<{ items: ProjectDto[] }>('GET', '/api/v1/projects');
    return data.items;
  }

  async getProject(projectId: number): Promise<{ project: ProjectDto; members: unknown[] }> {
    return this.request('GET', `/api/v1/projects/${projectId}`);
  }

  async listTasks(projectId: number): Promise<TaskDto[]> {
    const data = await this.request<{ items: TaskDto[] }>(
      'GET',
      `/api/v1/projects/${projectId}/tasks`,
    );
    return data.items;
  }

  async listResources(projectId: number): Promise<ResourceDto[]> {
    const data = await this.request<{ items: ResourceDto[] }>(
      'GET',
      `/api/v1/projects/${projectId}/resources`,
    );
    return data.items;
  }

  // ---- Mutationen --------------------------------------------------------

  async createTask(projectId: number, input: CreateTaskPayload): Promise<{ task: TaskDto }> {
    return this.request('POST', `/api/v1/projects/${projectId}/tasks`, input);
  }

  async addDependency(
    _projectId: number,
    input: CreateDependencyPayload,
  ): Promise<{ dependency: DependencyDto }> {
    // Interner Endpunkt: die referenzierte Aufgabe steckt im Pfad (Vorgänger).
    return this.request('POST', `/api/v1/tasks/${input.predecessorId}/dependencies`, input);
  }

  async assignResource(
    _projectId: number,
    taskId: number,
    input: CreateAssignmentPayload,
  ): Promise<{ assignment: AssignmentDto }> {
    return this.request('POST', `/api/v1/tasks/${taskId}/assignments`, input);
  }

  async computeSchedule(projectId: number): Promise<{ result: ScheduleComputeResult }> {
    return this.request('POST', `/api/v1/projects/${projectId}/schedule`, {});
  }

  async getHealth(projectId: number): Promise<HealthPayload> {
    return this.request('GET', `/api/v1/projects/${projectId}/health`);
  }

  async getGantt(projectId: number, query: GanttQuery = {}): Promise<GanttPayload> {
    const params = new URLSearchParams();
    if (query.from !== undefined) params.set('from', query.from);
    if (query.to !== undefined) params.set('to', query.to);
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    return this.request('GET', `/api/v1/projects/${projectId}/gantt${suffix}`);
  }

  // ---- Session & HTTP ----------------------------------------------------

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    // Kalter Start: ohne jegliche Cookies zuerst einloggen (spart den 401-Umweg).
    if (!this.cookies.has(ACCESS_COOKIE) && !this.cookies.has(REFRESH_COOKIE)) {
      await this.login();
    }

    let response = await this.send(method, path, body);

    if (response.status === 401 && !path.startsWith(REFRESH_PATH)) {
      // Body der 401-Antwort verwerfen, bevor erneut gesendet wird.
      await response.text().catch(() => undefined);
      await this.reauthenticate();
      response = await this.send(method, path, body);
    }

    return parseResponse<T>(response);
  }

  /** Refresh mit Rotation; bei Fehlen/Ablauf des Refresh-Cookies neuer Login. */
  private async reauthenticate(): Promise<void> {
    if (this.cookies.has(REFRESH_COOKIE) && (await this.tryRefresh())) return;
    await this.login();
  }

  private tryRefresh(): Promise<boolean> {
    this.refreshInFlight ??= (async () => {
      try {
        const response = await this.send('POST', '/api/v1/auth/refresh');
        await response.text().catch(() => undefined);
        return response.ok;
      } catch {
        return false;
      }
    })().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private login(): Promise<void> {
    this.loginInFlight ??= (async () => {
      const response = await this.send('POST', '/api/v1/auth/login', {
        email: this.email,
        password: this.password,
      });
      // Wirft bei falschen Zugangsdaten einen ApiError (RFC 7807).
      await parseResponse<unknown>(response);
    })().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  private async send(method: string, path: string, body?: unknown): Promise<Response> {
    const headers = new Headers();
    headers.set('accept', 'application/json');
    if (body !== undefined) headers.set('content-type', 'application/json');
    const cookie = this.cookieHeader(path);
    if (cookie) headers.set('cookie', cookie);

    const response = await this.fetchImpl(joinUrl(this.baseUrl, path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.storeCookies(response);
    return response;
  }

  private cookieHeader(path: string): string {
    const parts: string[] = [];
    const access = this.cookies.get(ACCESS_COOKIE);
    if (access) parts.push(`${ACCESS_COOKIE}=${access}`);
    // Der Refresh-Pfad ist auf /api/v1/auth beschränkt (siehe API-Cookie-Pfad).
    if (path.startsWith(REFRESH_PATH)) {
      const refresh = this.cookies.get(REFRESH_COOKIE);
      if (refresh) parts.push(`${REFRESH_COOKIE}=${refresh}`);
    }
    return parts.join('; ');
  }

  private storeCookies(response: Response): void {
    const setCookies = response.headers.getSetCookie?.() ?? [];
    for (const raw of setCookies) {
      const [pair = ''] = raw.split(';');
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}

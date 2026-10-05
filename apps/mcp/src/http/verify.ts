/**
 * Client für den internen Verify-Endpunkt der API
 * (`POST /internal/verify-ssh`, Token = JWT_SECRET wie `/internal/broadcast`).
 *
 * Der MCP-Server dupliziert die Signaturprüfung NICHT: Er schickt Header und
 * rohen Body des eingehenden MCP-Requests an die API, die Key-Lookup,
 * Ablauf-/Replay-Prüfung und Signaturverifikation übernimmt.
 */
export interface SshVerifyInput {
  keyId: string;
  timestamp: string;
  signature: string;
  method: string;
  /** Pfad inkl. Query, exakt wie vom MCP-Client signiert (z. B. /mcp). */
  url: string;
  /** Roher Request-Body (leer bei GET/DELETE). */
  rawBody: Buffer;
}

export interface SshVerifyResult {
  valid: boolean;
  projectId?: number;
  keyName?: string;
}

export interface SshVerifier {
  verify(input: SshVerifyInput): Promise<SshVerifyResult>;
}

export interface InternalSshVerifierOptions {
  internalUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class InternalSshVerifier implements SshVerifier {
  private readonly internalUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: InternalSshVerifierOptions) {
    this.internalUrl = options.internalUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async verify(input: SshVerifyInput): Promise<SshVerifyResult> {
    const response = await this.fetchImpl(`${this.internalUrl}/internal/verify-ssh`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-token': this.token,
      },
      body: JSON.stringify({
        keyId: input.keyId,
        timestamp: input.timestamp,
        signature: input.signature,
        method: input.method,
        url: input.url,
        rawBody: input.rawBody.toString('base64'),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (response.status === 200) {
      const body = (await response.json()) as {
        valid?: unknown;
        projectId?: unknown;
        keyName?: unknown;
      };
      return {
        valid: body.valid === true,
        ...(typeof body.projectId === 'number' ? { projectId: body.projectId } : {}),
        ...(typeof body.keyName === 'string' ? { keyName: body.keyName } : {}),
      };
    }
    if (response.status === 401) return { valid: false };

    await response.text().catch(() => undefined);
    throw new Error(`Verify-Endpunkt antwortete mit HTTP ${response.status}`);
  }
}

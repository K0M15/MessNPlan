import { ApiError } from './types.js';

/** Verbindet Basis-URL und Pfad robust (Basis ggf. mit Präfix, ohne Slash-Fehler). */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

/** Liest die Antwort; wirft bei !ok einen `ApiError` mit RFC-7807-Problem. */
export async function parseResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let data: unknown = null;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) throw new ApiError(response.status, data);
  return data as T;
}

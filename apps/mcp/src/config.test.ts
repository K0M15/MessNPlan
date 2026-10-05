import { describe, expect, it } from 'vitest';
import { loadConfig, stripTrailingSlash } from './config.js';

describe('loadConfig', () => {
  it('validiert und mappt eine REST-Konfiguration', () => {
    const config = loadConfig({
      PP_API_URL: 'https://planner.example/',
      PP_EMAIL: 'bot@example.com',
      PP_PASSWORD: 'geheim-123',
      JWT_SECRET: 'internes-token',
    });

    expect(config).toMatchObject({
      apiUrl: 'https://planner.example',
      authMode: 'rest',
      email: 'bot@example.com',
      password: 'geheim-123',
      host: '0.0.0.0',
      port: 3900,
      internalUrl: 'https://planner.example',
      internalToken: 'internes-token',
    });
  });

  it('validiert und mappt eine SSH-Konfiguration', () => {
    const config = loadConfig({
      PP_API_URL: 'http://localhost:3000',
      PP_KEY_ID: '7',
      PP_PRIVATE_KEY_PATH: '/keys/pp.pem',
      PP_KEY_TYPE: 'ssh-ed25519',
      PP_PROJECT_ID: '3',
      PP_MCP_HOST: '127.0.0.1',
      PP_MCP_PORT: '3901',
      PP_INTERNAL_TOKEN: 'token-123',
    });

    expect(config).toMatchObject({
      authMode: 'ssh',
      keyId: 7,
      privateKeyPath: '/keys/pp.pem',
      keyType: 'ssh-ed25519',
      projectId: 3,
      host: '127.0.0.1',
      port: 3901,
      internalToken: 'token-123',
    });
  });

  it('bevorzugt REST, wenn beide Zugangswege gesetzt sind', () => {
    const config = loadConfig({
      PP_EMAIL: 'bot@example.com',
      PP_PASSWORD: 'geheim',
      PP_KEY_ID: '1',
      PP_PRIVATE_KEY_PATH: '/keys/pp.pem',
    });
    expect(config.authMode).toBe('rest');
  });

  it('wirft ohne Zugangsdaten eine verständliche Meldung', () => {
    expect(() => loadConfig({})).toThrow(/Keine Zugangsdaten/);
  });

  it('verlangt PP_EMAIL und PP_PASSWORD gemeinsam', () => {
    expect(() => loadConfig({ PP_EMAIL: 'bot@example.com' })).toThrow(/PP_EMAIL und PP_PASSWORD/);
    expect(() => loadConfig({ PP_PASSWORD: 'geheim' })).toThrow(/PP_EMAIL und PP_PASSWORD/);
  });

  it('verlangt PP_KEY_ID und PP_PRIVATE_KEY_PATH gemeinsam', () => {
    expect(() => loadConfig({ PP_KEY_ID: '1' })).toThrow(/PP_KEY_ID und PP_PRIVATE_KEY_PATH/);
    expect(() => loadConfig({ PP_PRIVATE_KEY_PATH: '/keys/pp.pem' })).toThrow(
      /PP_KEY_ID und PP_PRIVATE_KEY_PATH/,
    );
  });

  it('behandelt leere Env-Werte als nicht gesetzt', () => {
    const config = loadConfig({
      PP_EMAIL: 'bot@example.com',
      PP_PASSWORD: 'geheim',
      PP_KEY_ID: '',
      PP_PRIVATE_KEY_PATH: '',
      PP_MCP_HOST: '',
      PP_MCP_PORT: '',
    });
    expect(config.authMode).toBe('rest');
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(3900);
  });

  it('lehnt ungültige URLs und Ports ab', () => {
    expect(() =>
      loadConfig({ PP_API_URL: 'keine-url', PP_EMAIL: 'bot@example.com', PP_PASSWORD: 'x' }),
    ).toThrow(/PP_API_URL/);
    expect(() =>
      loadConfig({ PP_EMAIL: 'bot@example.com', PP_PASSWORD: 'x', PP_MCP_PORT: '70000' }),
    ).toThrow(/PP_MCP_PORT/);
  });

  it('setzt PP_INTERNAL_URL standardmäßig auf die API-URL', () => {
    const config = loadConfig({
      PP_API_URL: 'http://api:3000/',
      PP_EMAIL: 'bot@example.com',
      PP_PASSWORD: 'x',
    });
    expect(config.internalUrl).toBe('http://api:3000');
  });
});

describe('stripTrailingSlash', () => {
  it('entfernt nur abschließende Slashes', () => {
    expect(stripTrailingSlash('http://host/')).toBe('http://host');
    expect(stripTrailingSlash('http://host///')).toBe('http://host');
    expect(stripTrailingSlash('http://host/pfad')).toBe('http://host/pfad');
  });
});

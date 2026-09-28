import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ProxyEnvModule from './proxyEnv.js';

let mod: typeof ProxyEnvModule;

beforeEach(async () => {
  vi.resetModules();
  mod = await import('./proxyEnv.js');
});

type SetGlobalProxyFromEnv = (proxyEnv?: NodeJS.ProcessEnv) => unknown;

const fakeHttp = (): { setGlobalProxyFromEnv: Mock<SetGlobalProxyFromEnv> } => ({
  setGlobalProxyFromEnv: vi.fn<SetGlobalProxyFromEnv>(),
});

describe('applyProxyFromEnv', () => {
  it('starts as not-configured before anything is applied', () => {
    expect(mod.getProxyEnvStatus()).toBe('not-configured');
  });

  it('returns not-configured and leaves http alone when no proxy variable is set', () => {
    const http = fakeHttp();

    expect(mod.applyProxyFromEnv({ env: { NO_PROXY: 'localhost' }, http })).toBe('not-configured');
    expect(http.setGlobalProxyFromEnv).not.toHaveBeenCalled();
    expect(mod.getProxyEnvStatus()).toBe('not-configured');
  });

  it('treats empty proxy variables as unset', () => {
    const http = fakeHttp();

    expect(mod.applyProxyFromEnv({ env: { HTTPS_PROXY: '', http_proxy: '' }, http })).toBe(
      'not-configured',
    );
    expect(http.setGlobalProxyFromEnv).not.toHaveBeenCalled();
  });

  it.each([['HTTPS_PROXY'], ['https_proxy'], ['HTTP_PROXY'], ['http_proxy']] as const)(
    'applies the global proxy when %s is set',
    (name) => {
      const http = fakeHttp();
      const env = { [name]: 'http://proxy.test:8080' };

      expect(mod.applyProxyFromEnv({ env, http })).toBe('applied');
      expect(http.setGlobalProxyFromEnv).toHaveBeenCalledTimes(1);
      expect(http.setGlobalProxyFromEnv).toHaveBeenCalledWith(env);
      expect(mod.getProxyEnvStatus()).toBe('applied');
    },
  );

  it('returns already-set and leaves http alone when NODE_USE_ENV_PROXY is set', () => {
    const http = fakeHttp();

    expect(
      mod.applyProxyFromEnv({
        env: { HTTPS_PROXY: 'http://proxy.test:8080', NODE_USE_ENV_PROXY: '1' },
        http,
      }),
    ).toBe('already-set');
    expect(http.setGlobalProxyFromEnv).not.toHaveBeenCalled();
    expect(mod.getProxyEnvStatus()).toBe('already-set');
  });

  it('returns unavailable when a proxy is set but setGlobalProxyFromEnv is missing', () => {
    expect(
      mod.applyProxyFromEnv({ env: { HTTPS_PROXY: 'http://proxy.test:8080' }, http: {} }),
    ).toBe('unavailable');
    expect(mod.getProxyEnvStatus()).toBe('unavailable');
  });

  it('calls setGlobalProxyFromEnv at most once across repeated calls', () => {
    const http = fakeHttp();
    const env = { HTTPS_PROXY: 'http://proxy.test:8080' };

    expect(mod.applyProxyFromEnv({ env, http })).toBe('applied');
    expect(mod.applyProxyFromEnv({ env, http })).toBe('applied');
    expect(mod.applyProxyFromEnv({ env: {}, http })).toBe('applied');
    expect(http.setGlobalProxyFromEnv).toHaveBeenCalledTimes(1);
  });
});

export type ProxyEnvStatus = 'applied' | 'unavailable' | 'not-configured' | 'already-set';

export interface ProxyHttp {
  setGlobalProxyFromEnv?: (proxyEnv?: NodeJS.ProcessEnv) => unknown;
}

export interface ApplyProxyFromEnvOptions {
  env: NodeJS.ProcessEnv;
  http: ProxyHttp;
}

export const PROXY_UNAVAILABLE_HINT =
  "If you're behind a proxy, upgrade Node to 24.14+ or set NODE_USE_ENV_PROXY=1 on a Node version that supports it.";

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const;

const isSet = (value: string | undefined): boolean => value !== undefined && value !== '';

let status: ProxyEnvStatus = 'not-configured';

export function applyProxyFromEnv({ env, http }: ApplyProxyFromEnvOptions): ProxyEnvStatus {
  if (status === 'applied') {
    return status;
  }

  if (!PROXY_VARS.some((name) => isSet(env[name]))) {
    status = 'not-configured';
  } else if (isSet(env.NODE_USE_ENV_PROXY)) {
    status = 'already-set';
  } else if (typeof http.setGlobalProxyFromEnv !== 'function') {
    status = 'unavailable';
  } else {
    http.setGlobalProxyFromEnv(env);
    status = 'applied';
  }

  return status;
}

export const getProxyEnvStatus = (): ProxyEnvStatus => status;

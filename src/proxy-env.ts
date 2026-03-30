const TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSY_VALUES = new Set(["0", "false", "no", "off"]);

export const CODEHARBOR_PROXY_ENABLED_KEY = "CODEHARBOR_PROXY_ENABLED";
export const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"] as const;
export const PROXY_ENV_INHERITED_KEYS = PROXY_ENV_KEYS.flatMap((key) => [key, key.toLowerCase()]);

export interface ProxyConfig {
  enabled: boolean;
  httpProxy: string;
  httpsProxy: string;
  allProxy: string;
  noProxy: string;
}

export interface ExecutorProxyEnvConfig {
  extraEnv: Record<string, string>;
  clearProxyEnv: boolean;
}

export function hasProxyEndpoint(config: Pick<ProxyConfig, "httpProxy" | "httpsProxy" | "allProxy">): boolean {
  return Boolean(config.httpProxy || config.httpsProxy || config.allProxy);
}

export function readProxyConfigFromExtraEnv(extraEnv: Record<string, string>): ProxyConfig {
  const httpProxy = readProxyValue(extraEnv, "HTTP_PROXY");
  const httpsProxy = readProxyValue(extraEnv, "HTTPS_PROXY");
  const allProxy = readProxyValue(extraEnv, "ALL_PROXY");
  const noProxy = readProxyValue(extraEnv, "NO_PROXY");
  const sentinel = parseBooleanString(extraEnv[CODEHARBOR_PROXY_ENABLED_KEY]);

  return {
    enabled: sentinel === undefined ? hasProxyEndpoint({ httpProxy, httpsProxy, allProxy }) : sentinel,
    httpProxy,
    httpsProxy,
    allProxy,
    noProxy,
  };
}

export function mergeProxyConfigIntoExtraEnv(
  baseEnv: Record<string, string>,
  proxyConfig: ProxyConfig,
): Record<string, string> {
  const output: Record<string, string> = { ...baseEnv };
  delete output[CODEHARBOR_PROXY_ENABLED_KEY];
  for (const key of PROXY_ENV_KEYS) {
    delete output[key];
    delete output[key.toLowerCase()];
  }

  output[CODEHARBOR_PROXY_ENABLED_KEY] = proxyConfig.enabled ? "true" : "false";

  const httpProxy = proxyConfig.httpProxy.trim();
  const httpsProxy = proxyConfig.httpsProxy.trim();
  const allProxy = proxyConfig.allProxy.trim();
  const noProxy = proxyConfig.noProxy.trim();

  if (httpProxy) {
    output.HTTP_PROXY = httpProxy;
  }
  if (httpsProxy) {
    output.HTTPS_PROXY = httpsProxy;
  }
  if (allProxy) {
    output.ALL_PROXY = allProxy;
  }
  if (noProxy) {
    output.NO_PROXY = noProxy;
  }

  return output;
}

export function resolveExecutorProxyEnv(extraEnv: Record<string, string>): ExecutorProxyEnvConfig {
  const hasSentinel = Object.prototype.hasOwnProperty.call(extraEnv, CODEHARBOR_PROXY_ENABLED_KEY);
  const sentinel = parseBooleanString(extraEnv[CODEHARBOR_PROXY_ENABLED_KEY]);
  const explicitDisabled = hasSentinel && sentinel === false;
  const sanitizedEnv: Record<string, string> = { ...extraEnv };
  delete sanitizedEnv[CODEHARBOR_PROXY_ENABLED_KEY];

  if (explicitDisabled) {
    for (const key of PROXY_ENV_KEYS) {
      delete sanitizedEnv[key];
      delete sanitizedEnv[key.toLowerCase()];
    }
  }

  return {
    extraEnv: sanitizedEnv,
    clearProxyEnv: explicitDisabled,
  };
}

function readProxyValue(extraEnv: Record<string, string>, key: (typeof PROXY_ENV_KEYS)[number]): string {
  const preferred = extraEnv[key];
  if (typeof preferred === "string") {
    return preferred.trim();
  }
  const fallback = extraEnv[key.toLowerCase()];
  if (typeof fallback === "string") {
    return fallback.trim();
  }
  return "";
}

function parseBooleanString(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (TRUTHY_VALUES.has(normalized)) {
    return true;
  }
  if (FALSY_VALUES.has(normalized)) {
    return false;
  }
  return undefined;
}

export const TOKEN_SCOPES = {
  ADMIN_READ: "admin.read",
  ADMIN_WRITE: "admin.write",
  METRICS_READ: "metrics.read",
  TASKS_SUBMIT: "tasks.submit",
  TASKS_READ: "tasks.read",
  WEBHOOK_INGEST: "webhook.ingest",
} as const;

export type TokenScope = (typeof TOKEN_SCOPES)[keyof typeof TOKEN_SCOPES];
export type TokenScopePattern = TokenScope | `${string}.*` | "*";

export interface ScopeRequirement {
  action: TokenScope;
  requiredScopes: readonly TokenScope[];
}

export interface ScopeMatrixEntry extends ScopeRequirement {
  surface: "admin" | "api" | "webhook";
  method: string;
  path: string;
}

export const ADMIN_VIEWER_SCOPES: readonly TokenScope[] = [TOKEN_SCOPES.ADMIN_READ, TOKEN_SCOPES.METRICS_READ];

export const ADMIN_WRITER_SCOPES: readonly TokenScope[] = [
  TOKEN_SCOPES.ADMIN_READ,
  TOKEN_SCOPES.METRICS_READ,
  TOKEN_SCOPES.ADMIN_WRITE,
];

export const API_TOKEN_SCOPES: readonly TokenScope[] = [TOKEN_SCOPES.TASKS_SUBMIT, TOKEN_SCOPES.TASKS_READ];

export const WEBHOOK_SIGNATURE_SCOPES: readonly TokenScope[] = [TOKEN_SCOPES.WEBHOOK_INGEST];

const ADMIN_READ_REQUIREMENT: ScopeRequirement = {
  action: TOKEN_SCOPES.ADMIN_READ,
  requiredScopes: [TOKEN_SCOPES.ADMIN_READ],
};

const ADMIN_WRITE_REQUIREMENT: ScopeRequirement = {
  action: TOKEN_SCOPES.ADMIN_WRITE,
  requiredScopes: [TOKEN_SCOPES.ADMIN_WRITE],
};

const METRICS_READ_REQUIREMENT: ScopeRequirement = {
  action: TOKEN_SCOPES.METRICS_READ,
  requiredScopes: [TOKEN_SCOPES.METRICS_READ],
};

const TASK_SUBMIT_REQUIREMENT: ScopeRequirement = {
  action: TOKEN_SCOPES.TASKS_SUBMIT,
  requiredScopes: [TOKEN_SCOPES.TASKS_SUBMIT],
};

const TASK_READ_REQUIREMENT: ScopeRequirement = {
  action: TOKEN_SCOPES.TASKS_READ,
  requiredScopes: [TOKEN_SCOPES.TASKS_READ],
};

const WEBHOOK_INGEST_REQUIREMENT: ScopeRequirement = {
  action: TOKEN_SCOPES.WEBHOOK_INGEST,
  requiredScopes: [TOKEN_SCOPES.WEBHOOK_INGEST],
};

export const AUTH_SCOPE_MATRIX: readonly ScopeMatrixEntry[] = [
  {
    surface: "admin",
    method: "GET|HEAD",
    path: "/metrics",
    action: TOKEN_SCOPES.METRICS_READ,
    requiredScopes: [TOKEN_SCOPES.METRICS_READ],
  },
  {
    surface: "admin",
    method: "GET|HEAD",
    path: "/api/admin/*",
    action: TOKEN_SCOPES.ADMIN_READ,
    requiredScopes: [TOKEN_SCOPES.ADMIN_READ],
  },
  {
    surface: "admin",
    method: "PUT|POST|DELETE|PATCH",
    path: "/api/admin/*",
    action: TOKEN_SCOPES.ADMIN_WRITE,
    requiredScopes: [TOKEN_SCOPES.ADMIN_WRITE],
  },
  {
    surface: "api",
    method: "POST",
    path: "/api/tasks",
    action: TOKEN_SCOPES.TASKS_SUBMIT,
    requiredScopes: [TOKEN_SCOPES.TASKS_SUBMIT],
  },
  {
    surface: "api",
    method: "GET",
    path: "/api/tasks/:taskId",
    action: TOKEN_SCOPES.TASKS_READ,
    requiredScopes: [TOKEN_SCOPES.TASKS_READ],
  },
  {
    surface: "webhook",
    method: "POST",
    path: "/api/webhooks/:source",
    action: TOKEN_SCOPES.WEBHOOK_INGEST,
    requiredScopes: [TOKEN_SCOPES.WEBHOOK_INGEST],
  },
] as const;

export function scopesForAdminRole(role: "admin" | "viewer"): TokenScope[] {
  if (role === "admin") {
    return [...ADMIN_WRITER_SCOPES];
  }
  return [...ADMIN_VIEWER_SCOPES];
}

export function resolveAdminScopeRequirement(method: string | undefined, pathname: string): ScopeRequirement | null {
  if (pathname === "/metrics") {
    return METRICS_READ_REQUIREMENT;
  }
  if (!pathname.startsWith("/api/admin/")) {
    return null;
  }

  const normalizedMethod = (method ?? "GET").toUpperCase();
  if (normalizedMethod === "GET" || normalizedMethod === "HEAD") {
    return ADMIN_READ_REQUIREMENT;
  }
  return ADMIN_WRITE_REQUIREMENT;
}

export function resolveApiScopeRequirement(pathname: string): ScopeRequirement | null {
  if (pathname === "/api/tasks") {
    return TASK_SUBMIT_REQUIREMENT;
  }
  if (/^\/api\/tasks\/[^/]+$/.test(pathname)) {
    return TASK_READ_REQUIREMENT;
  }
  return null;
}

export function resolveWebhookScopeRequirement(pathname: string): ScopeRequirement | null {
  if (/^\/api\/webhooks\/[^/]+$/.test(pathname)) {
    return WEBHOOK_INGEST_REQUIREMENT;
  }
  return null;
}

export function normalizeTokenScopes(scopes: readonly string[]): TokenScopePattern[] {
  const normalized: TokenScopePattern[] = [];
  const seen = new Set<string>();

  for (const rawScope of scopes) {
    const scope = rawScope.trim().toLowerCase();
    if (!scope || seen.has(scope)) {
      continue;
    }
    seen.add(scope);
    normalized.push(scope as TokenScopePattern);
  }

  return normalized;
}

export function hasScope(grantedScopes: readonly string[], requiredScope: TokenScope): boolean {
  const normalizedScopes = normalizeTokenScopes(grantedScopes);
  return normalizedScopes.some((scope) => scopePatternMatches(scope, requiredScope));
}

export function hasRequiredScopes(grantedScopes: readonly string[], requiredScopes: readonly TokenScope[]): boolean {
  return requiredScopes.every((requiredScope) => hasScope(grantedScopes, requiredScope));
}

export function listMissingScopes(grantedScopes: readonly string[], requiredScopes: readonly TokenScope[]): TokenScope[] {
  return requiredScopes.filter((requiredScope) => !hasScope(grantedScopes, requiredScope));
}

function scopePatternMatches(scopePattern: TokenScopePattern, requiredScope: TokenScope): boolean {
  if (scopePattern === "*") {
    return true;
  }
  if (scopePattern === requiredScope) {
    return true;
  }
  if (scopePattern.endsWith(".*")) {
    const prefix = scopePattern.slice(0, -1);
    return requiredScope.startsWith(prefix);
  }
  return false;
}

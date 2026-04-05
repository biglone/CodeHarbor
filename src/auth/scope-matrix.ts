export const TOKEN_SCOPES = {
  ADMIN_READ: "admin.read",
  ADMIN_READ_AUTH: "admin.read.auth",
  ADMIN_READ_CONFIG: "admin.read.config",
  ADMIN_READ_AUDIT: "admin.read.audit",
  ADMIN_READ_SESSIONS: "admin.read.sessions",
  ADMIN_READ_HISTORY: "admin.read.history",
  ADMIN_READ_HEALTH: "admin.read.health",
  ADMIN_WRITE: "admin.write",
  ADMIN_WRITE_CONFIG: "admin.write.config",
  ADMIN_WRITE_CONFIG_IMPORT: "admin.write.config.import",
  ADMIN_WRITE_CONFIG_EXPORT: "admin.write.config.export",
  ADMIN_WRITE_HISTORY: "admin.write.history",
  ADMIN_WRITE_SERVICE: "admin.write.service",
  METRICS_READ: "metrics.read",
  TASKS_SUBMIT: "tasks.submit",
  TASKS_SUBMIT_API: "tasks.submit.api",
  TASKS_READ: "tasks.read",
  TASKS_READ_API: "tasks.read.api",
  WEBHOOK_INGEST: "webhook.ingest",
  WEBHOOK_INGEST_CI: "webhook.ingest.ci",
  WEBHOOK_INGEST_TICKET: "webhook.ingest.ticket",
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

const WEBHOOK_CI_ALIASES = new Set(["ci", "pipeline", "build"]);
const WEBHOOK_TICKET_ALIASES = new Set(["ticket", "issue", "workitem", "work-item"]);
const TOKEN_SCOPE_REGEX = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\.[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;

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

const ADMIN_READ_AUTH_REQUIREMENT: ScopeRequirement = {
  action: TOKEN_SCOPES.ADMIN_READ_AUTH,
  requiredScopes: [TOKEN_SCOPES.ADMIN_READ_AUTH],
};

const ADMIN_READ_CONFIG_REQUIREMENT: ScopeRequirement = {
  action: TOKEN_SCOPES.ADMIN_READ_CONFIG,
  requiredScopes: [TOKEN_SCOPES.ADMIN_READ_CONFIG],
};

const ADMIN_READ_AUDIT_REQUIREMENT: ScopeRequirement = {
  action: TOKEN_SCOPES.ADMIN_READ_AUDIT,
  requiredScopes: [TOKEN_SCOPES.ADMIN_READ_AUDIT],
};

const ADMIN_READ_SESSIONS_REQUIREMENT: ScopeRequirement = {
  action: TOKEN_SCOPES.ADMIN_READ_SESSIONS,
  requiredScopes: [TOKEN_SCOPES.ADMIN_READ_SESSIONS],
};

const ADMIN_READ_HISTORY_REQUIREMENT: ScopeRequirement = {
  action: TOKEN_SCOPES.ADMIN_READ_HISTORY,
  requiredScopes: [TOKEN_SCOPES.ADMIN_READ_HISTORY],
};

const ADMIN_READ_HEALTH_REQUIREMENT: ScopeRequirement = {
  action: TOKEN_SCOPES.ADMIN_READ_HEALTH,
  requiredScopes: [TOKEN_SCOPES.ADMIN_READ_HEALTH],
};

const ADMIN_WRITE_REQUIREMENT: ScopeRequirement = {
  action: TOKEN_SCOPES.ADMIN_WRITE,
  requiredScopes: [TOKEN_SCOPES.ADMIN_WRITE],
};

const ADMIN_WRITE_CONFIG_REQUIREMENT: ScopeRequirement = {
  action: TOKEN_SCOPES.ADMIN_WRITE_CONFIG,
  requiredScopes: [TOKEN_SCOPES.ADMIN_WRITE_CONFIG],
};

const ADMIN_WRITE_CONFIG_IMPORT_REQUIREMENT: ScopeRequirement = {
  action: TOKEN_SCOPES.ADMIN_WRITE_CONFIG_IMPORT,
  requiredScopes: [TOKEN_SCOPES.ADMIN_WRITE_CONFIG_IMPORT],
};

const ADMIN_WRITE_CONFIG_EXPORT_REQUIREMENT: ScopeRequirement = {
  action: TOKEN_SCOPES.ADMIN_WRITE_CONFIG_EXPORT,
  requiredScopes: [TOKEN_SCOPES.ADMIN_WRITE_CONFIG_EXPORT],
};

const ADMIN_WRITE_HISTORY_REQUIREMENT: ScopeRequirement = {
  action: TOKEN_SCOPES.ADMIN_WRITE_HISTORY,
  requiredScopes: [TOKEN_SCOPES.ADMIN_WRITE_HISTORY],
};

const ADMIN_WRITE_SERVICE_REQUIREMENT: ScopeRequirement = {
  action: TOKEN_SCOPES.ADMIN_WRITE_SERVICE,
  requiredScopes: [TOKEN_SCOPES.ADMIN_WRITE_SERVICE],
};

const METRICS_READ_REQUIREMENT: ScopeRequirement = {
  action: TOKEN_SCOPES.METRICS_READ,
  requiredScopes: [TOKEN_SCOPES.METRICS_READ],
};

const TASK_SUBMIT_API_REQUIREMENT: ScopeRequirement = {
  action: TOKEN_SCOPES.TASKS_SUBMIT_API,
  requiredScopes: [TOKEN_SCOPES.TASKS_SUBMIT_API],
};

const TASK_READ_API_REQUIREMENT: ScopeRequirement = {
  action: TOKEN_SCOPES.TASKS_READ_API,
  requiredScopes: [TOKEN_SCOPES.TASKS_READ_API],
};

const WEBHOOK_INGEST_REQUIREMENT: ScopeRequirement = {
  action: TOKEN_SCOPES.WEBHOOK_INGEST,
  requiredScopes: [TOKEN_SCOPES.WEBHOOK_INGEST],
};

const WEBHOOK_INGEST_CI_REQUIREMENT: ScopeRequirement = {
  action: TOKEN_SCOPES.WEBHOOK_INGEST_CI,
  requiredScopes: [TOKEN_SCOPES.WEBHOOK_INGEST_CI],
};

const WEBHOOK_INGEST_TICKET_REQUIREMENT: ScopeRequirement = {
  action: TOKEN_SCOPES.WEBHOOK_INGEST_TICKET,
  requiredScopes: [TOKEN_SCOPES.WEBHOOK_INGEST_TICKET],
};

const ADMIN_READ_PATH_REGEXES: readonly RegExp[] = [
  /^\/api\/admin\/config\/rooms(?:\/[^/].*)?$/,
  /^\/api\/admin\/sessions(?:\/[^/].*\/messages)?$/,
  /^\/api\/admin\/sessions\/export$/,
];

const ADMIN_ACTIONABLE_WRITE_SCOPES: readonly TokenScope[] = [
  TOKEN_SCOPES.ADMIN_WRITE,
  TOKEN_SCOPES.ADMIN_WRITE_CONFIG,
  TOKEN_SCOPES.ADMIN_WRITE_CONFIG_IMPORT,
  TOKEN_SCOPES.ADMIN_WRITE_CONFIG_EXPORT,
  TOKEN_SCOPES.ADMIN_WRITE_HISTORY,
  TOKEN_SCOPES.ADMIN_WRITE_SERVICE,
];

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
    path: "/api/admin/auth/status",
    action: TOKEN_SCOPES.ADMIN_READ_AUTH,
    requiredScopes: [TOKEN_SCOPES.ADMIN_READ_AUTH],
  },
  {
    surface: "admin",
    method: "GET|HEAD",
    path: "/api/admin/config/global|/api/admin/config/skills|/api/admin/config/rooms|/api/admin/config/rooms/:roomId|/api/admin/bot-profiles",
    action: TOKEN_SCOPES.ADMIN_READ_CONFIG,
    requiredScopes: [TOKEN_SCOPES.ADMIN_READ_CONFIG],
  },
  {
    surface: "admin",
    method: "POST|PUT|DELETE",
    path: "/api/admin/config/global|/api/admin/config/validate|/api/admin/config/rooms/:roomId|/api/admin/bot-profiles|/api/admin/bot-profiles/migrate",
    action: TOKEN_SCOPES.ADMIN_WRITE_CONFIG,
    requiredScopes: [TOKEN_SCOPES.ADMIN_WRITE_CONFIG],
  },
  {
    surface: "admin",
    method: "POST",
    path: "/api/admin/config/import",
    action: TOKEN_SCOPES.ADMIN_WRITE_CONFIG_IMPORT,
    requiredScopes: [TOKEN_SCOPES.ADMIN_WRITE_CONFIG_IMPORT],
  },
  {
    surface: "admin",
    method: "GET|HEAD",
    path: "/api/admin/config/export",
    action: TOKEN_SCOPES.ADMIN_WRITE_CONFIG_EXPORT,
    requiredScopes: [TOKEN_SCOPES.ADMIN_WRITE_CONFIG_EXPORT],
  },
  {
    surface: "admin",
    method: "GET|HEAD",
    path: "/api/admin/audit",
    action: TOKEN_SCOPES.ADMIN_READ_AUDIT,
    requiredScopes: [TOKEN_SCOPES.ADMIN_READ_AUDIT],
  },
  {
    surface: "admin",
    method: "GET|HEAD",
    path: "/api/admin/sessions*",
    action: TOKEN_SCOPES.ADMIN_READ_SESSIONS,
    requiredScopes: [TOKEN_SCOPES.ADMIN_READ_SESSIONS],
  },
  {
    surface: "admin",
    method: "GET|HEAD",
    path: "/api/admin/history/retention|/api/admin/history/cleanup/runs",
    action: TOKEN_SCOPES.ADMIN_READ_HISTORY,
    requiredScopes: [TOKEN_SCOPES.ADMIN_READ_HISTORY],
  },
  {
    surface: "admin",
    method: "PUT|POST",
    path: "/api/admin/history/retention|/api/admin/history/cleanup",
    action: TOKEN_SCOPES.ADMIN_WRITE_HISTORY,
    requiredScopes: [TOKEN_SCOPES.ADMIN_WRITE_HISTORY],
  },
  {
    surface: "admin",
    method: "GET|HEAD",
    path: "/api/admin/health|/api/admin/diagnostics",
    action: TOKEN_SCOPES.ADMIN_READ_HEALTH,
    requiredScopes: [TOKEN_SCOPES.ADMIN_READ_HEALTH],
  },
  {
    surface: "admin",
    method: "POST",
    path: "/api/admin/service/restart|/api/admin/bot-profiles/apply",
    action: TOKEN_SCOPES.ADMIN_WRITE_SERVICE,
    requiredScopes: [TOKEN_SCOPES.ADMIN_WRITE_SERVICE],
  },
  {
    surface: "api",
    method: "POST",
    path: "/api/tasks",
    action: TOKEN_SCOPES.TASKS_SUBMIT_API,
    requiredScopes: [TOKEN_SCOPES.TASKS_SUBMIT_API],
  },
  {
    surface: "api",
    method: "GET",
    path: "/api/tasks/:taskId",
    action: TOKEN_SCOPES.TASKS_READ_API,
    requiredScopes: [TOKEN_SCOPES.TASKS_READ_API],
  },
  {
    surface: "webhook",
    method: "POST",
    path: "/api/webhooks/ci",
    action: TOKEN_SCOPES.WEBHOOK_INGEST_CI,
    requiredScopes: [TOKEN_SCOPES.WEBHOOK_INGEST_CI],
  },
  {
    surface: "webhook",
    method: "POST",
    path: "/api/webhooks/ticket",
    action: TOKEN_SCOPES.WEBHOOK_INGEST_TICKET,
    requiredScopes: [TOKEN_SCOPES.WEBHOOK_INGEST_TICKET],
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
  const isReadMethod = normalizedMethod === "GET" || normalizedMethod === "HEAD";

  if (pathname === "/api/admin/auth/status") {
    return ADMIN_READ_AUTH_REQUIREMENT;
  }
  if (pathname === "/api/admin/audit") {
    return ADMIN_READ_AUDIT_REQUIREMENT;
  }
  if (pathname === "/api/admin/config/export") {
    return ADMIN_WRITE_CONFIG_EXPORT_REQUIREMENT;
  }
  if (pathname === "/api/admin/config/import") {
    return ADMIN_WRITE_CONFIG_IMPORT_REQUIREMENT;
  }
  if (pathname === "/api/admin/config/validate") {
    return ADMIN_WRITE_CONFIG_REQUIREMENT;
  }
  if (pathname === "/api/admin/config/global") {
    return isReadMethod ? ADMIN_READ_CONFIG_REQUIREMENT : ADMIN_WRITE_CONFIG_REQUIREMENT;
  }
  if (pathname === "/api/admin/bot-profiles") {
    return isReadMethod ? ADMIN_READ_CONFIG_REQUIREMENT : ADMIN_WRITE_CONFIG_REQUIREMENT;
  }
  if (pathname === "/api/admin/bot-profiles/migrate") {
    return ADMIN_WRITE_CONFIG_REQUIREMENT;
  }
  if (pathname === "/api/admin/bot-profiles/apply") {
    return ADMIN_WRITE_SERVICE_REQUIREMENT;
  }
  if (pathname === "/api/admin/config/skills") {
    return ADMIN_READ_CONFIG_REQUIREMENT;
  }
  if (ADMIN_READ_PATH_REGEXES.some((regex) => regex.test(pathname))) {
    if (pathname.startsWith("/api/admin/sessions")) {
      return ADMIN_READ_SESSIONS_REQUIREMENT;
    }
    return isReadMethod ? ADMIN_READ_CONFIG_REQUIREMENT : ADMIN_WRITE_CONFIG_REQUIREMENT;
  }
  if (pathname === "/api/admin/history/retention") {
    return isReadMethod ? ADMIN_READ_HISTORY_REQUIREMENT : ADMIN_WRITE_HISTORY_REQUIREMENT;
  }
  if (pathname === "/api/admin/history/cleanup/runs") {
    return ADMIN_READ_HISTORY_REQUIREMENT;
  }
  if (pathname === "/api/admin/history/cleanup") {
    return ADMIN_WRITE_HISTORY_REQUIREMENT;
  }
  if (pathname === "/api/admin/health" || pathname === "/api/admin/diagnostics") {
    return ADMIN_READ_HEALTH_REQUIREMENT;
  }
  if (pathname === "/api/admin/service/restart") {
    return ADMIN_WRITE_SERVICE_REQUIREMENT;
  }

  return isReadMethod ? ADMIN_READ_REQUIREMENT : ADMIN_WRITE_REQUIREMENT;
}

export function resolveApiScopeRequirement(pathname: string): ScopeRequirement | null {
  if (pathname === "/api/tasks") {
    return TASK_SUBMIT_API_REQUIREMENT;
  }
  if (/^\/api\/tasks\/[^/]+$/.test(pathname)) {
    return TASK_READ_API_REQUIREMENT;
  }
  return null;
}

export function resolveWebhookScopeRequirement(pathname: string): ScopeRequirement | null {
  const match = /^\/api\/webhooks\/([^/]+)$/.exec(pathname);
  if (!match) {
    return null;
  }

  const source = decodePathParam(match[1]).toLowerCase();
  if (WEBHOOK_CI_ALIASES.has(source)) {
    return WEBHOOK_INGEST_CI_REQUIREMENT;
  }
  if (WEBHOOK_TICKET_ALIASES.has(source)) {
    return WEBHOOK_INGEST_TICKET_REQUIREMENT;
  }
  return WEBHOOK_INGEST_REQUIREMENT;
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

export function isValidTokenScopePattern(scope: string): scope is TokenScopePattern {
  if (scope === "*") {
    return true;
  }
  if (scope.endsWith(".*")) {
    const prefix = scope.slice(0, -2);
    return TOKEN_SCOPE_REGEX.test(prefix);
  }
  return TOKEN_SCOPE_REGEX.test(scope);
}

export function hasScope(grantedScopes: readonly string[], requiredScope: TokenScope): boolean {
  const normalizedScopes = normalizeTokenScopes(grantedScopes);
  return normalizedScopes.some((scope) => scopePatternMatches(scope, requiredScope));
}

export function hasRequiredScopes(grantedScopes: readonly string[], requiredScopes: readonly TokenScope[]): boolean {
  return requiredScopes.every((requiredScope) => hasScope(grantedScopes, requiredScope));
}

export function hasAnyAdminWriteScope(grantedScopes: readonly string[]): boolean {
  return ADMIN_ACTIONABLE_WRITE_SCOPES.some((scope) => hasScope(grantedScopes, scope));
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
  if (requiredScope.startsWith(`${scopePattern}.`)) {
    return true;
  }
  return false;
}

function decodePathParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

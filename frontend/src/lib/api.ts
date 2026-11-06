// Typed client for the Strata backend. All requests go through the same-origin /api proxy;
// the session lives in an HttpOnly cookie and mutating requests echo the CSRF token.

import type {
  AuditEntry, AuthStatus, CatalogTable, Connection, ConnectionInput, DashboardData, DataPage, DataRequest,
  DbObject, ExecuteResult, HistoryItem, MutationResult, SavedQuery, SchemaChange, SchemaInfo, SchemaPreview,
  ServerInfo, TableStructure, User,
} from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let unauthorizedHandler: (() => void) | null = null;
export function onUnauthorized(fn: () => void) {
  unauthorizedHandler = fn;
}

function csrfToken(): string {
  const m = document.cookie.match(/(?:^|;\s*)strata_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
}

function detailMessage(detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        const loc = Array.isArray(d?.loc) ? d.loc.filter((x: unknown) => x !== "body").join(".") : "";
        return loc ? `${loc}: ${d.msg}` : d?.msg;
      })
      .join("; ");
  }
  return "Request failed";
}

export async function request<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== "GET") headers["X-CSRF-Token"] = csrfToken();
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload, credentials: "same-origin", ...init });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/api/auth/")) unauthorizedHandler?.();
    const msg = data && typeof data === "object" && "detail" in data ? detailMessage((data as { detail: unknown }).detail) : res.statusText;
    throw new ApiError(res.status, msg || `HTTP ${res.status}`);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const c = (id: string) => `/api/connections/${encodeURIComponent(id)}`;

export const api = {
  auth: {
    status: () => request<AuthStatus>("GET", "/api/auth/status"),
    setup: (username: string, password: string) => request<AuthStatus>("POST", "/api/auth/setup", { username, password }),
    login: (username: string, password: string) => request<AuthStatus>("POST", "/api/auth/login", { username, password }),
    logout: () => request<{ ok: boolean }>("POST", "/api/auth/logout"),
    users: () => request<User[]>("GET", "/api/auth/users"),
    createUser: (username: string, password: string, role: "admin" | "member") => request<User>("POST", "/api/auth/users", { username, password, role }),
    changePassword: (current_password: string, new_password: string) => request<{ ok: boolean }>("POST", "/api/auth/password", { current_password, new_password }),
  },
  connections: {
    list: () => request<Connection[]>("GET", "/api/connections"),
    create: (body: ConnectionInput) => request<Connection>("POST", "/api/connections", body),
    update: (id: string, body: ConnectionInput) => request<Connection>("PUT", c(id), body),
    remove: (id: string) => request<void>("DELETE", c(id)),
    test: (body: ConnectionInput & { connection_id?: string }) => request<ServerInfo>("POST", "/api/connections/test", body),
    connect: (id: string) => request<ServerInfo>("POST", `${c(id)}/connect`),
    disconnect: (id: string) => request<{ ok: boolean }>("POST", `${c(id)}/disconnect`),
  },
  explorer: {
    databases: (id: string) => request<SchemaInfo[]>("GET", `${c(id)}/databases`),
    schemas: (id: string, database: string | null) => request<SchemaInfo[]>("GET", `${c(id)}/schemas${qs({ database })}`),
    objects: (id: string, database: string | null, schema: string | null) => request<DbObject[]>("GET", `${c(id)}/objects${qs({ database, schema })}`),
    catalog: (id: string, database: string | null) => request<CatalogTable[]>("GET", `${c(id)}/catalog${qs({ database })}`),
    structure: (id: string, database: string | null, schema: string | null, table: string) =>
      request<TableStructure>("GET", `${c(id)}/structure${qs({ database, schema, table })}`),
    ddl: (id: string, database: string | null, schema: string | null, name: string, kind: string) =>
      request<{ sql: string }>("GET", `${c(id)}/ddl${qs({ database, schema, name, kind })}`),
    dashboard: (id: string, database: string | null) => request<DashboardData>("GET", `${c(id)}/dashboard${qs({ database })}`),
  },
  data: {
    page: (id: string, database: string | null, req: DataRequest, signal?: AbortSignal) =>
      request<DataPage>("POST", `${c(id)}/data${qs({ database })}`, req, { signal }),
    insert: (id: string, database: string | null, schema_name: string | null, table: string, rows: Record<string, unknown>[]) =>
      request<MutationResult>("POST", `${c(id)}/data/insert${qs({ database })}`, { schema_name, table, rows }),
    update: (id: string, database: string | null, schema_name: string | null, table: string, updates: { key: Record<string, unknown>; values: Record<string, unknown> }[]) =>
      request<MutationResult>("POST", `${c(id)}/data/update${qs({ database })}`, { schema_name, table, updates }),
    remove: (id: string, database: string | null, schema_name: string | null, table: string, keys: Record<string, unknown>[]) =>
      request<MutationResult>("POST", `${c(id)}/data/delete${qs({ database })}`, { schema_name, table, keys }),
  },
  query: {
    execute: (id: string, body: { sql: string; database: string | null; query_id: string; max_rows?: number }) =>
      request<ExecuteResult>("POST", `${c(id)}/query`, body),
    cancel: (queryId: string) => request<{ cancelled: boolean }>("POST", `/api/queries/${encodeURIComponent(queryId)}/cancel`),
  },
  history: {
    list: (params: { q?: string; connection_id?: string; status?: string; since?: string; pinned?: boolean; limit?: number; offset?: number }) =>
      request<{ items: HistoryItem[]; total: number }>("GET", `/api/history${qs(params)}`),
    pin: (id: number, pinned: boolean) => request<HistoryItem>("PATCH", `/api/history/${id}`, { pinned }),
    clear: () => request<void>("DELETE", "/api/history"),
  },
  saved: {
    list: () => request<SavedQuery[]>("GET", "/api/saved-queries"),
    create: (body: Omit<SavedQuery, "id" | "created_at" | "updated_at">) => request<SavedQuery>("POST", "/api/saved-queries", body),
    update: (id: string, body: Omit<SavedQuery, "id" | "created_at" | "updated_at">) => request<SavedQuery>("PUT", `/api/saved-queries/${id}`, body),
    remove: (id: string) => request<void>("DELETE", `/api/saved-queries/${id}`),
  },
  schema: {
    preview: (id: string, database: string | null, change: SchemaChange) =>
      request<SchemaPreview>("POST", `${c(id)}/schema/preview${qs({ database })}`, change),
    apply: (id: string, database: string | null, change: SchemaChange, expected: string[], confirmDestructive: boolean) =>
      request<{ statements: string[] }>("POST", `${c(id)}/schema/apply${qs({ database })}`, {
        change, expected_statements: expected, confirm_destructive: confirmDestructive,
      }),
  },
  io: {
    prepareExport: (body: { connection_id: string; database: string | null; format: "csv" | "json" | "sql"; table?: DataRequest; sql?: string; limit?: number }) =>
      request<{ ticket: string; url: string }>("POST", "/api/exports", body),
    import: (id: string, form: FormData) => request<{ rows: number; statements: number }>("POST", `${c(id)}/import`, form),
  },
  audit: {
    list: (params: { action?: string; q?: string; limit?: number; offset?: number }) =>
      request<{ items: AuditEntry[]; total: number }>("GET", `/api/audit${qs(params)}`),
  },
};

/** Start a streamed download without buffering the file in JS memory. */
export async function downloadExport(body: Parameters<typeof api.io.prepareExport>[0]) {
  const { url } = await api.io.prepareExport(body);
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

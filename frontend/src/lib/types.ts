// API contracts. These mirror backend/app/adapters/types.py, requests.py and the route models.

export type Engine = "postgresql" | "mysql" | "sqlite";
export type TypeCategory =
  | "integer" | "float" | "decimal" | "boolean" | "text" | "json" | "date" | "datetime" | "time"
  | "uuid" | "binary" | "array" | "other";
export type ObjectKind = "table" | "view" | "materialized_view" | "function" | "procedure" | "sequence" | "trigger";
export type SslMode = "disable" | "allow" | "prefer" | "require" | "verify-ca" | "verify-full";

export interface Capabilities {
  schemas: boolean;
  multiple_databases: boolean;
  sequences: boolean;
  functions: boolean;
  procedures: boolean;
  triggers: boolean;
  cancel: boolean;
  transactional_ddl: boolean;
  alter_column: boolean;
  add_constraint: boolean;
}

export interface User {
  id: string;
  username: string;
  role: "admin" | "member";
}

export interface AuthStatus {
  setup_required: boolean;
  user: User | null;
  csrf_token: string | null;
}

export interface Connection {
  id: string;
  name: string;
  engine: Engine;
  group: string | null;
  color: string | null;
  host: string | null;
  port: number | null;
  username: string | null;
  database: string | null;
  ssl_mode: SslMode;
  params: Record<string, string>;
  read_only: boolean;
  query_timeout_s: number | null;
  has_password: boolean;
  has_ssl_ca: boolean;
  is_open: boolean;
  capabilities: Capabilities;
  identifier_quote: string;
  created_at: string;
  last_used_at: string | null;
}

export interface ConnectionInput {
  name: string;
  engine: Engine;
  group?: string | null;
  color?: string | null;
  host?: string | null;
  port?: number | null;
  username?: string | null;
  password?: string | null;
  clear_password?: boolean;
  database?: string | null;
  ssl_mode: SslMode;
  ssl_ca?: string | null;
  clear_ssl_ca?: boolean;
  params: Record<string, string>;
  read_only: boolean;
  query_timeout_s?: number | null;
}

export interface ServerInfo {
  engine: Engine;
  version: string;
  current_database: string | null;
  current_user: string | null;
  latency_ms: number;
}

export interface SchemaInfo {
  name: string;
  is_system: boolean;
}

export interface DbObject {
  name: string;
  kind: ObjectKind;
  schema_name: string | null;
  comment: string | null;
  row_estimate: number | null;
  extra: Record<string, unknown>;
}

export interface ColumnInfo {
  name: string;
  data_type: string;
  category: TypeCategory;
  nullable: boolean;
  default: string | null;
  is_primary_key: boolean;
  is_auto_increment: boolean;
  comment: string | null;
  ordinal: number;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  method: string | null;
  definition: string | null;
  size_bytes: number | null;
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  ref_schema: string | null;
  ref_table: string;
  ref_columns: string[];
  on_update: string | null;
  on_delete: string | null;
}

export interface ConstraintInfo {
  name: string;
  type: "primary_key" | "unique" | "check" | "foreign_key";
  columns: string[];
  definition: string | null;
}

export interface TriggerInfo {
  name: string;
  timing: string | null;
  event: string | null;
  definition: string | null;
}

export interface TableStructure {
  schema_name: string | null;
  name: string;
  kind: ObjectKind;
  columns: ColumnInfo[];
  primary_key: string[];
  indexes: IndexInfo[];
  foreign_keys: ForeignKeyInfo[];
  constraints: ConstraintInfo[];
  triggers: TriggerInfo[];
  referenced_by: ForeignKeyInfo[];
  comment: string | null;
  row_estimate: number | null;
  total_size_bytes: number | null;
  view_definition: string | null;
}

export interface CatalogTable {
  schema_name: string | null;
  name: string;
  kind: ObjectKind;
  columns: [string, string][];
}

export type FilterOp =
  | "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "not_contains" | "starts_with" | "ends_with"
  | "is_null" | "not_null" | "in" | "not_in";

export interface SortSpec {
  column: string;
  direction: "asc" | "desc";
}

export interface FilterSpec {
  column: string;
  op: FilterOp;
  value?: unknown;
}

export interface DataRequest {
  schema_name: string | null;
  table: string;
  page: number;
  page_size: number;
  sort: SortSpec[];
  filters: FilterSpec[];
  filter_mode: "and" | "or";
  search: string | null;
  with_total?: boolean;
}

export type CellValue = string | number | boolean | null | Record<string, unknown> | unknown[];

export interface DataPage {
  columns: ColumnInfo[];
  rows: CellValue[][];
  total: number | null;
  total_is_estimate: boolean;
  page: number;
  page_size: number;
  primary_key: string[];
  editable: boolean;
  sql: string;
  duration_ms: number;
}

export interface MutationResult {
  affected: number;
  statements: string[];
}

export interface ResultColumn {
  name: string;
  category: TypeCategory;
  data_type: string | null;
}

export interface ResultSet {
  statement: string;
  columns: ResultColumn[];
  rows: CellValue[][];
  row_count: number | null;
  truncated: boolean;
  returns_rows: boolean;
  duration_ms: number;
  error: string | null;
  notices: string[];
}

export interface ExecuteResult {
  query_id: string;
  results: ResultSet[];
  duration_ms: number;
  status: "success" | "error" | "cancelled";
  history_id: number;
}

export interface HistoryItem {
  id: number;
  connection_id: string | null;
  connection_name: string | null;
  database: string | null;
  sql: string;
  status: "success" | "error" | "cancelled";
  error: string | null;
  duration_ms: number;
  rows: number | null;
  pinned: boolean;
  executed_at: string;
}

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  description: string | null;
  connection_id: string | null;
  is_snippet: boolean;
  created_at: string;
  updated_at: string;
}

export interface MetricValue<T = unknown> {
  available: boolean;
  value: T;
  note: string | null;
}

export interface DashboardData {
  engine: Engine;
  version: string;
  database: string | null;
  database_size_bytes: MetricValue<number>;
  table_count: MetricValue<number>;
  schema_count: MetricValue<number>;
  active_connections: MetricValue<number>;
  largest_tables: { schema_name: string | null; name: string; total_bytes: number | null; table_bytes: number | null; index_bytes: number | null; row_estimate: number | null }[];
  largest_indexes: { schema_name: string | null; table: string; name: string; size_bytes: number | null }[];
  recent_queries: MetricValue<{ query: string; calls: number | null; total_ms: number | null; mean_ms: number | null; rows: number | null }[] | null>;
  insights: { label: string; value: unknown; note?: string | null; level?: "ok" | "warn"; format?: "bytes" }[];
  latency_ms: number;
}

export interface AuditEntry {
  id: number;
  username: string | null;
  action: string;
  connection_id: string | null;
  target: string | null;
  details: Record<string, unknown>;
  ip: string | null;
  created_at: string;
}

// ---- schema changes

export type FkAction = "NO ACTION" | "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT";

export interface ColumnDef {
  name: string;
  type: string;
  nullable: boolean;
  default?: string | null;
  primary_key?: boolean;
  auto_increment?: boolean;
  unique?: boolean;
  comment?: string | null;
}

export type SchemaOp =
  | { op: "create_table"; columns: ColumnDef[]; if_not_exists?: boolean }
  | { op: "add_column"; column: ColumnDef }
  | { op: "drop_column"; column: string }
  | { op: "rename_column"; column: string; new_name: string }
  | { op: "alter_column"; column: string; type?: string | null; nullable?: boolean | null; default?: string | null; drop_default?: boolean }
  | { op: "rename_table"; new_name: string }
  | { op: "drop_table"; cascade?: boolean; kind?: "table" | "view" | "materialized_view" }
  | { op: "truncate_table" }
  | { op: "create_index"; name: string; columns: string[]; unique?: boolean }
  | { op: "drop_index"; name: string }
  | { op: "add_foreign_key"; name: string; columns: string[]; ref_schema?: string | null; ref_table: string; ref_columns: string[]; on_delete: FkAction; on_update: FkAction }
  | { op: "add_unique"; name: string; columns: string[] }
  | { op: "add_check"; name: string; expression: string }
  | { op: "drop_constraint"; name: string; constraint_type: "foreign_key" | "unique" | "check" | "primary_key" };

export interface SchemaChange {
  schema_name: string | null;
  table: string;
  operations: SchemaOp[];
}

export interface SchemaPreview {
  statements: string[];
  destructive: boolean;
  transactional: boolean;
}

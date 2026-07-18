---
name: sqlite3-node-integration
description: Set up and integrate SQLite3 databases into Node.js projects using better-sqlite3. Use when asked to add SQLite to a Node project, set up a local database, create database migrations, wire up better-sqlite3, or scaffold a repository pattern with SQLite. Covers initialization, migration system, repository pattern, pragmas, and graceful shutdown.
---

# SQLite3 Node.js Integration

Set up a production-ready SQLite3 database layer in a Node.js project using `better-sqlite3`.

## Step 1: Add Dependencies

Install the required packages:

```bash
npm install better-sqlite3 ulid
npm install -D @types/better-sqlite3
```

For pnpm projects, use `pnpm add better-sqlite3 ulid` and `pnpm add -D @types/better-sqlite3`.

## Step 2: Create the Database Wrapper

Create a `db.ts` file that wraps `better-sqlite3` with these responsibilities:

### Constructor

Accept `dbPath` and `migrationsDir`.

### `init()` — bootstrap the database

1. Create the DB file if missing (including parent directories).
2. Open the database with `new SqliteDB(this.dbPath, {})`.
3. Run **persistent pragmas** (survive connection lifetime):
   - `PRAGMA journal_mode=WAL`
4. Create a `migrations` tracking table if it does not exist:
   ```sql
   CREATE TABLE IF NOT EXISTS migrations (
     id INTEGER PRIMARY KEY,
     applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
     name TEXT NOT NULL,
     up TEXT NOT NULL,
     down TEXT
   );
   ```
5. Run **runtime pragmas** (per-connection):
   - `PRAGMA busy_timeout=5000`
   - `PRAGMA synchronous=NORMAL`
   - `PRAGMA foreign_keys=ON`
   - `PRAGMA cache_size=2000`
   - `PRAGMA temp_store=MEMORY`

### Query Methods

Expose thin wrappers around better-sqlite3 prepared statements:

| Method | Return | Use for |
|--------|--------|---------|
| `queryFirst<T>(sql, ...params)` | `T \| null` | `SELECT ... LIMIT 1` |
| `queryAll<T>(sql, ...params)` | `T[]` | `SELECT ...` |
| `execute(sql, ...params)` | `{ changedRowCount, lastInsertRowid }` | `INSERT`, `UPDATE`, `DELETE` |

Use `DBQueryParam = number \| string \| null` for parameters.

### Migration Methods

| Method | Behavior |
|--------|----------|
| `migrateUp()` | Apply the next pending migration (one at a time). |
| `migrateDown()` | Roll back the most recent migration using its `down` SQL. |
| `generateMigrationFile(name)` | Create a new `.sql` file with the next 7-digit zero-padded ID. |
| `isPendingMigration()` | Return `true` if unapplied migrations exist. |

### `close()`

Call `dbInstance.close()` to release the connection.

## Step 3: Migration File Format

Each migration lives in `migrationsDir` as `{7-digit-id}_{snake_case_name}.sql`.

Use the exact separator format:

```sql
-- @migration:up
-- Write your up migration here

-- @migration:down
-- Write your down migration here
```

Example:

```sql
-- @migration:up
CREATE TABLE IF NOT EXISTS User (
  user_id          TEXT PRIMARY KEY,
  user_name        TEXT NOT NULL,
  user_email       TEXT NOT NULL,
  user_created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
  user_updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
  user_archived_at TEXT
);

CREATE INDEX IF NOT EXISTS idx__user__email ON User (user_email) WHERE user_archived_at IS NULL;

-- @migration:down
DROP INDEX IF EXISTS idx__user__email;
DROP TABLE IF EXISTS User;
```

## Step 4: Schema Conventions

Apply these conventions consistently. Reference the `sqlite3-best-practices` skill for full details.

| Rule | Example |
|------|---------|
| Table names | PascalCase, singular: `User`, `OrderItem` |
| Column names | `table_name_column_name`: `user_id`, `order_item_price` |
| Primary keys | ULID as `TEXT PRIMARY KEY` |
| Timestamps | `created_at`, `updated_at` as `TEXT` with ISO-8601 default via `strftime('%Y-%m-%dT%H:%M:%fZ')` |
| Soft delete | `archived_at` timestamp instead of boolean flags |
| Foreign keys | Enforced; use `ON DELETE` / `ON UPDATE` explicitly |
| JSON data | Store as `TEXT`; parse/stringify in the repository layer |
| Indexes | Named `idx__{table}__{columns}` |

## Step 5: Repository Pattern

Create one repository function per table. It receives the `ServerDB` instance and returns an object of async methods.

Example structure:

```ts
export function createUserRepository(db: ServerDB) {
  return {
    async getById(id: string): Promise<UserRecord | null> { ... },
    async create(input: CreateUserInput): Promise<UserRecord> { ... },
    async list(params: ListParams): Promise<UserRecord[]> { ... },
    async update(id: string, payload: UpdateUserInput): Promise<UserRecord | null> { ... },
    async archive(id: string): Promise<boolean> { ... },
  };
}
```

**Mapping rules:**
- Define a `UserRow` type with the exact DB column names.
- Define a `UserRecord` type with the domain names.
- Use a `mapRow(row: UserRow): UserRecord` function to convert columns to domain objects.
- Parse JSON `TEXT` columns in `mapRow` (never in the DB layer).
- Use `ulid()` for new IDs.
- After `INSERT`, re-fetch the row via `getById` to return the full record.
- Use soft delete (`UPDATE ... SET archived_at = ...`) instead of `DELETE`.

## Step 6: Wire into Application

### Configuration

Read DB path and migrations directory from environment variables. Resolve relative paths against the project root.

```ts
export type AppConfig = {
  db: {
    path: string;
    migrationsDirectory: string;
  };
};
```

### Server Integration

```ts
const db = createDB("local-sqlite", {
  dbPath: config.db.path,
  migrationsDir: config.db.migrationsDirectory,
});
await db.init();

// Auto-run pending migrations in production
if (process.env.NODE_ENV === "production") {
  while (await db.isPendingMigration()) {
    await db.migrateUp();
  }
}
```

### Graceful Shutdown

Close the DB connection during shutdown:

```ts
async function gracefulShutdown() {
  await db.close();
  server.close();
  process.exit(0);
}
process.on("SIGTERM", () => gracefulShutdown());
process.on("SIGINT", () => gracefulShutdown());
```

## Step 7: CLI Commands

Add npm scripts for migration management:

```json
{
  "scripts": {
    "migration:up": "node src/index.ts migration up",
    "migration:down": "node src/index.ts migration down",
    "migration:create": "node src/index.ts migration create"
  }
}
```

Wire the CLI entry point to parse arguments and delegate to the DB wrapper:

```ts
const [noun, action] = process.argv.slice(2);
if (noun === "migration") {
  switch (action) {
    case "create": await db.generateMigrationFile(name); break;
    case "up": await db.migrateUp(); break;
    case "down": await db.migrateDown(); break;
  }
}
```

## Validation Checklist

Before finishing:

- [ ] `better-sqlite3` and `ulid` are in dependencies; `@types/better-sqlite3` in devDependencies.
- [ ] `db.ts` exists with `init()`, `queryFirst()`, `queryAll()`, `execute()`, `migrateUp()`, `migrateDown()`, `generateMigrationFile()`, and `close()`.
- [ ] `migrations/` directory exists with at least one migration file.
- [ ] All tables follow the naming conventions (PascalCase, singular, snake_case prefixed columns).
- [ ] All tables have `created_at`, `updated_at`, and `archived_at` columns.
- [ ] All IDs are ULID `TEXT PRIMARY KEY`.
- [ ] Repositories map rows to domain records and handle JSON parse/stringify.
- [ ] DB is initialized before starting the server.
- [ ] Graceful shutdown closes the DB connection.
- [ ] Migration scripts are wired in `package.json`.

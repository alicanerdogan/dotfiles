---
name: sqlite3-best-practices
description: "Sqlite3 best practices. Use when you need to design a table schema or a query pattern if sqlite3 is involved."
---

# SQLite3 Best Practices

## DB schema conventions

- All table names: PascalCase and singular
- All column names: prefixed with snake_case version of table name
- All IDs: ULID (primary keys)
- All tables include: `created_at`, `updated_at`, `archived_at`
- Foreign key constraints enforced
- No boolean flag columns; use timestamps (e.g., `favorited_at`) or enum columns instead
- Use composite indexes for common query patterns
- Name indexes with `idx__{table}__{column1}_{column2}_...`

## Notes

- Feel free to use `TEXT` columns for storing JSON data for flexibility and keep in mind query patterns when using them. If you find yourself needing to query specific fields within JSON, consider normalizing that data into separate tables or using generated columns for indexing.

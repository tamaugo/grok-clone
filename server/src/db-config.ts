import { db } from './db.js';

/**
 * Schema additions for bot settings and memories.
 * Kept out of db.ts on purpose: everything here is idempotent (CREATE IF NOT EXISTS
 * and ALTERs guarded by a column check), so it is safe on old and new databases.
 */

function hasColumn(table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).some((c) => c.name === col);
}

function addColumn(table: string, col: string, ddl: string) {
  if (!hasColumn(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}

addColumn('skills', 'description', "TEXT NOT NULL DEFAULT ''");
addColumn('skills', 'updated_at', 'INTEGER');
/** 'chat' = saved by the bot's remember tool, 'learned' = extracted by consolidation. */
addColumn('memories', 'source', "TEXT NOT NULL DEFAULT 'chat'");

export const configSchemaReady = true;

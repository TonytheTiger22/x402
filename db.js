// Single shared sqlite connection for the whole app. audit-store.js and
// accounts-store.js both read/write the same audit.db file — they used to
// each open their own better-sqlite3 handle to it, which is harmless under
// WAL mode but is needless duplicate connection/cache overhead for no
// benefit, since both run in the same process. One handle, shared.

import Database from "better-sqlite3";

export const db = new Database(process.env.DB_PATH || "audit.db");
db.pragma("journal_mode = WAL");

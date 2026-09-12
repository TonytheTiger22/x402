CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS entities (
  id SERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  uid TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  entity_type TEXT,
  dob TEXT,
  nationality TEXT,
  program TEXT,
  UNIQUE(source, uid)
);

CREATE TABLE IF NOT EXISTS entity_aliases (
  id SERIAL PRIMARY KEY,
  entity_id INTEGER REFERENCES entities(id) ON DELETE CASCADE,
  alias_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS list_metadata (
  source TEXT PRIMARY KEY,
  list_version TEXT NOT NULL,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entities_name_trgm
  ON entities USING gin (canonical_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_aliases_name_trgm
  ON entity_aliases USING gin (alias_name gin_trgm_ops);

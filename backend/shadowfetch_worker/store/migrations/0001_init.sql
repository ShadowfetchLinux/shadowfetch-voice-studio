-- Shadowfetch Voice Studio schema v1. Audio lives on disk; rows hold metadata + paths.
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                 -- reference | other
  source TEXT NOT NULL,               -- import | recording
  original_name TEXT,
  original_path TEXT NOT NULL,        -- untouched copy of the import / master recording
  working_path TEXT,                  -- decoded once: float32 mono wav (engine agnostic)
  sha256 TEXT,
  format TEXT, codec TEXT,
  duration_s REAL, sample_rate INTEGER, channels INTEGER, bit_depth INTEGER, size_bytes INTEGER,
  stats_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS recordings (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  device_name TEXT, negotiated_json TEXT, script_id TEXT, take_number INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS voices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  language TEXT NOT NULL DEFAULT 'en',
  rights_confirmed INTEGER NOT NULL DEFAULT 0,
  rights_note TEXT,
  selected_reference_id TEXT,
  notes TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS voice_references (
  id TEXT PRIMARY KEY,
  voice_id TEXT NOT NULL REFERENCES voices(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  label TEXT,
  start_s REAL NOT NULL, end_s REAL NOT NULL,
  transcript TEXT NOT NULL DEFAULT '',
  transcript_source TEXT NOT NULL DEFAULT 'edited',   -- asr | edited
  transcript_confirmed INTEGER NOT NULL DEFAULT 0,
  asr_model TEXT,
  processing_json TEXT NOT NULL DEFAULT '[]',          -- ordered list of applied optional processing steps
  fingerprint TEXT,                                    -- sha256(asset sha + trim + transcript + processing)
  derived_json TEXT NOT NULL DEFAULT '{}',             -- engine_id -> {path, sample_rate, channels, duration_s}
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_refs_voice ON voice_references(voice_id);

CREATE TABLE IF NOT EXISTS prompt_cache (
  id TEXT PRIMARY KEY,
  reference_id TEXT NOT NULL REFERENCES voice_references(id) ON DELETE CASCADE,
  engine_id TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_prompt_lookup ON prompt_cache(reference_id, engine_id, model_revision, fingerprint);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  favorite INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  voice_id TEXT REFERENCES voices(id) ON DELETE SET NULL,
  reference_id TEXT REFERENCES voice_references(id) ON DELETE SET NULL,
  engine_id TEXT,
  language TEXT NOT NULL DEFAULT 'en',
  settings_json TEXT NOT NULL DEFAULT '{}',            -- engine controls + plan options + seed
  plan_version INTEGER NOT NULL DEFAULT 0,
  master_path TEXT, master_json TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS scripts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(project_id, version)
);

CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plan_version INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  paragraph INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  substitutions_json TEXT NOT NULL DEFAULT '[]',
  selected_take_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_segments_plan ON segments(project_id, plan_version, idx);

CREATE TABLE IF NOT EXISTS takes (
  id TEXT PRIMARY KEY,
  segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  engine_id TEXT NOT NULL,
  model_revision TEXT,
  reference_id TEXT,
  path TEXT NOT NULL,
  sample_rate INTEGER, duration_s REAL,
  seed INTEGER,
  settings_json TEXT NOT NULL DEFAULT '{}',
  label TEXT,
  status TEXT NOT NULL DEFAULT 'ok',                   -- ok | failed
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_takes_segment ON takes(segment_id);

CREATE TABLE IF NOT EXISTS exports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL, format TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}', probe_json TEXT, loudness_json TEXT, size_bytes INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  revision_pinned TEXT,
  revision_installed TEXT,
  path TEXT,
  state TEXT NOT NULL DEFAULT 'missing',               -- missing | downloading | installed | error
  size_bytes INTEGER,
  error TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

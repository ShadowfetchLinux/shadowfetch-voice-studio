-- v2: the Speak screen. Additive only — v1 databases keep every row.
-- Takes remember the exact reference audio + language they were made with, so a re-plan can reuse a take only
-- when it still matches the voice that is selected now (NULL on v1 takes = unknown = never reused by Speak).
ALTER TABLE takes ADD COLUMN reference_fingerprint TEXT;
ALTER TABLE takes ADD COLUMN language TEXT;

-- Finished Speak results. Each row owns its own audio file (a copy of the assembled master), so re-speaking never
-- overwrites what the Recent list plays.
CREATE TABLE IF NOT EXISTS speak_history (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  voice_id TEXT,
  voice_name TEXT,
  engine_id TEXT,
  path TEXT NOT NULL,
  duration_s REAL,
  sample_rate INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_speak_history_created ON speak_history(project_id, created_at);

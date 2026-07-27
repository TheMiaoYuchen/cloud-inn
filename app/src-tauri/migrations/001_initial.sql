CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS saves (
  save_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  ruleset_version TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 0),
  phase TEXT NOT NULL CHECK(phase IN ('design','floor','ready','open')),
  current_day INTEGER NOT NULL CHECK(current_day >= 0),
  cash_cents INTEGER NOT NULL CHECK(cash_cents >= 0),
  rate_cents INTEGER NOT NULL CHECK(rate_cents > 0),
  phase2_json TEXT,
  latest_report_json TEXT,
  phase4_json TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS room_blueprints (
  save_id TEXT PRIMARY KEY REFERENCES saves(save_id) ON DELETE CASCADE,
  blueprint_id TEXT NOT NULL,
  name TEXT NOT NULL,
  columns_count INTEGER NOT NULL CHECK(columns_count > 0),
  rows_count INTEGER NOT NULL CHECK(rows_count > 0),
  cells_json TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  visual_json TEXT NOT NULL
  ,UNIQUE(save_id, blueprint_id)
);
CREATE TABLE IF NOT EXISTS room_instances (
  save_id TEXT NOT NULL REFERENCES saves(save_id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  blueprint_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  committed_build_cost_cents INTEGER NOT NULL CHECK(committed_build_cost_cents >= 0),
  PRIMARY KEY(save_id, instance_id),
  UNIQUE(save_id, slot_id),
  UNIQUE(save_id, ordinal),
  FOREIGN KEY(save_id, blueprint_id) REFERENCES room_blueprints(save_id, blueprint_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS daily_reports (
  save_id TEXT NOT NULL REFERENCES saves(save_id) ON DELETE CASCADE,
  game_day INTEGER NOT NULL CHECK(game_day >= 0),
  report_json TEXT NOT NULL,
  PRIMARY KEY(save_id, game_day)
);

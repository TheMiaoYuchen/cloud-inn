use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::PathBuf;

pub struct SaveRepository {
    root: PathBuf,
}

impl SaveRepository {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn load_game(&self, save_id: &str) -> Result<Option<Value>, String> {
        validate_save_id(save_id)?;
        let conn = self.open(save_id)?;
        let row = conn
            .query_row(
                "SELECT schema_version,ruleset_version,revision,phase,current_day,cash_cents,rate_cents,phase2_json,latest_report_json,operations_json,phase4_json FROM saves WHERE save_id=?1",
                [save_id],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?,
                        r.get::<_, String>(3)?, r.get::<_, i64>(4)?, r.get::<_, i64>(5)?,
                        r.get::<_, i64>(6)?, r.get::<_, Option<String>>(7)?,
                        r.get::<_, Option<String>>(8)?,
                        r.get::<_, Option<String>>(9)?,
                        r.get::<_, Option<String>>(10)?,
                    ))
                },
            )
            .optional()
            .map_err(db_err)?;
        let Some((
            schema,
            ruleset,
            revision,
            phase,
            day,
            cash,
            rate,
            phase2,
            latest,
            operations,
            phase4,
        )) = row
        else {
            return Ok(None);
        };
        let blueprint = conn
            .query_row("SELECT blueprint_id,name,columns_count,rows_count,cells_json,metrics_json,visual_json,openings_json FROM room_blueprints WHERE save_id=?1", [save_id], |r| {
                let mut blueprint = json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"columns":r.get::<_,i64>(2)?,"rows":r.get::<_,i64>(3)?,"cells":serde_json::from_str::<Value>(&r.get::<_,String>(4)?).map_err(|_| rusqlite::Error::InvalidQuery)?,"metrics":serde_json::from_str::<Value>(&r.get::<_,String>(5)?).map_err(|_| rusqlite::Error::InvalidQuery)?,"visual":serde_json::from_str::<Value>(&r.get::<_,String>(6)?).map_err(|_| rusqlite::Error::InvalidQuery)?});
                if let Some(raw) = r.get::<_,Option<String>>(7)? {
                    blueprint["openings"] = serde_json::from_str::<Value>(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
                }
                Ok(blueprint)
            }).optional().map_err(db_err)?;
        let mut rooms = Vec::new();
        let mut stmt = conn.prepare("SELECT instance_id,slot_id,blueprint_id,committed_build_cost_cents FROM room_instances WHERE save_id=?1 ORDER BY ordinal").map_err(db_err)?;
        let rows = stmt.query_map([save_id], |r| Ok(json!({"id":r.get::<_,String>(0)?,"slotId":r.get::<_,String>(1)?,"roomBlueprintId":r.get::<_,String>(2)?,"committedBuildCostCents":r.get::<_,i64>(3)?}))).map_err(db_err)?;
        for room in rows {
            rooms.push(room.map_err(db_err)?);
        }
        let mut reports = Vec::new();
        let mut stmt = conn
            .prepare("SELECT report_json FROM daily_reports WHERE save_id=?1 ORDER BY game_day")
            .map_err(db_err)?;
        let rows = stmt
            .query_map([save_id], |r| r.get::<_, String>(0))
            .map_err(db_err)?;
        for report in rows {
            reports.push(parse_json(report.map_err(db_err)?)?);
        }
        let latest_value = latest.map(parse_json).transpose()?;
        let mut game = json!({"schemaVersion":schema,"rulesetVersion":ruleset,"saveId":save_id,"revision":revision,"phase":phase,"currentDay":day,"cashCents":cash,"rateCents":rate,"roomBlueprint":blueprint,"floor":{"id":"prototype-floor","rooms":rooms},"reports":reports,"latestReport":latest_value});
        if let Some(raw) = phase2 {
            game["phase2"] = parse_json(raw)?;
        }
        if let Some(raw) = operations {
            game["operations"] = parse_json(raw)?;
        }
        if let Some(raw) = phase4 {
            game["phase4"] = parse_phase4_json(raw)?;
        }
        validate_game(&game)?;
        Ok(Some(game))
    }

    pub fn commit_game(&self, expected_revision: i64, game: Value) -> Result<(), String> {
        if expected_revision < 0 {
            return Err("存档版本无效".to_string());
        }
        let fields = validate_game(&game)?;
        let save_id = fields.save_id.clone();
        let mut conn = self.open(&save_id)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_err)?;
        let current: Option<i64> = tx
            .query_row(
                "SELECT revision FROM saves WHERE save_id=?1",
                [&save_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        let current = current.unwrap_or(0);
        let next_revision = expected_revision
            .checked_add(1)
            .ok_or_else(|| "存档版本无效".to_string())?;
        if current != expected_revision || fields.revision != next_revision {
            return Err("存档已更新，请重新加载".to_string());
        }
        tx.execute("INSERT INTO saves(save_id,schema_version,ruleset_version,revision,phase,current_day,cash_cents,rate_cents,phase2_json,latest_report_json,operations_json,phase4_json,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,datetime('now')) ON CONFLICT(save_id) DO UPDATE SET schema_version=excluded.schema_version,ruleset_version=excluded.ruleset_version,revision=excluded.revision,phase=excluded.phase,current_day=excluded.current_day,cash_cents=excluded.cash_cents,rate_cents=excluded.rate_cents,phase2_json=excluded.phase2_json,latest_report_json=excluded.latest_report_json,operations_json=excluded.operations_json,phase4_json=excluded.phase4_json,updated_at=excluded.updated_at", params![save_id, fields.schema_version, fields.ruleset, fields.revision, fields.phase, fields.current_day, fields.cash_cents, fields.rate_cents, fields.phase2, fields.latest_report, fields.operations, fields.phase4]).map_err(db_err)?;
        tx.execute("DELETE FROM room_instances WHERE save_id=?1", [&save_id])
            .map_err(db_err)?;
        tx.execute("DELETE FROM room_blueprints WHERE save_id=?1", [&save_id])
            .map_err(db_err)?;
        if let Some(bp) = fields.blueprint {
            tx.execute("INSERT INTO room_blueprints(save_id,blueprint_id,name,columns_count,rows_count,cells_json,metrics_json,visual_json,openings_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![save_id,bp.id,bp.name,bp.columns,bp.rows,bp.cells,bp.metrics,bp.visual,bp.openings]).map_err(db_err)?;
        }
        for (ordinal, room) in fields.rooms.into_iter().enumerate() {
            tx.execute("INSERT INTO room_instances(save_id,instance_id,slot_id,blueprint_id,ordinal,committed_build_cost_cents) VALUES(?1,?2,?3,?4,?5,?6)", params![save_id,room.id,room.slot,room.blueprint,ordinal as i64,room.cost]).map_err(db_err)?;
        }
        tx.execute("DELETE FROM daily_reports WHERE save_id=?1", [&save_id])
            .map_err(db_err)?;
        for (day, report) in fields.reports {
            tx.execute(
                "INSERT INTO daily_reports(save_id,game_day,report_json) VALUES(?1,?2,?3)",
                params![save_id, day, report],
            )
            .map_err(db_err)?;
        }
        tx.commit().map_err(db_err)
    }

    fn db_path(&self, save_id: &str) -> PathBuf {
        self.root.join("saves").join(save_id).join("save.sqlite3")
    }
    fn open(&self, save_id: &str) -> Result<Connection, String> {
        let path = self.db_path(save_id);
        fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        let mut conn = Connection::open(path).map_err(db_err)?;
        conn.busy_timeout(std::time::Duration::from_millis(5000))
            .map_err(db_err)?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(db_err)?;
        retry_busy(|| conn.pragma_update(None, "journal_mode", "WAL"))?;
        conn.pragma_update(None, "synchronous", "FULL")
            .map_err(db_err)?;
        conn.execute_batch(include_str!("../migrations/001_initial.sql"))
            .map_err(db_err)?;
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1,datetime('now'))",
            [],
        )
        .map_err(db_err)?;
        migrate_legacy(&mut conn)?;
        migrate_phase2(&mut conn)?;
        migrate_blueprint_openings(&mut conn)?;
        migrate_operations(&mut conn)?;
        migrate_phase4(&mut conn)?;
        Ok(conn)
    }
}

fn retry_busy<T>(mut operation: impl FnMut() -> rusqlite::Result<T>) -> Result<T, String> {
    for attempt in 0..5 {
        match operation() {
            Ok(value) => return Ok(value),
            Err(rusqlite::Error::SqliteFailure(error, _))
                if matches!(
                    error.code,
                    rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
                ) && attempt < 4 =>
            {
                std::thread::sleep(std::time::Duration::from_millis(10 * (attempt + 1)));
            }
            Err(error) => return Err(db_err(error)),
        }
    }
    unreachable!()
}

fn migrate_legacy(conn: &mut Connection) -> Result<(), String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_err)?;
    let has_ordinal: bool = tx
        .prepare("SELECT 1 FROM pragma_table_info('room_instances') WHERE name='ordinal'")
        .map_err(db_err)?
        .exists([])
        .map_err(db_err)?;
    let has_v2: bool = tx
        .query_row(
            "SELECT count(*) FROM schema_migrations WHERE version=2",
            [],
            |r| r.get::<_, i64>(0),
        )
        .map_err(db_err)?
        > 0;
    if has_ordinal && has_v2 {
        return tx.commit().map_err(db_err);
    }
    if !has_ordinal {
        tx.execute_batch("ALTER TABLE room_instances RENAME TO room_instances_legacy; CREATE UNIQUE INDEX IF NOT EXISTS room_blueprints_save_blueprint ON room_blueprints(save_id, blueprint_id); CREATE TABLE room_instances (save_id TEXT NOT NULL REFERENCES saves(save_id) ON DELETE CASCADE, instance_id TEXT NOT NULL, slot_id TEXT NOT NULL, blueprint_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal >= 0), committed_build_cost_cents INTEGER NOT NULL CHECK(committed_build_cost_cents >= 0), PRIMARY KEY(save_id, instance_id), UNIQUE(save_id, slot_id), UNIQUE(save_id, ordinal), FOREIGN KEY(save_id, blueprint_id) REFERENCES room_blueprints(save_id, blueprint_id) ON DELETE CASCADE); INSERT INTO room_instances(save_id,instance_id,slot_id,blueprint_id,ordinal,committed_build_cost_cents) SELECT save_id,instance_id,slot_id,blueprint_id,ROW_NUMBER() OVER (PARTITION BY save_id ORDER BY rowid)-1,committed_build_cost_cents FROM room_instances_legacy; DROP TABLE room_instances_legacy;").map_err(db_err)?;
    }
    tx.execute_batch("CREATE UNIQUE INDEX IF NOT EXISTS room_blueprints_save_blueprint ON room_blueprints(save_id, blueprint_id);").map_err(db_err)?;
    tx.execute(
        "INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(2,datetime('now'))",
        [],
    )
    .map_err(db_err)?;
    tx.commit().map_err(db_err)
}

fn migrate_phase2(conn: &mut Connection) -> Result<(), String> {
    let has_phase2: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('saves') WHERE name='phase2_json'")
        .map_err(db_err)?
        .exists([])
        .map_err(db_err)?;
    if !has_phase2 {
        conn.execute("ALTER TABLE saves ADD COLUMN phase2_json TEXT", [])
            .map_err(db_err)?;
    }
    conn.execute(
        "INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(3,datetime('now'))",
        [],
    )
    .map_err(db_err)?;
    Ok(())
}

fn migrate_blueprint_openings(conn: &mut Connection) -> Result<(), String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_err)?;
    let has_openings: bool = tx
        .prepare("SELECT 1 FROM pragma_table_info('room_blueprints') WHERE name='openings_json'")
        .map_err(db_err)?
        .exists([])
        .map_err(db_err)?;
    if !has_openings {
        tx.execute(
            "ALTER TABLE room_blueprints ADD COLUMN openings_json TEXT",
            [],
        )
        .map_err(db_err)?;
    }
    tx.execute(
        "INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(4,datetime('now'))",
        [],
    )
    .map_err(db_err)?;
    tx.commit().map_err(db_err)
}

fn migrate_operations(conn: &mut Connection) -> Result<(), String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_err)?;
    let has_operations = tx
        .prepare("SELECT 1 FROM pragma_table_info('saves') WHERE name='operations_json'")
        .map_err(db_err)?
        .exists([])
        .map_err(db_err)?;
    if !has_operations {
        tx.execute("ALTER TABLE saves ADD COLUMN operations_json TEXT", [])
            .map_err(db_err)?;
    }
    tx.execute(
        "INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(5,datetime('now'))",
        [],
    )
    .map_err(db_err)?;
    tx.commit().map_err(db_err)
}

fn migrate_phase4(conn: &mut Connection) -> Result<(), String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_err)?;
    let has_phase4 = tx
        .prepare("SELECT 1 FROM pragma_table_info('saves') WHERE name='phase4_json'")
        .map_err(db_err)?
        .exists([])
        .map_err(db_err)?;
    if !has_phase4 {
        tx.execute("ALTER TABLE saves ADD COLUMN phase4_json TEXT", [])
            .map_err(db_err)?;
    }
    tx.execute(
        "INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(6,datetime('now'))",
        [],
    )
    .map_err(db_err)?;
    tx.commit().map_err(db_err)
}

fn db_err(e: rusqlite::Error) -> String {
    format!("数据库操作失败: {e}")
}
fn parse_json(s: String) -> Result<Value, String> {
    serde_json::from_str(&s).map_err(|_| "存档数据损坏".to_string())
}
fn parse_phase4_json(s: String) -> Result<Value, String> {
    if s.len() > PHASE4_MAX_JSON_BYTES {
        return Err(phase4_error("JSON超过大小限制"));
    }
    serde_json::from_str(&s).map_err(|_| phase4_error("JSON结构无效"))
}
fn validate_save_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("存档标识无效".into());
    }
    Ok(())
}
fn obj<'a>(v: &'a Value, k: &str) -> Result<&'a Value, String> {
    v.get(k).ok_or_else(|| "存档数据损坏".into())
}
fn strv(v: &Value, k: &str) -> Result<String, String> {
    obj(v, k)?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "存档数据损坏".into())
}
fn intv(v: &Value, k: &str, min: i64, positive: bool) -> Result<i64, String> {
    let n = obj(v, k)?
        .as_i64()
        .ok_or_else(|| "存档数据损坏".to_string())?;
    if n < min || (positive && n <= 0) {
        Err("存档数据损坏".into())
    } else {
        Ok(n)
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct Point {
    x: i64,
    y: i64,
}

#[derive(Clone, Copy)]
struct Footprint {
    width: i64,
    height: i64,
}

#[derive(Clone, Copy)]
struct SlotGeometry {
    width: i64,
    height: i64,
}

#[derive(Clone, Copy)]
struct Rectangle {
    anchor: Point,
    width: i64,
    height: i64,
}

impl Rectangle {
    fn contains(self, point: Point) -> bool {
        point.x >= self.anchor.x
            && point.x - self.anchor.x < self.width
            && point.y >= self.anchor.y
            && point.y - self.anchor.y < self.height
    }

    fn overlaps(self, other: Self) -> bool {
        self.anchor.x < other.anchor.x + other.width
            && other.anchor.x < self.anchor.x + self.width
            && self.anchor.y < other.anchor.y + other.height
            && other.anchor.y < self.anchor.y + self.height
    }

    fn adjacent_to(self, point: Point) -> bool {
        (point.x == self.anchor.x - 1
            && point.y >= self.anchor.y
            && point.y - self.anchor.y < self.height)
            || (point.x == self.anchor.x + self.width
                && point.y >= self.anchor.y
                && point.y - self.anchor.y < self.height)
            || (point.y == self.anchor.y - 1
                && point.x >= self.anchor.x
                && point.x - self.anchor.x < self.width)
            || (point.y == self.anchor.y + self.height
                && point.x >= self.anchor.x
                && point.x - self.anchor.x < self.width)
    }
}

fn array<'a>(value: &'a Value, key: &str) -> Result<&'a Vec<Value>, String> {
    obj(value, key)?
        .as_array()
        .ok_or_else(|| "存档数据损坏".to_string())
}

fn parse_point(value: &Value, width: i64, height: i64) -> Result<Point, String> {
    let point = Point {
        x: intv(value, "x", 0, false)?,
        y: intv(value, "y", 0, false)?,
    };
    if point.x >= width || point.y >= height {
        return Err("存档数据损坏".into());
    }
    Ok(point)
}

fn neighbors(point: Point) -> [Point; 4] {
    [
        Point {
            x: point.x - 1,
            y: point.y,
        },
        Point {
            x: point.x + 1,
            y: point.y,
        },
        Point {
            x: point.x,
            y: point.y - 1,
        },
        Point {
            x: point.x,
            y: point.y + 1,
        },
    ]
}

fn is_connected(points: &HashSet<Point>) -> bool {
    let Some(start) = points.iter().next().copied() else {
        return false;
    };
    let mut seen = HashSet::from([start]);
    let mut queue = VecDeque::from([start]);
    while let Some(current) = queue.pop_front() {
        for next in neighbors(current) {
            if points.contains(&next) && seen.insert(next) {
                queue.push_back(next);
            }
        }
    }
    seen.len() == points.len()
}

fn validate_metrics(value: &Value, cell_count: usize) -> Result<(), String> {
    let area = obj(value, "areaSquareMeters")?
        .as_f64()
        .filter(|number| number.is_finite() && *number > 0.0)
        .ok_or_else(|| "存档数据损坏".to_string())?;
    let expected_area = cell_count as f64 * 0.25;
    let build_cost = intv(value, "buildCostCents", 0, false)?;
    let suggested_rate = intv(value, "suggestedRateCents", 0, true)?;
    let business_fit = intv(value, "businessFitBps", 0, false)?;
    let area_delta_quarters = (96_i64 - cell_count as i64).abs();
    let expected_fit = ((17_000 - area_delta_quarters * 125 + 1) / 2).clamp(0, 10_000);
    if (area - expected_area).abs() > f64::EPSILON
        || build_cost != 2_000_000 + 100_000 * cell_count as i64
        || suggested_rate != 32_000 + 500 * cell_count as i64
        || business_fit != expected_fit
    {
        return Err("存档数据损坏".into());
    }
    Ok(())
}

fn validate_cells(
    value: &Value,
    columns: i64,
    rows: i64,
) -> Result<(HashSet<Point>, Footprint), String> {
    let cells = value
        .as_array()
        .filter(|cells| !cells.is_empty())
        .ok_or_else(|| "存档数据损坏".to_string())?;
    let mut points = HashSet::new();
    let mut zones = HashSet::new();
    for cell in cells {
        let point = parse_point(cell, columns, rows)?;
        let zone = strv(cell, "zone")?;
        if !["bedroom", "bathroom"].contains(&zone.as_str()) || !points.insert(point) {
            return Err("存档数据损坏".into());
        }
        zones.insert(zone);
    }
    if !zones.contains("bedroom") || !zones.contains("bathroom") || !is_connected(&points) {
        return Err("存档数据损坏".into());
    }
    let min_x = points.iter().map(|point| point.x).min().unwrap();
    let max_x = points.iter().map(|point| point.x).max().unwrap();
    let min_y = points.iter().map(|point| point.y).min().unwrap();
    let max_y = points.iter().map(|point| point.y).max().unwrap();
    Ok((
        points,
        Footprint {
            width: max_x - min_x + 1,
            height: max_y - min_y + 1,
        },
    ))
}

fn validate_openings(value: &Value, cells: &HashSet<Point>) -> Result<(), String> {
    let mut seen = HashSet::new();
    for (key, kind) in [("walls", "wall"), ("doors", "door"), ("windows", "window")] {
        for opening in array(value, key)? {
            let point = Point {
                x: intv(opening, "x", 0, false)?,
                y: intv(opening, "y", 0, false)?,
            };
            let side = strv(opening, "side")?;
            if !["north", "east", "south", "west"].contains(&side.as_str()) {
                return Err("存档数据损坏".into());
            }
            if let Some(value_kind) = opening.get("kind") {
                if value_kind.as_str() != Some(kind) {
                    return Err("存档数据损坏".into());
                }
            }
            let outside = match side.as_str() {
                "north" => Point {
                    x: point.x,
                    y: point.y - 1,
                },
                "east" => Point {
                    x: point.x + 1,
                    y: point.y,
                },
                "south" => Point {
                    x: point.x,
                    y: point.y + 1,
                },
                "west" => Point {
                    x: point.x - 1,
                    y: point.y,
                },
                _ => unreachable!(),
            };
            if !cells.contains(&point) || cells.contains(&outside) || !seen.insert((point, side)) {
                return Err("存档数据损坏".into());
            }
        }
    }
    Ok(())
}

fn validate_room(
    value: &Value,
    columns: i64,
    rows: i64,
    require_visual: bool,
) -> Result<Footprint, String> {
    strv(value, "id")?;
    strv(value, "name")?;
    let (cells, footprint) = validate_cells(obj(value, "cells")?, columns, rows)?;
    validate_metrics(obj(value, "metrics")?, cells.len())?;
    validate_openings(obj(value, "openings")?, &cells)?;
    if require_visual || value.get("visual").is_some() {
        validate_visual_tree(obj(value, "visual")?)?;
    }
    Ok(footprint)
}

fn parse_template_points(
    template: &Value,
    key: &str,
    width: i64,
    height: i64,
) -> Result<HashSet<Point>, String> {
    let values = array(template, key)?;
    if values.is_empty() {
        return Err("存档数据损坏".into());
    }
    let mut points = HashSet::new();
    for value in values {
        if !points.insert(parse_point(value, width, height)?) {
            return Err("存档数据损坏".into());
        }
    }
    Ok(points)
}

fn validate_corridor_template(value: &Value) -> Result<HashMap<String, SlotGeometry>, String> {
    strv(value, "id")?;
    strv(value, "name")?;
    let width = intv(value, "width", 1, true)?;
    let height = intv(value, "height", 1, true)?;
    let core = parse_template_points(value, "core", width, height)?;
    let corridor = parse_template_points(value, "corridor", width, height)?;
    let entrances = parse_template_points(value, "entrances", width, height)?;
    if !core.is_disjoint(&corridor) || !is_connected(&corridor) {
        return Err("存档数据损坏".into());
    }
    let core_and_entrances = core
        .iter()
        .chain(&entrances)
        .copied()
        .collect::<HashSet<_>>();
    let entrance_bridges = entrances.iter().any(|entrance| {
        neighbors(*entrance)
            .iter()
            .any(|point| corridor.contains(point))
            && reachable_set(*entrance, &core_and_entrances)
                .iter()
                .any(|point| core.contains(point))
    });
    if !entrance_bridges {
        return Err("存档数据损坏".into());
    }

    let mut slots = HashMap::new();
    let mut slot_rectangles = Vec::new();
    for slot in array(value, "slots")? {
        let id = strv(slot, "id")?;
        let slot_width = intv(slot, "width", 1, true)?;
        let slot_height = intv(slot, "height", 1, true)?;
        let anchor = parse_point(obj(slot, "anchor")?, width, height)?;
        if slot_width > width - anchor.x
            || slot_height > height - anchor.y
            || slots
                .insert(
                    id,
                    SlotGeometry {
                        width: slot_width,
                        height: slot_height,
                    },
                )
                .is_some()
        {
            return Err("存档数据损坏".into());
        }
        let rectangle = Rectangle {
            anchor,
            width: slot_width,
            height: slot_height,
        };
        if core
            .iter()
            .chain(&corridor)
            .any(|point| rectangle.contains(*point))
            || slot_rectangles
                .iter()
                .any(|existing| rectangle.overlaps(*existing))
            || !corridor.iter().any(|point| rectangle.adjacent_to(*point))
        {
            return Err("存档数据损坏".into());
        }
        slot_rectangles.push(rectangle);
    }
    Ok(slots)
}

fn reachable_set(start: Point, traversable: &HashSet<Point>) -> HashSet<Point> {
    let mut seen = HashSet::from([start]);
    let mut queue = VecDeque::from([start]);
    while let Some(current) = queue.pop_front() {
        for next in neighbors(current) {
            if traversable.contains(&next) && seen.insert(next) {
                queue.push_back(next);
            }
        }
    }
    seen
}

struct Fields {
    save_id: String,
    schema_version: i64,
    ruleset: String,
    revision: i64,
    phase: String,
    current_day: i64,
    cash_cents: i64,
    rate_cents: i64,
    latest_report: Option<String>,
    phase2: Option<String>,
    operations: Option<String>,
    phase4: Option<String>,
    blueprint: Option<Blueprint>,
    rooms: Vec<Room>,
    reports: Vec<(i64, String)>,
}
struct Blueprint {
    id: String,
    name: String,
    columns: i64,
    rows: i64,
    cells: String,
    metrics: String,
    visual: String,
    openings: Option<String>,
}
struct Room {
    id: String,
    slot: String,
    blueprint: String,
    cost: i64,
}

fn validate_game(g: &Value) -> Result<Fields, String> {
    let schema = intv(g, "schemaVersion", 1, false)?;
    if schema != 1 {
        return Err("存档数据损坏".into());
    }
    let save_id = strv(g, "saveId")?;
    validate_save_id(&save_id)?;
    let ruleset = strv(g, "rulesetVersion")?;
    let revision = intv(g, "revision", 0, false)?;
    let phase = strv(g, "phase")?;
    if !["design", "floor", "ready", "open"].contains(&phase.as_str()) {
        return Err("存档数据损坏".into());
    }
    let current_day = intv(g, "currentDay", 0, false)?;
    let cash_cents = intv(g, "cashCents", 0, false)?;
    let rate_cents = intv(g, "rateCents", 0, true)?;
    let phase2 = match g.get("phase2") {
        Some(Value::Null) | None => None,
        Some(value) => Some(validate_phase2(value)?),
    };
    let operations = match g.get("operations") {
        Some(Value::Null) | None => None,
        Some(value) => {
            validate_operations(value, current_day, cash_cents).map_err(|error| {
                if g.get("phase4").is_some() && error == "经营报告算术不一致" {
                    phase4_error(&error)
                } else {
                    error
                }
            })?;
            Some(serde_json::to_string(value).map_err(|_| "存档数据损坏".to_string())?)
        }
    };
    let phase4 = match g.get("phase4") {
        None => None,
        Some(value) => {
            validate_phase4(value, g)?;
            Some(serde_json::to_string(value).map_err(|_| "存档数据损坏".to_string())?)
        }
    };
    let latest_report = match g.get("latestReport") {
        Some(Value::Null) | None => None,
        Some(v) => {
            let latest_day = intv(v, "day", 1, true)?;
            if latest_day != current_day {
                return Err("存档数据损坏".into());
            }
            Some(serde_json::to_string(v).map_err(|_| "存档数据损坏".to_string())?)
        }
    };
    let blueprint = match g.get("roomBlueprint") {
        Some(Value::Null) | None => None,
        Some(v) => {
            let columns = intv(v, "columns", 1, true)?;
            let rows = intv(v, "rows", 1, true)?;
            let openings = match v.get("openings") {
                Some(Value::Null) | None => None,
                Some(openings) => {
                    let (cells, _) = validate_cells(obj(v, "cells")?, columns, rows)?;
                    validate_openings(openings, &cells)?;
                    Some(serde_json::to_string(openings).map_err(|_| "存档数据损坏".to_string())?)
                }
            };
            Some(Blueprint {
                id: strv(v, "id")?,
                name: strv(v, "name")?,
                columns,
                rows,
                cells: serde_json::to_string(obj(v, "cells")?)
                    .map_err(|_| "存档数据损坏".to_string())?,
                metrics: serde_json::to_string(obj(v, "metrics")?)
                    .map_err(|_| "存档数据损坏".to_string())?,
                visual: {
                    validate_visual_tree(obj(v, "visual")?)?;
                    serde_json::to_string(obj(v, "visual")?)
                }
                .map_err(|_| "存档数据损坏".to_string())?,
                openings,
            })
        }
    };
    let floor = obj(g, "floor")?;
    if strv(floor, "id")? != "prototype-floor" {
        return Err("存档数据损坏".into());
    }
    let mut rooms = Vec::new();
    let mut slots = HashSet::new();
    let mut instance_ids = HashSet::new();
    for v in obj(floor, "rooms")?
        .as_array()
        .ok_or_else(|| "存档数据损坏".to_string())?
    {
        let room = Room {
            id: strv(v, "id")?,
            slot: strv(v, "slotId")?,
            blueprint: strv(v, "roomBlueprintId")?,
            cost: intv(v, "committedBuildCostCents", 0, false)?,
        };
        let legacy_slot =
            ["slot-nw", "slot-ne", "slot-sw", "slot-se"].contains(&room.slot.as_str());
        let ring_slot = [
            "north-west",
            "north-east",
            "east-north",
            "east-south",
            "south-east",
            "south-west",
            "west-south",
            "west-north",
        ]
        .contains(&room.slot.as_str());
        if rooms.len() >= 8 || (!legacy_slot && !ring_slot) || !instance_ids.insert(room.id.clone())
        {
            return Err("存档数据损坏".into());
        }
        if !slots.insert(room.slot.clone()) {
            return Err("存档数据损坏".into());
        }
        if blueprint.as_ref().map(|bp| bp.id.as_str()) != Some(room.blueprint.as_str()) {
            return Err("存档数据损坏".into());
        }
        rooms.push(room);
    }
    let mut reports = Vec::new();
    let mut days = HashSet::new();
    let mut previous_day = 0;
    for v in obj(g, "reports")?
        .as_array()
        .ok_or_else(|| "存档数据损坏".to_string())?
    {
        let day = intv(v, "day", 1, true)?;
        if !days.insert(day) || day != previous_day + 1 {
            return Err("日报日期重复".into());
        }
        previous_day = day;
        reports.push((
            day,
            serde_json::to_string(v).map_err(|_| "存档数据损坏".to_string())?,
        ));
    }
    if current_day == 0 {
        if !reports.is_empty() || latest_report.is_some() {
            return Err("存档数据损坏".into());
        }
    } else if reports.len() as i64 != current_day
        || previous_day != current_day
        || latest_report.is_none()
    {
        return Err("存档数据损坏".into());
    }
    if matches!(phase.as_str(), "ready" | "open") && blueprint.is_none() {
        return Err("存档数据损坏".into());
    }
    Ok(Fields {
        save_id,
        schema_version: schema,
        ruleset,
        revision,
        phase,
        current_day,
        cash_cents,
        rate_cents,
        latest_report,
        phase2,
        operations,
        phase4,
        blueprint,
        rooms,
        reports,
    })
}

const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const PHASE4_STABLE_ID_MAX_LENGTH: usize = 96;
const PHASE4_MAX_JSON_BYTES: usize = 8 * 1024 * 1024;
const PHASE4_PUBLIC_SPACE_TYPES: [&str; 12] = [
    "sky-lobby",
    "all-day-dining",
    "chinese-restaurant",
    "bar",
    "executive-lounge",
    "spa",
    "pool",
    "gym",
    "ballroom",
    "meeting-room",
    "garden-terrace",
    "boutique",
];

fn phase4_error(detail: &str) -> String {
    format!("内容规模存档{detail}")
}

fn phase4_object<'a>(
    value: &'a Value,
    label: &str,
) -> Result<&'a serde_json::Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| phase4_error(&format!("{label}结构无效")))
}

fn phase4_array<'a>(value: &'a Value, label: &str) -> Result<&'a Vec<Value>, String> {
    value
        .as_array()
        .ok_or_else(|| phase4_error(&format!("{label}结构无效")))
}

fn phase4_field<'a>(
    object: &'a serde_json::Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<&'a Value, String> {
    object
        .get(key)
        .ok_or_else(|| phase4_error(&format!("{label}结构无效")))
}

fn phase4_stable_id<'a>(value: &'a Value, label: &str) -> Result<&'a str, String> {
    let id = value
        .as_str()
        .ok_or_else(|| phase4_error(&format!("{label}必须是稳定 ID")))?;
    let valid = !id.is_empty()
        && id.len() <= PHASE4_STABLE_ID_MAX_LENGTH
        && id.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (index > 0 && matches!(byte, b':' | b'-'))
        });
    if !valid {
        return Err(phase4_error(&format!("{label}必须是稳定 ID")));
    }
    Ok(id)
}

fn validate_phase4_money(value: &Value) -> Result<(), String> {
    let safe_integer = value
        .as_i64()
        .is_some_and(|money| (0..=JS_MAX_SAFE_INTEGER).contains(&money));
    let safe_float = value.as_f64().is_some_and(|money| {
        money.is_finite()
            && money.fract() == 0.0
            && (0.0..=JS_MAX_SAFE_INTEGER as f64).contains(&money)
    });
    if safe_integer || safe_float {
        Ok(())
    } else {
        Err(phase4_error("施工金额必须是安全整数"))
    }
}

fn validate_phase4_identity_record(value: &Value, label: &str) -> Result<(), String> {
    let definitions = phase4_object(value, label)?;
    let mut ids = HashSet::new();
    for (key, raw_definition) in definitions {
        phase4_stable_id(&Value::String(key.clone()), "记录键")?;
        let definition = phase4_object(raw_definition, label)?;
        let id = phase4_stable_id(
            phase4_field(definition, "id", &format!("{label}编号"))?,
            &format!("{label}编号"),
        )?;
        if !ids.insert(id) {
            return Err(phase4_error(&format!("{label}编号重复")));
        }
    }
    for (key, raw_definition) in definitions {
        let definition = phase4_object(raw_definition, label)?;
        if definition.get("id").and_then(Value::as_str) != Some(key) {
            return Err(phase4_error("记录键与编号不一致"));
        }
    }
    Ok(())
}

fn phase4_is_credential_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .map(|character| character.to_ascii_lowercase())
        .collect::<String>();
    matches!(
        normalized.as_str(),
        "password"
            | "passwd"
            | "secret"
            | "apikey"
            | "accesstoken"
            | "refreshtoken"
            | "authtoken"
            | "privatekey"
            | "clientsecret"
            | "credential"
            | "credentials"
    )
}

fn phase4_is_base64(value: &str) -> bool {
    let payload = if value.starts_with("data:") && value.contains(";base64,") {
        value
            .split_once(',')
            .map(|(_, payload)| payload)
            .unwrap_or("")
    } else {
        value
    };
    let bytes = payload.as_bytes();
    if bytes.len() < 128 || bytes.len() % 4 != 0 {
        return false;
    }
    let padding = bytes.iter().rev().take_while(|byte| **byte == b'=').count();
    padding <= 2
        && bytes[..bytes.len() - padding]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
        && bytes[bytes.len() - padding..]
            .iter()
            .all(|byte| *byte == b'=')
}

fn phase4_contains_credential(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    if lower.contains("-----begin ") && lower.contains("private key-----") {
        return true;
    }
    if lower.match_indices("bearer ").any(|(index, _)| {
        let token = &value[index + "bearer ".len()..];
        token
            .chars()
            .take_while(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '~' | '-')
            })
            .count()
            >= 16
    }) {
        return true;
    }
    [
        "api_key",
        "api-key",
        "access_token",
        "access-token",
        "refresh_token",
        "refresh-token",
        "auth_token",
        "auth-token",
        "private_key",
        "private-key",
        "client_secret",
        "client-secret",
        "password",
        "secret",
        "credential",
        "credentials",
    ]
    .iter()
    .any(|term| {
        lower.match_indices(term).any(|(index, _)| {
            let has_boundary = index == 0
                || (!lower.as_bytes()[index - 1].is_ascii_alphanumeric()
                    && lower.as_bytes()[index - 1] != b'_');
            has_boundary
                && lower[index + term.len()..]
                    .trim_start()
                    .starts_with([':', '='])
        })
    })
}

fn validate_phase4_tree(value: &Value) -> Result<(), String> {
    let mut pending = vec![(value, 0usize)];
    while let Some((current, depth)) = pending.pop() {
        if depth > 32 {
            return Err(phase4_error("JSON嵌套过深"));
        }
        match current {
            Value::String(text) => {
                if text.chars().count() > 4_096 {
                    return Err(phase4_error("文本超过长度限制"));
                }
                if phase4_contains_credential(text) {
                    return Err(phase4_error("禁止持久化凭据"));
                }
                if phase4_is_base64(text) {
                    return Err(phase4_error("禁止持久化Base64数据"));
                }
            }
            Value::Array(values) => {
                pending.extend(values.iter().map(|child| (child, depth + 1)));
            }
            Value::Object(object) => {
                for (key, child) in object {
                    if key.chars().count() > 128 {
                        return Err(phase4_error("字段名超过长度限制"));
                    }
                    if phase4_is_credential_key(key) {
                        return Err(phase4_error("禁止持久化凭据"));
                    }
                    pending.push((child, depth + 1));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn phase4_type<'a>(value: &'a Value, label: &str) -> Result<&'a str, String> {
    let candidate = value
        .as_str()
        .ok_or_else(|| phase4_error(&format!("{label}目录引用无效")))?;
    if !PHASE4_PUBLIC_SPACE_TYPES.contains(&candidate) {
        return Err(phase4_error(&format!("{label}目录引用无效")));
    }
    Ok(candidate)
}

fn phase4_zone(value: &Value) -> Result<&str, String> {
    phase4_one_of(
        value,
        &[
            "zone:arrival",
            "zone:seating",
            "zone:kitchen",
            "zone:bar-service",
            "zone:quiet",
            "zone:wet",
            "zone:fitness",
            "zone:event",
            "zone:back-of-house",
            "zone:terrace",
            "zone:retail",
            "zone:deck",
            "zone:service-route",
            "zone:entrance",
            "zone:reception",
            "zone:waiting",
            "zone:luggage",
            "zone:elevator-lobby",
            "zone:treatment",
            "zone:wet-route",
            "zone:stage",
            "zone:meeting-setup",
            "zone:partition",
        ],
        "分区",
    )
}

fn phase4_item(value: &Value) -> Result<&str, String> {
    phase4_one_of(
        value,
        &[
            "item:reception-desk",
            "item:lounge-seat",
            "item:dining-table",
            "item:service-counter",
            "item:bar-counter",
            "item:treatment-bed",
            "item:pool",
            "item:fitness-station",
            "item:event-table",
            "item:meeting-table",
            "item:planter",
            "item:display-case",
        ],
        "物品目录",
    )
}

fn phase4_policy_group(facility_type: &str) -> Option<&'static str> {
    match facility_type {
        "all-day-dining" | "chinese-restaurant" => Some("dining"),
        "bar" => Some("bar"),
        "spa" => Some("spa"),
        "ballroom" | "meeting-room" => Some("banquet"),
        _ => None,
    }
}

fn phase4_policy_allowed(group: &str, positioning: &str, price: &str, opening: &str) -> bool {
    matches!(
        (group, positioning, price, opening),
        (
            "dining",
            "positioning:international-luxury",
            "price-band:premium",
            "opening-policy:breakfast-dinner"
        ) | (
            "dining",
            "positioning:local-contemporary",
            "price-band:upper-midscale",
            "opening-policy:all-day"
        ) | (
            "dining",
            "positioning:destination-dining",
            "price-band:luxury",
            "opening-policy:dinner-only"
        ) | (
            "bar",
            "positioning:craft-cocktail",
            "price-band:premium",
            "opening-policy:evening"
        ) | (
            "bar",
            "positioning:social-lounge",
            "price-band:upper-midscale",
            "opening-policy:afternoon-late"
        ) | (
            "bar",
            "positioning:skyline-luxury",
            "price-band:luxury",
            "opening-policy:sunset-late"
        ) | (
            "spa",
            "positioning:restorative-wellness",
            "price-band:premium",
            "opening-policy:appointment-daily"
        ) | (
            "spa",
            "positioning:clinical-wellness",
            "price-band:luxury",
            "opening-policy:appointment-extended"
        ) | (
            "spa",
            "positioning:express-wellness",
            "price-band:upper-midscale",
            "opening-policy:daytime"
        ) | (
            "banquet",
            "positioning:corporate-events",
            "price-band:premium",
            "opening-policy:booked-events"
        ) | (
            "banquet",
            "positioning:celebration-luxury",
            "price-band:luxury",
            "opening-policy:booked-events"
        ) | (
            "banquet",
            "positioning:flexible-events",
            "price-band:upper-midscale",
            "opening-policy:day-evening"
        )
    )
}

fn phase4_offering_allowed(facility_type: &str, offering: &str) -> bool {
    matches!(
        (facility_type, offering),
        (
            "all-day-dining",
            "dish:tea-smoked-duck" | "dish:cloud-breakfast" | "dish:harbor-seafood"
        ) | (
            "chinese-restaurant",
            "dish:tea-smoked-duck" | "dish:crystal-shrimp" | "dish:mountain-broth"
        ) | (
            "bar",
            "drink:cloud-negroni" | "drink:tea-spritz" | "drink:night-orchard"
        ) | (
            "spa",
            "service:cloud-restoration" | "service:express-recovery" | "service:couples-ritual"
        ) | (
            "ballroom" | "meeting-room",
            "service:cloud-wedding" | "service:executive-summit" | "service:cultural-gala"
        )
    )
}

fn phase4_menu_allowed(facility_type: &str, menu: &str) -> bool {
    matches!(
        (facility_type, menu),
        (
            "all-day-dining",
            "menu:all-day-balanced" | "menu:all-day-seasonal" | "menu:all-day-chef-led"
        ) | (
            "chinese-restaurant",
            "menu:chinese-regional" | "menu:chinese-banquet" | "menu:chinese-modern"
        ) | (
            "bar",
            "menu:bar-classics" | "menu:bar-seasonal" | "menu:bar-zero-proof"
        )
    )
}

fn phase4_unique_catalog_ids(value: &Value, allowed: &HashSet<String>) -> Result<(), String> {
    let mut ids = HashSet::new();
    for raw in phase4_array(value, "目录进度")? {
        let id = phase4_stable_id(raw, "目录进度编号")?;
        if !ids.insert(id) {
            return Err(phase4_error("目录进度编号重复"));
        }
        if !allowed.contains(id) {
            return Err(phase4_error("目录引用无效"));
        }
    }
    Ok(())
}

fn phase4_int(value: &Value, label: &str, minimum: i64, maximum: i64) -> Result<i64, String> {
    let number = value
        .as_f64()
        .filter(|number| number.is_finite() && number.fract() == 0.0)
        .filter(|number| {
            *number >= minimum as f64
                && *number <= maximum as f64
                && number.abs() <= JS_MAX_SAFE_INTEGER as f64
        })
        .ok_or_else(|| phase4_error(&format!("{label}必须是安全整数")))?;
    Ok(number as i64)
}

fn phase4_bool(value: &Value, label: &str) -> Result<bool, String> {
    value
        .as_bool()
        .ok_or_else(|| phase4_error(&format!("{label}结构无效")))
}

fn phase4_one_of<'a>(value: &'a Value, allowed: &[&str], label: &str) -> Result<&'a str, String> {
    let candidate = value
        .as_str()
        .ok_or_else(|| phase4_error(&format!("{label}目录引用无效")))?;
    if !allowed.contains(&candidate) {
        return Err(phase4_error(&format!("{label}目录引用无效")));
    }
    Ok(candidate)
}

fn phase4_unique_ids<'a>(value: &'a Value, label: &str) -> Result<Vec<&'a str>, String> {
    let mut ids = HashSet::new();
    let mut result = Vec::new();
    for raw in phase4_array(value, label)? {
        let id = phase4_stable_id(raw, label)?;
        if !ids.insert(id) {
            return Err(phase4_error(&format!("{label}编号重复")));
        }
        result.push(id);
    }
    Ok(result)
}

fn validate_phase4(value: &Value, game: &Value) -> Result<(), String> {
    if serde_json::to_vec(value)
        .map_err(|_| phase4_error("JSON结构无效"))?
        .len()
        > PHASE4_MAX_JSON_BYTES
    {
        return Err(phase4_error("JSON超过大小限制"));
    }
    validate_phase4_tree(value)?;
    let phase4 = phase4_object(value, "状态")?;
    let current_day = phase4_int(
        game.get("currentDay")
            .ok_or_else(|| phase4_error("当前营业日结构无效"))?,
        "当前营业日",
        0,
        30,
    )?;
    if phase4.get("rulesetVersion").and_then(Value::as_str) != Some("content-scale-v1") {
        return Err(phase4_error("规则版本无效"));
    }
    for (key, label) in [
        ("building", "建筑"),
        ("floorTemplates", "楼层模板"),
        ("spaceBlueprints", "公共空间蓝图"),
        ("publicSpaces", "公共空间"),
        ("facilities", "设施"),
        ("catalogProgress", "目录进度"),
    ] {
        phase4_object(phase4_field(phase4, key, label)?, label)?;
    }
    for (key, label) in [
        ("floorTemplates", "楼层模板"),
        ("spaceBlueprints", "公共空间蓝图"),
        ("publicSpaces", "公共空间"),
        ("facilities", "设施"),
    ] {
        validate_phase4_identity_record(phase4_field(phase4, key, label)?, label)?;
    }
    let floors = phase4_array(phase4_field(phase4, "floors", "楼层")?, "楼层")?;
    if floors.len() > 64 {
        return Err(phase4_error("楼层最多保留64层"));
    }
    match phase4.get("recentFlowSnapshot") {
        Some(Value::Null | Value::Object(_)) => {}
        _ => return Err(phase4_error("近期流动快照结构无效")),
    }

    let templates = phase4_object(
        phase4_field(phase4, "floorTemplates", "楼层模板")?,
        "楼层模板",
    )?;
    if templates.len() > 64 {
        return Err(phase4_error("楼层模板最多保留64项"));
    }
    let mut design_ids = HashSet::new();
    if let Some(master) = game
        .get("phase2")
        .and_then(|phase2| phase2.get("roomMaster"))
        .filter(|master| !master.is_null())
    {
        design_ids.insert(phase4_stable_id(obj(master, "id")?, "客房母版编号")?);
    }
    if let Some(blueprint) = game.get("roomBlueprint").filter(|value| !value.is_null()) {
        design_ids.insert(phase4_stable_id(obj(blueprint, "id")?, "客房设计编号")?);
    }
    let mut variants = HashMap::new();
    if let Some(raw_variants) = game
        .get("phase2")
        .and_then(|phase2| phase2.get("roomVariants"))
    {
        for raw_variant in phase4_array(raw_variants, "客房变体")? {
            let variant = phase4_object(raw_variant, "客房变体")?;
            let id =
                phase4_stable_id(phase4_field(variant, "id", "客房变体编号")?, "客房变体编号")?;
            let master_id = phase4_stable_id(
                phase4_field(variant, "masterId", "客房母版编号")?,
                "客房母版编号",
            )?;
            if variants.insert(id, master_id).is_some() {
                return Err(phase4_error("客房变体编号重复"));
            }
        }
    }
    let mut template_uses = HashMap::new();
    let mut template_placements: HashMap<&str, HashMap<&str, (&str, Option<&str>)>> =
        HashMap::new();
    let mut template_slots: HashMap<&str, HashMap<&str, HashSet<&str>>> = HashMap::new();
    for (template_id, raw_template) in templates {
        let template = phase4_object(raw_template, "楼层模板")?;
        let use_id = phase4_one_of(
            phase4_field(template, "use", "楼层用途")?,
            &["entrance", "sky-lobby", "guest", "facility", "service"],
            "楼层用途",
        )?;
        template_uses.insert(template_id.as_str(), use_id);
        let columns = phase4_int(
            phase4_field(template, "columns", "楼层模板列数")?,
            "楼层模板列数",
            1,
            512,
        )?;
        let rows = phase4_int(
            phase4_field(template, "rows", "楼层模板行数")?,
            "楼层模板行数",
            1,
            512,
        )?;
        if phase4_field(template, "cellAreaSquareMeters", "楼层模板单元面积")?.as_f64() != Some(1.0)
        {
            return Err(phase4_error("楼层模板单元面积无效"));
        }
        let mut placements = HashMap::new();
        for raw_placement in phase4_array(
            phase4_field(template, "roomPlacements", "客房放置")?,
            "客房放置",
        )? {
            let placement = phase4_object(raw_placement, "客房放置")?;
            let id = phase4_stable_id(
                phase4_field(placement, "id", "客房放置编号")?,
                "客房放置编号",
            )?;
            let master_id = phase4_stable_id(
                phase4_field(placement, "roomBlueprintId", "客房母版编号")?,
                "客房母版编号",
            )?;
            if !design_ids.is_empty() && !design_ids.contains(master_id) {
                return Err(phase4_error("客房设计引用无效"));
            }
            let variant_id = placement
                .get("variantId")
                .map(|value| phase4_stable_id(value, "客房变体编号"))
                .transpose()?;
            if variant_id.is_some_and(|id| variants.get(id).copied() != Some(master_id)) {
                return Err(phase4_error("客房变体引用无效"));
            }
            let anchor_x = phase4_int(
                phase4_field(placement, "anchorX", "客房横坐标")?,
                "客房横坐标",
                0,
                columns - 1,
            )?;
            let anchor_y = phase4_int(
                phase4_field(placement, "anchorY", "客房纵坐标")?,
                "客房纵坐标",
                0,
                rows - 1,
            )?;
            let width = phase4_int(
                phase4_field(placement, "width", "客房宽度")?,
                "客房宽度",
                1,
                columns,
            )?;
            let height = phase4_int(
                phase4_field(placement, "height", "客房高度")?,
                "客房高度",
                1,
                rows,
            )?;
            if anchor_x + width > columns || anchor_y + height > rows {
                return Err(phase4_error("客房放置超出楼层模板"));
            }
            let rotation = phase4_int(
                phase4_field(placement, "rotation", "客房旋转")?,
                "客房旋转",
                0,
                270,
            )?;
            if ![0, 90, 180, 270].contains(&rotation) {
                return Err(phase4_error("客房放置几何无效"));
            }
            phase4_bool(phase4_field(placement, "mirrored", "客房镜像")?, "客房镜像")?;
            if placements.insert(id, (master_id, variant_id)).is_some() {
                return Err(phase4_error("客房放置编号重复"));
            }
        }
        template_placements.insert(template_id, placements);
        let mut slots = HashMap::new();
        for raw_slot in phase4_array(
            phase4_field(template, "publicSpaceSlots", "公共空间槽位")?,
            "公共空间槽位",
        )? {
            let slot = phase4_object(raw_slot, "公共空间槽位")?;
            let id = phase4_stable_id(
                phase4_field(slot, "id", "公共空间槽位编号")?,
                "公共空间槽位编号",
            )?;
            let permitted_values = phase4_array(
                phase4_field(slot, "permittedTypes", "允许设施类型")?,
                "允许设施类型",
            )?;
            let permitted = permitted_values
                .iter()
                .map(|value| phase4_type(value, "设施类型"))
                .collect::<Result<HashSet<_>, _>>()?;
            if permitted.is_empty() || permitted.len() != permitted_values.len() {
                return Err(phase4_error("允许设施类型无效"));
            }
            let geometry_fields = ["anchorX", "anchorY", "width", "height"];
            let geometry_field_count = geometry_fields
                .iter()
                .filter(|field| slot.get(**field).is_some())
                .count();
            if geometry_field_count != 0 && geometry_field_count != geometry_fields.len() {
                return Err(phase4_error("公共空间槽位几何必须完整"));
            }
            if geometry_field_count == geometry_fields.len() {
                let geometry_int = |field: &str, minimum: i64, maximum: i64| {
                    phase4_int(
                        phase4_field(slot, field, "公共空间槽位几何")?,
                        "公共空间槽位几何",
                        minimum,
                        maximum,
                    )
                };
                let anchor_x = geometry_int("anchorX", 0, columns - 1)?;
                let anchor_y = geometry_int("anchorY", 0, rows - 1)?;
                let width = geometry_int("width", 1, columns)?;
                let height = geometry_int("height", 1, rows)?;
                let right = anchor_x
                    .checked_add(width)
                    .ok_or_else(|| phase4_error("公共空间槽位几何超出楼层模板"))?;
                let bottom = anchor_y
                    .checked_add(height)
                    .ok_or_else(|| phase4_error("公共空间槽位几何超出楼层模板"))?;
                if right > columns || bottom > rows {
                    return Err(phase4_error("公共空间槽位几何超出楼层模板"));
                }
            }
            if slots.insert(id, permitted).is_some() {
                return Err(phase4_error("公共空间槽位无效"));
            }
        }
        template_slots.insert(template_id, slots);
    }

    let mut floor_ids = HashSet::new();
    let mut floor_records = HashMap::new();
    let mut floor_numbers = HashSet::new();
    let mut owned_spaces = HashMap::new();
    let mut room_ids = HashSet::new();
    let mut room_owners = Vec::new();
    let mut room_count = 0usize;
    for raw_floor in floors {
        let floor = phase4_object(raw_floor, "楼层")?;
        let floor_id = phase4_stable_id(phase4_field(floor, "id", "楼层编号")?, "楼层编号")?;
        if !floor_ids.insert(floor_id) {
            return Err(phase4_error("楼层编号重复"));
        }
        let floor_number = phase4_int(
            phase4_field(floor, "floorNumber", "楼层号")?,
            "楼层号",
            1,
            64,
        )?;
        if !floor_numbers.insert(floor_number) {
            return Err(phase4_error("楼层号重复"));
        }
        let use_id = phase4_one_of(
            phase4_field(floor, "use", "楼层用途")?,
            &["entrance", "sky-lobby", "guest", "facility", "service"],
            "楼层用途",
        )?;
        let template_id = phase4_stable_id(
            phase4_field(floor, "templateId", "楼层模板编号")?,
            "楼层模板编号",
        )?;
        if template_uses.get(template_id).copied() != Some(use_id) {
            return Err(phase4_error("楼层模板引用无效"));
        }
        phase4_bool(
            phase4_field(floor, "purchased", "楼层购买状态")?,
            "楼层购买状态",
        )?;
        for space_id in phase4_unique_ids(
            phase4_field(floor, "publicSpaceInstanceIds", "楼层公共空间")?,
            "楼层公共空间",
        )? {
            if owned_spaces.insert(space_id, floor_id).is_some() {
                return Err(phase4_error("公共空间所属楼层重复"));
            }
        }
        floor_records.insert(floor_id, (use_id, template_id));
        for raw_room in phase4_array(phase4_field(floor, "rooms", "客房")?, "客房")? {
            room_count += 1;
            if room_count > 240 {
                return Err(phase4_error("客房最多保留240间"));
            }
            let room = phase4_object(raw_room, "客房")?;
            let room_id = phase4_stable_id(phase4_field(room, "id", "客房编号")?, "客房编号")?;
            if !room_ids.insert(room_id) {
                return Err(phase4_error("客房编号重复"));
            }
            room_owners.push((
                phase4_stable_id(
                    phase4_field(room, "floorId", "客房楼层编号")?,
                    "客房楼层编号",
                )?,
                floor_id,
            ));
            let placement_id = phase4_stable_id(
                phase4_field(room, "localPlacementId", "客房放置编号")?,
                "客房放置编号",
            )?;
            let master_id = phase4_stable_id(
                phase4_field(room, "roomBlueprintId", "客房母版编号")?,
                "客房母版编号",
            )?;
            let variant_id = room
                .get("variantId")
                .map(|value| phase4_stable_id(value, "客房变体编号"))
                .transpose()?;
            if template_placements
                .get(template_id)
                .and_then(|placements| placements.get(placement_id))
                .copied()
                != Some((master_id, variant_id))
            {
                return Err(phase4_error("客房放置或设计引用无效"));
            }
            validate_phase4_money(phase4_field(room, "committedBuildCostCents", "施工金额")?)?;
        }
    }
    if room_owners
        .iter()
        .any(|(floor_id, _)| !floor_ids.contains(floor_id))
    {
        return Err(phase4_error("客房楼层引用无效"));
    }
    if room_owners
        .iter()
        .any(|(floor_id, containing_floor_id)| floor_id != containing_floor_id)
    {
        return Err(phase4_error("客房必须属于所在楼层"));
    }

    let building = phase4_object(phase4_field(phase4, "building", "建筑")?, "建筑")?;
    if phase4_stable_id(
        phase4_field(building, "templateId", "建筑模板编号")?,
        "建筑模板编号",
    )? != "building-template:first-tower"
    {
        return Err(phase4_error("目录引用无效"));
    }
    let entrance_id = phase4_stable_id(
        phase4_field(building, "entranceFloorId", "入口楼层编号")?,
        "入口楼层编号",
    )?;
    if floor_records.get(entrance_id).map(|record| record.0) != Some("entrance") {
        return Err(phase4_error("入口楼层引用无效"));
    }
    for floor_id in phase4_unique_ids(
        phase4_field(building, "skyLobbyFloorIds", "空中大堂楼层")?,
        "空中大堂楼层",
    )? {
        if floor_records.get(floor_id).map(|record| record.0) != Some("sky-lobby") {
            return Err(phase4_error("空中大堂楼层引用无效"));
        }
    }
    for floor_id in phase4_unique_ids(
        phase4_field(building, "purchasedFloorIds", "已购买楼层")?,
        "已购买楼层",
    )? {
        if !floor_ids.contains(floor_id) {
            return Err(phase4_error("已购买楼层引用无效"));
        }
    }
    let mut expansion_numbers = HashSet::new();
    for raw_number in phase4_array(
        phase4_field(building, "availableExpansionFloorNumbers", "可扩建楼层")?,
        "可扩建楼层",
    )? {
        let number = phase4_int(raw_number, "可扩建楼层号", 1, 64)?;
        if !expansion_numbers.insert(number) || floor_numbers.contains(&number) {
            return Err(phase4_error("可扩建楼层引用无效"));
        }
    }

    let blueprints = phase4_object(
        phase4_field(phase4, "spaceBlueprints", "公共空间蓝图")?,
        "公共空间蓝图",
    )?;
    if blueprints.len() > 32 {
        return Err(phase4_error("公共空间蓝图最多保留32项"));
    }
    let public_spaces = phase4_object(
        phase4_field(phase4, "publicSpaces", "公共空间")?,
        "公共空间",
    )?;
    if public_spaces.len() > 32 {
        return Err(phase4_error("公共空间最多保留32项"));
    }
    let mut occupied_space_placements = HashSet::new();
    for (space_id, raw_space) in public_spaces {
        let space = phase4_object(raw_space, "公共空间")?;
        let type_id = phase4_type(phase4_field(space, "type", "公共空间类型")?, "公共空间类型")?;
        let floor_id = phase4_stable_id(
            phase4_field(space, "floorId", "公共空间楼层编号")?,
            "公共空间楼层编号",
        )?;
        if !floor_ids.contains(floor_id) {
            return Err(phase4_error("公共空间楼层引用无效"));
        }
        if owned_spaces.get(space_id.as_str()).copied() != Some(floor_id) {
            return Err(phase4_error("公共空间楼层引用无效"));
        }
        let slot_id = phase4_stable_id(
            phase4_field(space, "localPlacementId", "公共空间槽位编号")?,
            "公共空间槽位编号",
        )?;
        if !occupied_space_placements.insert((floor_id, slot_id)) {
            return Err(phase4_error("公共空间放置重复"));
        }
        let (floor_use, canonical_template_id) = floor_records
            .get(floor_id)
            .copied()
            .ok_or_else(|| phase4_error("公共空间楼层引用无效"))?;
        let snapshot_template_id = format!("template-snapshot:{floor_id}");
        let applied_template_id = if template_slots.contains_key(snapshot_template_id.as_str()) {
            snapshot_template_id.as_str()
        } else {
            canonical_template_id
        };
        if template_uses.get(applied_template_id).copied() != Some(floor_use) {
            return Err(phase4_error("公共空间槽位或类型引用无效"));
        }
        if !template_slots
            .get(applied_template_id)
            .and_then(|slots| slots.get(slot_id))
            .is_some_and(|types| types.contains(type_id))
        {
            return Err(phase4_error("公共空间槽位或类型引用无效"));
        }
        let blueprint_id = phase4_stable_id(
            phase4_field(space, "blueprintId", "公共空间蓝图编号")?,
            "公共空间蓝图编号",
        )?;
        if blueprints
            .get(blueprint_id)
            .and_then(|blueprint| blueprint.get("type"))
            .and_then(Value::as_str)
            != Some(type_id)
        {
            return Err(phase4_error("公共空间蓝图引用无效"));
        }
        validate_phase4_money(phase4_field(space, "committedBuildCostCents", "施工金额")?)?;
    }
    if owned_spaces.len() != public_spaces.len() {
        return Err(phase4_error("楼层公共空间反向引用不完整"));
    }
    for raw_blueprint in blueprints.values() {
        let blueprint = phase4_object(raw_blueprint, "公共空间蓝图")?;
        phase4_type(
            phase4_field(blueprint, "type", "公共空间类型")?,
            "公共空间类型",
        )?;
        let name = phase4_field(blueprint, "name", "公共空间名称")?
            .as_str()
            .filter(|name| !name.trim().is_empty() && name.trim() == *name)
            .filter(|name| name.chars().count() <= 256)
            .ok_or_else(|| phase4_error("公共空间名称文本无效"))?;
        let _ = name;
        let cells = phase4_array(
            phase4_field(blueprint, "cells", "公共空间蓝图格子")?,
            "公共空间蓝图格子",
        )?;
        if cells.len() > 8_192 {
            return Err(phase4_error("公共空间蓝图格子最多保留8192项"));
        }
        let columns = phase4_int(
            phase4_field(blueprint, "columns", "公共空间列数")?,
            "公共空间列数",
            1,
            512,
        )?;
        let rows = phase4_int(
            phase4_field(blueprint, "rows", "公共空间行数")?,
            "公共空间行数",
            1,
            512,
        )?;
        let mut coordinates = HashSet::new();
        for raw_cell in cells {
            let cell = phase4_object(raw_cell, "公共空间格子")?;
            let x = phase4_int(
                phase4_field(cell, "x", "公共空间格子横坐标")?,
                "公共空间格子横坐标",
                0,
                columns - 1,
            )?;
            let y = phase4_int(
                phase4_field(cell, "y", "公共空间格子纵坐标")?,
                "公共空间格子纵坐标",
                0,
                rows - 1,
            )?;
            if !coordinates.insert((x, y)) {
                return Err(phase4_error("公共空间格子坐标重复"));
            }
            phase4_zone(phase4_field(cell, "zoneId", "分区编号")?)?;
        }
        let items = phase4_array(
            phase4_field(blueprint, "placedItems", "公共空间蓝图物品")?,
            "公共空间蓝图物品",
        )?;
        if items.len() > 256 {
            return Err(phase4_error("公共空间蓝图物品最多保留256项"));
        }
        let mut item_ids = HashSet::new();
        for raw_item in items {
            let item = phase4_object(raw_item, "公共空间物品")?;
            let id = phase4_stable_id(
                phase4_field(item, "id", "公共空间物品编号")?,
                "公共空间物品编号",
            )?;
            if !item_ids.insert(id) {
                return Err(phase4_error("公共空间物品编号重复"));
            }
            phase4_item(phase4_field(item, "catalogItemId", "物品目录编号")?)?;
            let x = phase4_int(
                phase4_field(item, "x", "物品横坐标")?,
                "物品横坐标",
                0,
                columns - 1,
            )?;
            let y = phase4_int(
                phase4_field(item, "y", "物品纵坐标")?,
                "物品纵坐标",
                0,
                rows - 1,
            )?;
            let width = phase4_int(
                phase4_field(item, "width", "物品宽度")?,
                "物品宽度",
                1,
                columns,
            )?;
            let height = phase4_int(
                phase4_field(item, "height", "物品高度")?,
                "物品高度",
                1,
                rows,
            )?;
            if x + width > columns || y + height > rows {
                return Err(phase4_error("公共空间物品超出蓝图"));
            }
            let rotation = phase4_int(
                phase4_field(item, "rotation", "物品旋转")?,
                "物品旋转",
                0,
                270,
            )?;
            if ![0, 90, 180, 270].contains(&rotation) {
                return Err(phase4_error("物品旋转无效"));
            }
        }
        validate_phase4_money(phase4_field(
            blueprint,
            "committedBuildCostCents",
            "施工金额",
        )?)?;
    }
    let facilities = phase4_object(phase4_field(phase4, "facilities", "设施")?, "设施")?;
    if facilities.len() > 32 {
        return Err(phase4_error("设施最多保留32项"));
    }
    let mut facility_space_ids = HashSet::new();
    for raw_facility in facilities.values() {
        let facility = phase4_object(raw_facility, "设施")?;
        let type_id = phase4_type(phase4_field(facility, "type", "设施类型")?, "设施类型")?;
        let instance_id = phase4_stable_id(
            phase4_field(facility, "publicSpaceInstanceId", "设施公共空间编号")?,
            "设施公共空间编号",
        )?;
        if !facility_space_ids.insert(instance_id) {
            return Err(phase4_error("设施公共空间引用重复"));
        }
        if public_spaces
            .get(instance_id)
            .and_then(|space| space.get("type"))
            .and_then(Value::as_str)
            != Some(type_id)
        {
            return Err(phase4_error("设施公共空间引用无效"));
        }
        phase4_one_of(
            phase4_field(facility, "status", "设施状态")?,
            &["planned", "operating", "closed"],
            "设施状态",
        )?;
        phase4_bool(
            phase4_field(facility, "enabled", "设施启用状态")?,
            "设施启用状态",
        )?;
        validate_phase4_money(phase4_field(
            facility,
            "dailyOperatingCostCents",
            "设施每日成本",
        )?)?;
        let inputs = phase4_object(
            phase4_field(facility, "segmentInputs", "设施客群输入")?,
            "设施客群输入",
        )?;
        if inputs.len() != OPERATIONS_SEGMENTS.len()
            || OPERATIONS_SEGMENTS
                .iter()
                .any(|id| !inputs.contains_key(*id))
        {
            return Err(phase4_error("设施客群目录不完整"));
        }
        for input in inputs.values() {
            let input = phase4_object(input, "设施客群输入")?;
            phase4_int(
                phase4_field(input, "appealBps", "客群吸引力")?,
                "客群吸引力",
                0,
                10_000,
            )?;
            phase4_int(
                phase4_field(input, "satisfactionBps", "客群满意度")?,
                "客群满意度",
                0,
                10_000,
            )?;
            phase4_int(
                phase4_field(input, "dailyDemand", "客群每日需求")?,
                "客群每日需求",
                0,
                JS_MAX_SAFE_INTEGER,
            )?;
        }
        let developed = phase4_unique_ids(
            phase4_field(facility, "developedOfferingIds", "已开发产品")?,
            "已开发产品",
        )?;
        if developed
            .iter()
            .any(|offering| !phase4_offering_allowed(type_id, offering))
        {
            return Err(phase4_error("目录引用无效"));
        }
        if let Some(policy) = facility.get("policy").filter(|value| !value.is_null()) {
            let policy = phase4_object(policy, "设施策略")?;
            let positioning = phase4_stable_id(
                phase4_field(policy, "positioningId", "设施策略编号")?,
                "设施策略编号",
            )?;
            let price = phase4_stable_id(
                phase4_field(policy, "priceBandId", "设施策略编号")?,
                "设施策略编号",
            )?;
            let opening = phase4_stable_id(
                phase4_field(policy, "openingPolicyId", "设施策略编号")?,
                "设施策略编号",
            )?;
            let group = phase4_policy_group(type_id).ok_or_else(|| phase4_error("目录引用无效"))?;
            if !phase4_policy_allowed(group, positioning, price, opening) {
                return Err(phase4_error("目录引用无效"));
            }
            phase4_int(
                phase4_field(policy, "capacity", "设施容量")?,
                "设施容量",
                1,
                10_000,
            )?;
            validate_phase4_money(phase4_field(policy, "serviceBudgetCents", "设施服务预算")?)?;
            if let Some(offering) = policy.get("signatureOfferingId") {
                let offering = phase4_stable_id(offering, "招牌产品编号")?;
                if !phase4_offering_allowed(type_id, offering) || !developed.contains(&offering) {
                    return Err(phase4_error("目录引用无效"));
                }
            }
        }
        if let Some(menu) = facility
            .get("menuSelection")
            .filter(|value| !value.is_null())
        {
            let menu = phase4_object(menu, "菜单选择")?;
            let menu_id = phase4_stable_id(
                phase4_field(menu, "menuStructureId", "菜单编号")?,
                "菜单编号",
            )?;
            if !phase4_menu_allowed(type_id, menu_id) {
                return Err(phase4_error("目录引用无效"));
            }
            phase4_unique_ids(
                phase4_field(menu, "selectedItemIds", "菜单条目")?,
                "菜单条目",
            )?;
        }
        let history = phase4_array(
            phase4_field(facility, "dailyResults", "设施历史")?,
            "设施历史",
        )?;
        if history.len() > 30 {
            return Err(phase4_error("设施历史最多保留30天"));
        }
        let mut previous_day = 0;
        for result in history {
            let result = phase4_object(result, "设施历史")?;
            let day = phase4_int(
                phase4_field(result, "day", "设施历史日期")?,
                "设施历史日期",
                1,
                30,
            )?;
            if day <= previous_day || day > current_day {
                return Err(phase4_error("设施历史日期无效"));
            }
            previous_day = day;
            for (key, label) in [
                ("visits", "设施到访量"),
                ("revenueCents", "设施收入"),
                ("operatingCostCents", "设施经营成本"),
            ] {
                phase4_int(
                    phase4_field(result, key, label)?,
                    label,
                    0,
                    JS_MAX_SAFE_INTEGER,
                )?;
            }
            phase4_int(
                phase4_field(result, "utilizationBps", "设施利用率")?,
                "设施利用率",
                0,
                10_000,
            )?;
            phase4_int(
                phase4_field(result, "satisfactionDeltaBps", "设施满意度变化")?,
                "设施满意度变化",
                -200,
                200,
            )?;
            phase4_int(
                phase4_field(result, "appealDeltaBps", "设施吸引力变化")?,
                "设施吸引力变化",
                -200,
                200,
            )?;
            phase4_unique_ids(phase4_field(result, "reasonCodes", "设施原因")?, "设施原因")?;
        }
    }
    let progress = phase4_object(
        phase4_field(phase4, "catalogProgress", "目录进度")?,
        "目录进度",
    )?;
    let facility_catalog = PHASE4_PUBLIC_SPACE_TYPES
        .iter()
        .map(|kind| format!("facility:{kind}"))
        .collect::<HashSet<_>>();
    phase4_unique_catalog_ids(
        phase4_field(progress, "unlockedIds", "内容解锁")?,
        &facility_catalog,
    )?;
    let market_catalog = OPERATIONS_SEGMENTS
        .iter()
        .map(|segment| format!("market:{segment}"))
        .collect::<HashSet<_>>();
    phase4_unique_catalog_ids(
        phase4_field(progress, "discoveredMarketEntryIds", "市场目录")?,
        &market_catalog,
    )?;
    if let Some(snapshot) = phase4
        .get("recentFlowSnapshot")
        .filter(|item| !item.is_null())
    {
        let snapshot = phase4_object(snapshot, "近期流动快照")?;
        phase4_int(
            phase4_field(snapshot, "day", "流动快照日期")?,
            "流动快照日期",
            0,
            30,
        )?;
        let visible_floor_id = phase4_stable_id(
            phase4_field(snapshot, "visibleFloorId", "可见楼层编号")?,
            "可见楼层编号",
        )?;
        if !floor_ids.contains(visible_floor_id) {
            return Err(phase4_error("流动楼层引用无效"));
        }
        let events = phase4_array(phase4_field(snapshot, "events", "流动事件")?, "流动事件")?;
        if events.len() > 150 {
            return Err(phase4_error("流动事件最多保留150项"));
        }
        let mut ids = HashSet::new();
        let mut graph_ids = floor_ids.clone();
        graph_ids.extend(public_spaces.keys().map(String::as_str));
        graph_ids.extend(facilities.keys().map(String::as_str));
        graph_ids.insert("flow:hotel-residents");
        for raw_event in events {
            let event = phase4_object(raw_event, "流动事件")?;
            let id = phase4_stable_id(phase4_field(event, "id", "流动事件编号")?, "流动事件编号")?;
            if !ids.insert(id) {
                return Err(phase4_error("流动事件编号重复"));
            }
            phase4_one_of(
                phase4_field(event, "kind", "流动事件类型")?,
                &["guest", "staff", "service"],
                "流动事件类型",
            )?;
            for (key, label) in [("fromId", "流动起点编号"), ("toId", "流动终点编号")] {
                let reference = phase4_stable_id(phase4_field(event, key, label)?, label)?;
                if !graph_ids.contains(reference) {
                    return Err(phase4_error("流动引用无效"));
                }
            }
            phase4_int(
                phase4_field(event, "count", "流动数量")?,
                "流动数量",
                1,
                JS_MAX_SAFE_INTEGER,
            )?;
        }
    }
    Ok(())
}

const OPERATIONS_DEPARTMENTS: [&str; 6] = [
    "frontOffice",
    "housekeeping",
    "foodAndBeverage",
    "engineering",
    "security",
    "guestRelations",
];
const OPERATIONS_SEGMENTS: [&str; 6] = [
    "business",
    "couple",
    "family",
    "leisure",
    "high-net-worth",
    "cultural-experience",
];
const OPERATIONS_UNLOCKS: [&str; 3] = [
    "operations:pricing-automation",
    "operations:premium-segments",
    "operations:signature-service",
];

fn operations_object(value: &Value) -> Result<&serde_json::Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| "经营存档数据损坏".to_string())
}

fn operations_array<'a>(value: &'a Value, key: &str) -> Result<&'a Vec<Value>, String> {
    obj(value, key)?
        .as_array()
        .ok_or_else(|| "经营存档数据损坏".to_string())
}

fn operations_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    obj(value, key)?
        .as_str()
        .filter(|text| !text.is_empty() && text.trim() == *text)
        .ok_or_else(|| "经营存档数据损坏".to_string())
}

fn operations_int(value: &Value, key: &str, minimum: i64, maximum: i64) -> Result<i64, String> {
    let number = obj(value, key)?
        .as_i64()
        .ok_or_else(|| "经营存档数据损坏".to_string())?;
    if number < minimum || number > maximum || number > JS_MAX_SAFE_INTEGER {
        return Err("经营存档数据损坏".into());
    }
    Ok(number)
}

fn operations_optional_int(
    value: &Value,
    key: &str,
    minimum: i64,
    maximum: i64,
) -> Result<Option<i64>, String> {
    value
        .get(key)
        .map(|_| operations_int(value, key, minimum, maximum))
        .transpose()
}

fn operations_bps(value: &Value, key: &str) -> Result<i64, String> {
    operations_int(value, key, 0, 10_000)
}

fn checked_sum(values: impl IntoIterator<Item = i64>) -> Result<i64, String> {
    let total = values.into_iter().map(i128::from).sum::<i128>();
    if total < -i128::from(JS_MAX_SAFE_INTEGER) || total > i128::from(JS_MAX_SAFE_INTEGER) {
        Err("经营存档数据损坏".into())
    } else {
        Ok(total as i64)
    }
}

fn operations_one_of(value: &Value, key: &str, allowed: &[&str]) -> Result<String, String> {
    let candidate = operations_string(value, key)?;
    if !allowed.contains(&candidate) {
        return Err("经营存档数据损坏".into());
    }
    Ok(candidate.to_string())
}

fn validate_operations_departments(value: &Value) -> Result<(), String> {
    let departments = operations_object(value)?;
    if departments.len() != OPERATIONS_DEPARTMENTS.len()
        || OPERATIONS_DEPARTMENTS
            .iter()
            .any(|id| !departments.contains_key(*id))
    {
        return Err("经营存档数据损坏".into());
    }
    let specialties: HashMap<&str, [&str; 2]> = HashMap::from([
        ("frontOffice", ["arrival-flow", "front-desk-care"]),
        ("housekeeping", ["room-turnover", "quality-control"]),
        ("foodAndBeverage", ["dining-throughput", "menu-quality"]),
        ("engineering", ["preventive-maintenance", "rapid-repair"]),
        ("security", ["risk-prevention", "emergency-response"]),
        ("guestRelations", ["personalized-care", "service-recovery"]),
    ]);
    for id in OPERATIONS_DEPARTMENTS {
        let department = &departments[id];
        if operations_string(department, "id")? != id {
            return Err("经营存档数据损坏".into());
        }
        operations_int(department, "staffing", 0, 500)?;
        operations_int(department, "dailyBudgetCents", 0, 100_000_000)?;
        operations_bps(department, "trainingBps")?;
        operations_bps(department, "serviceStandardBps")?;
        if let Some(specialty) = department.get("leaderSpecialty") {
            if !specialties[id].contains(
                &specialty
                    .as_str()
                    .ok_or_else(|| "经营存档数据损坏".to_string())?,
            ) {
                return Err("经营存档数据损坏".into());
            }
        }
    }
    Ok(())
}

fn validate_operations_prices(value: &Value) -> Result<(), String> {
    for (key, policy) in operations_object(value)? {
        if key.is_empty() || key.trim() != key || operations_string(policy, "roomOfferId")? != key {
            return Err("经营存档数据损坏".into());
        }
        let nightly = operations_int(policy, "nightlyRateCents", 0, JS_MAX_SAFE_INTEGER)?;
        let explicit = [
            "baseRateCents",
            "minRateCents",
            "maxRateCents",
            "automaticPricing",
        ]
        .iter()
        .any(|field| policy.get(*field).is_some());
        if explicit {
            let base = operations_int(policy, "baseRateCents", 1, JS_MAX_SAFE_INTEGER)?;
            let minimum = operations_int(policy, "minRateCents", 1, JS_MAX_SAFE_INTEGER)?;
            let maximum = operations_int(policy, "maxRateCents", 1, JS_MAX_SAFE_INTEGER)?;
            if obj(policy, "automaticPricing")?.as_bool().is_none()
                || minimum > base
                || base > maximum
                || nightly < minimum
                || nightly > maximum
            {
                return Err("经营存档数据损坏".into());
            }
        }
    }
    Ok(())
}

fn upgrade_rule(kind: &str, level: i64) -> Option<(i64, i64)> {
    match (kind, level) {
        ("workspace", 1) => Some((120_000, 2)),
        ("workspace", 2) => Some((200_000, 3)),
        ("view", 1) => Some((180_000, 2)),
        ("view", 2) => Some((280_000, 3)),
        ("familyCapacity", 1) => Some((160_000, 2)),
        ("familyCapacity", 2) => Some((240_000, 3)),
        ("privacy", 1) => Some((150_000, 2)),
        ("privacy", 2) => Some((240_000, 3)),
        _ => None,
    }
}

fn validate_operations_upgrades(value: &Value, current_day: i64) -> Result<(), String> {
    for (key, upgrade) in operations_object(value)? {
        let room_offer_id = operations_string(upgrade, "roomOfferId")?;
        let upgrade_id = operations_string(upgrade, "upgradeId")?;
        let level = operations_int(upgrade, "level", 1, JS_MAX_SAFE_INTEGER)?;
        let Some(kind_value) = upgrade.get("kind") else {
            continue;
        };
        let kind = kind_value
            .as_str()
            .ok_or_else(|| "经营存档数据损坏".to_string())?;
        let (cost, closure_days) =
            upgrade_rule(kind, level).ok_or_else(|| "经营存档数据损坏".to_string())?;
        let committed_day = operations_int(upgrade, "committedDay", 0, current_day)?;
        let remaining = operations_int(upgrade, "remainingClosureDays", 0, JS_MAX_SAFE_INTEGER)?;
        if upgrade_id != kind
            || key != &format!("{room_offer_id}:{kind}")
            || operations_int(upgrade, "costCents", 0, JS_MAX_SAFE_INTEGER)? != cost
            || remaining != (closure_days - (current_day - committed_day)).max(0)
        {
            return Err("经营存档数据损坏".into());
        }
    }
    Ok(())
}

fn validate_operations_loans(value: &Value) -> Result<(), String> {
    let mut ids = HashSet::new();
    let reserved = [
        "safety-loan:daily-settlement",
        "safety-loan:department-training",
        "safety-loan:room-renovation",
    ];
    for loan in value
        .as_array()
        .ok_or_else(|| "经营存档数据损坏".to_string())?
    {
        let id = operations_string(loan, "id")?;
        if !ids.insert(id) {
            return Err("经营存档数据损坏".into());
        }
        let principal = operations_int(loan, "principalCents", 1, JS_MAX_SAFE_INTEGER)?;
        let outstanding = operations_int(loan, "outstandingCents", 1, principal)?;
        let interest = operations_bps(loan, "dailyInterestBps")?;
        operations_int(loan, "minimumPaymentCents", 1, outstanding)?;
        if reserved.contains(&id) && interest != 10 {
            return Err("经营存档数据损坏".into());
        }
    }
    Ok(())
}

fn validate_operations_need(value: &Value, current_day: i64) -> Result<(), String> {
    operations_string(value, "id")?;
    operations_one_of(value, "segmentId", &OPERATIONS_SEGMENTS)?;
    operations_one_of(value, "kind", &["room-feature", "service", "price"])?;
    operations_int(value, "discoveredDay", 0, current_day)?;
    operations_bps(value, "strengthBps")?;
    Ok(())
}

#[derive(Clone, Copy)]
struct OperationsDailyTotals {
    day: i64,
    revenue: i64,
    operating: i64,
    finance: i64,
    net: i64,
    cash: i64,
    reputation: i64,
    available: i64,
    sold: i64,
    occupancy: i64,
    category_version: u8,
    room_revenue: i64,
    public_space_revenue: i64,
    department_cost: i64,
    facility_operating_cost: i64,
}

fn operations_report_error() -> String {
    "经营报告算术不一致".into()
}

fn operations_report_category_version(value: &Value) -> Result<u8, String> {
    let present = [
        "roomRevenueCents",
        "publicSpaceRevenueCents",
        "departmentCostCents",
        "facilityOperatingCostCents",
    ]
    .map(|key| value.get(key).is_some());
    match present {
        [false, false, false, false] => Ok(0),
        [true, false, true, false] => Ok(1),
        [true, true, true, true] => Ok(2),
        _ => Err(operations_report_error()),
    }
}

fn validate_operations_daily(
    value: &Value,
    current_day: i64,
) -> Result<OperationsDailyTotals, String> {
    let day = operations_int(value, "day", 1, 30)?;
    let mut segment_ids = HashSet::new();
    let mut segment_revenue = Vec::new();
    let mut segment_sold = Vec::new();
    let segments = operations_array(value, "segments")?;
    if segments.len() != OPERATIONS_SEGMENTS.len() {
        return Err("经营存档数据损坏".into());
    }
    for (index, segment) in segments.iter().enumerate() {
        let id = operations_one_of(segment, "segmentId", &OPERATIONS_SEGMENTS)?;
        if id != OPERATIONS_SEGMENTS[index] {
            return Err("经营存档数据损坏".into());
        }
        if !segment_ids.insert(id) {
            return Err("经营存档数据损坏".into());
        }
        operations_int(segment, "demand", 0, JS_MAX_SAFE_INTEGER)?;
        segment_sold.push(operations_int(
            segment,
            "soldRooms",
            0,
            JS_MAX_SAFE_INTEGER,
        )?);
        operations_int(segment, "averageRateCents", 0, JS_MAX_SAFE_INTEGER)?;
        segment_revenue.push(operations_int(
            segment,
            "revenueCents",
            0,
            JS_MAX_SAFE_INTEGER,
        )?);
        operations_bps(segment, "satisfactionBps")?;
    }
    let revenue = operations_int(value, "revenueCents", 0, JS_MAX_SAFE_INTEGER)?;
    let operating = operations_int(value, "operatingCostCents", 0, JS_MAX_SAFE_INTEGER)?;
    let finance = operations_int(value, "financeCostCents", 0, JS_MAX_SAFE_INTEGER)?;
    let net = operations_int(
        value,
        "netIncomeCents",
        -JS_MAX_SAFE_INTEGER,
        JS_MAX_SAFE_INTEGER,
    )?;
    let cash = operations_int(value, "endingCashCents", 0, JS_MAX_SAFE_INTEGER)?;
    let reputation = operations_bps(value, "reputationBps")?;
    let category_version = operations_report_category_version(value)?;
    let room_revenue = if category_version > 0 {
        operations_int(value, "roomRevenueCents", 0, JS_MAX_SAFE_INTEGER)?
    } else {
        revenue
    };
    let public_space_revenue = if category_version == 2 {
        operations_int(value, "publicSpaceRevenueCents", 0, JS_MAX_SAFE_INTEGER)?
    } else {
        0
    };
    let department_cost = if category_version > 0 {
        operations_int(value, "departmentCostCents", 0, JS_MAX_SAFE_INTEGER)?
    } else {
        operating
    };
    let facility_operating_cost = if category_version == 2 {
        operations_int(value, "facilityOperatingCostCents", 0, JS_MAX_SAFE_INTEGER)?
    } else {
        0
    };
    if checked_sum(segment_revenue)? != room_revenue
        || checked_sum([room_revenue, public_space_revenue])? != revenue
        || checked_sum([department_cost, facility_operating_cost])? != operating
        || checked_sum([revenue, -operating, -finance])? != net
        || operations_optional_int(value, "loanInterestCents", 0, JS_MAX_SAFE_INTEGER)?
            .is_some_and(|stored| stored != finance)
    {
        return Err(operations_report_error());
    }
    operations_optional_int(value, "cashShortfallCents", 0, JS_MAX_SAFE_INTEGER)?;
    let available =
        operations_optional_int(value, "availableRooms", 0, JS_MAX_SAFE_INTEGER)?.unwrap_or(0);
    let segment_sold = checked_sum(segment_sold)?;
    let sold = operations_optional_int(value, "soldRooms", 0, JS_MAX_SAFE_INTEGER)?
        .unwrap_or(segment_sold);
    let occupancy = operations_optional_int(value, "occupancyBps", 0, 10_000)?.unwrap_or(0);
    if value.get("soldRooms").is_some() && sold != segment_sold {
        return Err("经营存档数据损坏".into());
    }
    let expected_occupancy = if available == 0 {
        0
    } else {
        ((i128::from(sold) * 10_000) / i128::from(available)) as i64
    };
    if sold > available || (value.get("occupancyBps").is_some() && occupancy != expected_occupancy)
    {
        return Err("经营存档数据损坏".into());
    }
    operations_optional_int(value, "reputationDeltaBps", -10_000, 10_000)?;
    for lost in value
        .get("lostBookings")
        .map(|items| {
            items
                .as_array()
                .ok_or_else(|| "经营存档数据损坏".to_string())
        })
        .transpose()?
        .unwrap_or(&Vec::new())
    {
        operations_one_of(lost, "segmentId", &OPERATIONS_SEGMENTS)?;
        operations_one_of(
            lost,
            "code",
            &["hard-requirement", "price", "service", "no-inventory"],
        )?;
        operations_int(lost, "count", 0, JS_MAX_SAFE_INTEGER)?;
        operations_string(lost, "explanation")?;
    }
    for review in value
        .get("reviews")
        .map(|items| {
            items
                .as_array()
                .ok_or_else(|| "经营存档数据损坏".to_string())
        })
        .transpose()?
        .unwrap_or(&Vec::new())
    {
        operations_one_of(review, "segmentId", &OPERATIONS_SEGMENTS)?;
        operations_bps(review, "ratingBps")?;
        operations_string(review, "text")?;
    }
    for booking in value
        .get("bookings")
        .map(|items| {
            items
                .as_array()
                .ok_or_else(|| "经营存档数据损坏".to_string())
        })
        .transpose()?
        .unwrap_or(&Vec::new())
    {
        operations_one_of(booking, "segmentId", &OPERATIONS_SEGMENTS)?;
        operations_string(booking, "roomId")?;
        operations_string(booking, "offerId")?;
        operations_int(booking, "rateCents", 0, JS_MAX_SAFE_INTEGER)?;
    }
    for need in value
        .get("discoveredNeeds")
        .map(|items| {
            items
                .as_array()
                .ok_or_else(|| "经营存档数据损坏".to_string())
        })
        .transpose()?
        .unwrap_or(&Vec::new())
    {
        validate_operations_need(need, current_day)?;
    }
    Ok(OperationsDailyTotals {
        day,
        revenue,
        operating,
        finance,
        net,
        cash,
        reputation,
        available,
        sold,
        occupancy,
        category_version,
        room_revenue,
        public_space_revenue,
        department_cost,
        facility_operating_cost,
    })
}

fn validate_operations_aggregate(
    value: &Value,
    reports: &[OperationsDailyTotals],
    number_key: &str,
    number: i64,
) -> Result<(), String> {
    let first = reports
        .first()
        .ok_or_else(|| "经营存档数据损坏".to_string())?;
    let last = reports
        .last()
        .ok_or_else(|| "经营存档数据损坏".to_string())?;
    let revenue = checked_sum(reports.iter().map(|report| report.revenue))?;
    let operating = checked_sum(reports.iter().map(|report| report.operating))?;
    let finance = checked_sum(reports.iter().map(|report| report.finance))?;
    let net = checked_sum(reports.iter().map(|report| report.net))?;
    let available = checked_sum(reports.iter().map(|report| report.available))?;
    let sold = checked_sum(reports.iter().map(|report| report.sold))?;
    let occupancy =
        checked_sum(reports.iter().map(|report| report.occupancy))? / reports.len() as i64;
    let reputation =
        checked_sum(reports.iter().map(|report| report.reputation))? / reports.len() as i64;
    let aggregate_version = operations_report_category_version(value)?;
    let expected_version = if reports.iter().any(|report| report.category_version == 2) {
        2
    } else {
        0
    };
    let room_revenue = checked_sum(reports.iter().map(|report| report.room_revenue))?;
    let public_space_revenue =
        checked_sum(reports.iter().map(|report| report.public_space_revenue))?;
    let department_cost = checked_sum(reports.iter().map(|report| report.department_cost))?;
    let facility_operating_cost =
        checked_sum(reports.iter().map(|report| report.facility_operating_cost))?;
    if operations_int(value, number_key, 1, 4)? != number
        || operations_int(value, "startDay", 1, 30)? != first.day
        || operations_int(value, "endDay", 1, 30)? != last.day
    {
        return Err("经营存档数据损坏".into());
    }
    if operations_int(value, "revenueCents", 0, JS_MAX_SAFE_INTEGER)? != revenue
        || operations_int(
            value,
            "netIncomeCents",
            -JS_MAX_SAFE_INTEGER,
            JS_MAX_SAFE_INTEGER,
        )? != net
        || operations_optional_int(value, "operatingCostCents", 0, JS_MAX_SAFE_INTEGER)?
            .is_some_and(|stored| stored != operating)
        || operations_optional_int(value, "financeCostCents", 0, JS_MAX_SAFE_INTEGER)?
            .is_some_and(|stored| stored != finance)
        || operations_optional_int(value, "availableRooms", 0, JS_MAX_SAFE_INTEGER)?
            .is_some_and(|stored| stored != available)
        || operations_optional_int(value, "soldRooms", 0, JS_MAX_SAFE_INTEGER)?
            .is_some_and(|stored| stored != sold)
        || operations_optional_int(value, "averageOccupancyBps", 0, 10_000)?
            .is_some_and(|stored| stored != occupancy)
        || operations_optional_int(value, "reputationBps", 0, 10_000)?
            .is_some_and(|stored| stored != reputation)
        || aggregate_version != expected_version
        || (aggregate_version == 2
            && (operations_int(value, "roomRevenueCents", 0, JS_MAX_SAFE_INTEGER)? != room_revenue
                || operations_int(value, "publicSpaceRevenueCents", 0, JS_MAX_SAFE_INTEGER)?
                    != public_space_revenue
                || operations_int(value, "departmentCostCents", 0, JS_MAX_SAFE_INTEGER)?
                    != department_cost
                || operations_int(value, "facilityOperatingCostCents", 0, JS_MAX_SAFE_INTEGER)?
                    != facility_operating_cost))
    {
        return Err(operations_report_error());
    }
    if number_key == "week"
        && (value.get("averageOccupancyBps").is_none() || value.get("reputationBps").is_none())
    {
        return Err("经营存档数据损坏".into());
    }
    if number_key == "month"
        && (operations_int(value, "debtPaymentCents", 0, JS_MAX_SAFE_INTEGER)? != finance
            || operations_int(value, "endingCashCents", 0, JS_MAX_SAFE_INTEGER)? != last.cash)
    {
        return Err("经营存档数据损坏".into());
    }
    if let Some(code) = value.get("topReasonCode") {
        let code = code
            .as_str()
            .ok_or_else(|| "经营存档数据损坏".to_string())?;
        if ![
            "hard-requirement",
            "price",
            "service",
            "no-inventory",
            "none",
        ]
        .contains(&code)
        {
            return Err("经营存档数据损坏".into());
        }
    }
    for key in ["topResultCode", "suggestedActionCode"] {
        if value.get(key).is_some() {
            operations_string(value, key)?;
        }
    }
    Ok(())
}

fn validate_operations(value: &Value, current_day: i64, cash_cents: i64) -> Result<(), String> {
    operations_object(value)?;
    if operations_string(value, "rulesetVersion")? != "operations-v1" {
        return Err("经营存档数据损坏".into());
    }
    operations_one_of(value, "difficulty", &["casual", "management"])?;
    let reputation = operations_bps(value, "reputationBps")?;
    let maximum_reputation = operations_bps(value, "maximumReputationBps")?;
    if maximum_reputation < reputation || current_day > 30 {
        return Err("经营存档数据损坏".into());
    }
    validate_operations_departments(obj(value, "departments")?)?;
    validate_operations_prices(obj(value, "pricePolicies")?)?;
    validate_operations_upgrades(obj(value, "offerUpgrades")?, current_day)?;
    validate_operations_loans(obj(value, "loans")?)?;
    let mut need_ids = HashSet::new();
    for need in operations_array(value, "discoveredNeeds")? {
        validate_operations_need(need, current_day)?;
        if !need_ids.insert(operations_string(need, "id")?) {
            return Err("经营存档数据损坏".into());
        }
    }
    if let Some(mix) = value.get("segmentMix") {
        let mut total = 0;
        for (segment, bps) in operations_object(mix)? {
            if !OPERATIONS_SEGMENTS.contains(&segment.as_str()) {
                return Err("经营存档数据损坏".into());
            }
            let value = bps
                .as_i64()
                .filter(|number| (0..=10_000).contains(number))
                .ok_or_else(|| "经营存档数据损坏".to_string())?;
            total += value;
        }
        if total != 0 && total != 10_000 {
            return Err("经营存档数据损坏".into());
        }
    }
    let daily_values = operations_array(value, "dailyReports")?;
    if daily_values.len() > 30 {
        return Err("经营存档数据损坏".into());
    }
    let mut daily = Vec::new();
    for report in daily_values {
        let totals = validate_operations_daily(report, current_day)?;
        if daily
            .last()
            .is_some_and(|prior: &OperationsDailyTotals| totals.day <= prior.day)
        {
            return Err("经营存档数据损坏".into());
        }
        daily.push(totals);
    }
    if let Some(last) = daily.last() {
        if last.day != current_day || last.cash != cash_cents || last.reputation != reputation {
            return Err("经营存档数据损坏".into());
        }
    }
    let daily_by_day = daily
        .iter()
        .map(|report| (report.day, *report))
        .collect::<HashMap<_, _>>();
    let expected_weeks = (1..=4)
        .filter_map(|week| {
            let reports = (((week - 1) * 7 + 1)..=week * 7)
                .map(|day| daily_by_day.get(&day).copied())
                .collect::<Option<Vec<_>>>()?;
            Some((week, reports))
        })
        .collect::<Vec<_>>();
    let weekly = operations_array(value, "weeklyReports")?;
    if weekly.len() != expected_weeks.len() {
        return Err("经营存档数据损坏".into());
    }
    for (index, (week, reports)) in expected_weeks.iter().enumerate() {
        validate_operations_aggregate(&weekly[index], reports, "week", *week)?;
    }
    let closes = operations_array(value, "monthlyCloses")?;
    let month = (1..=30)
        .map(|day| daily_by_day.get(&day).copied())
        .collect::<Option<Vec<_>>>();
    if closes.len() != usize::from(month.is_some()) {
        return Err("经营存档数据损坏".into());
    }
    if let Some(month) = month {
        validate_operations_aggregate(&closes[0], &month, "month", 1)?;
    }
    let mut unlocks = HashSet::new();
    for unlock in operations_array(value, "unlockedContent")? {
        let key = unlock
            .as_str()
            .filter(|key| OPERATIONS_UNLOCKS.contains(key))
            .ok_or_else(|| "经营存档数据损坏".to_string())?;
        if !unlocks.insert(key) {
            return Err("经营存档数据损坏".into());
        }
    }
    let speed = operations_int(value, "timeSpeed", 0, 4)?;
    if ![0, 1, 2, 4].contains(&speed) {
        return Err("经营存档数据损坏".into());
    }
    let checkpoint = match obj(value, "lastOfflineCheckpointMs")? {
        Value::Null => None,
        _ => Some(operations_int(
            value,
            "lastOfflineCheckpointMs",
            0,
            JS_MAX_SAFE_INTEGER,
        )?),
    };
    let has_operations_history = !daily.is_empty() || !weekly.is_empty() || !closes.is_empty();
    if current_day == 30 && (speed != 0 || (has_operations_history && checkpoint.is_none())) {
        return Err("经营存档数据损坏".into());
    }
    Ok(())
}

fn validate_phase2(value: &Value) -> Result<String, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "存档数据损坏".to_string())?;
    for key in [
        "hotelGene",
        "roomMaster",
        "roomVariants",
        "corridorTemplate",
    ] {
        if !object.contains_key(key) {
            return Err("存档数据损坏".into());
        }
    }
    validate_gene(&object["hotelGene"])?;
    let variants = array(value, "roomVariants")?;
    let master = &object["roomMaster"];
    let mut variant_footprints = HashMap::new();
    if master.is_null() {
        if !variants.is_empty() {
            return Err("存档数据损坏".into());
        }
    } else {
        let columns = intv(master, "columns", 1, true)?;
        let rows = intv(master, "rows", 1, true)?;
        let master_id = strv(master, "id")?;
        validate_room(master, columns, rows, true)?;
        validate_gene(obj(master, "gene")?)?;
        for variant in variants {
            let variant_id = strv(variant, "id")?;
            if variant_id == master_id
                || strv(variant, "masterId")? != master_id
                || variant_footprints.contains_key(&variant_id)
                || ![0, 90, 180, 270].contains(&intv(variant, "rotation", 0, false)?)
                || obj(variant, "mirrored")?.as_bool().is_none()
            {
                return Err("存档数据损坏".into());
            }
            if let Some(kind) = variant.get("variantKind") {
                if !["king", "twin", "corner"]
                    .contains(&kind.as_str().ok_or_else(|| "存档数据损坏".to_string())?)
                {
                    return Err("存档数据损坏".into());
                }
            }
            let overrides = array(variant, "overrides")?;
            let mut unique_overrides = HashSet::new();
            for override_name in overrides {
                let override_name = override_name
                    .as_str()
                    .filter(|name| {
                        [
                            "bedType",
                            "area",
                            "view",
                            "furniture",
                            "featureIntensity",
                            "gene",
                        ]
                        .contains(name)
                    })
                    .ok_or_else(|| "存档数据损坏".to_string())?;
                if !unique_overrides.insert(override_name) {
                    return Err("存档数据损坏".into());
                }
            }
            validate_gene(obj(variant, "gene")?)?;
            let footprint = validate_room(variant, columns, rows, false)?;
            variant_footprints.insert(variant_id, footprint);
        }
    }

    let slots = if object["corridorTemplate"].is_null() {
        None
    } else {
        Some(validate_corridor_template(&object["corridorTemplate"])?)
    };
    if let Some(placements) = object.get("floorPlacements") {
        let placements = placements
            .as_array()
            .ok_or_else(|| "存档数据损坏".to_string())?;
        let slots = slots.as_ref().ok_or_else(|| "存档数据损坏".to_string())?;
        let mut placed_slots = HashSet::new();
        for placement in placements {
            let slot_id = strv(placement, "slotId")?;
            let variant_id = strv(placement, "variantId")?;
            let rotation = intv(placement, "rotation", 0, false)?;
            if !placed_slots.insert(slot_id.clone())
                || ![0, 90, 180, 270].contains(&rotation)
                || obj(placement, "mirrored")?.as_bool().is_none()
            {
                return Err("存档数据损坏".into());
            }
            let slot = slots
                .get(&slot_id)
                .ok_or_else(|| "存档数据损坏".to_string())?;
            let footprint = variant_footprints
                .get(&variant_id)
                .ok_or_else(|| "存档数据损坏".to_string())?;
            let (room_width, room_height) = if matches!(rotation, 90 | 270) {
                (footprint.height, footprint.width)
            } else {
                (footprint.width, footprint.height)
            };
            if room_width > slot.width || room_height > slot.height {
                return Err("存档数据损坏".into());
            }
        }
    }
    if let Some(design_visuals) = object.get("designVisuals") {
        validate_design_visuals(design_visuals)?;
    }
    let text = serde_json::to_string(value).map_err(|_| "存档数据损坏".to_string())?;
    let lower = text.to_ascii_lowercase();
    if lower.contains("base64")
        || lower.contains("api_key")
        || lower.contains("token")
        || lower.contains("secret")
    {
        return Err("视觉元数据不安全".into());
    }
    validate_visual_tree(value)?;
    Ok(text)
}

fn validate_visual_request(
    request: &Value,
    seen: &mut HashSet<String>,
    master_count: &mut usize,
    focus_count: &mut usize,
) -> Result<(), String> {
    let kind = strv(request, "kind")?;
    let key = match kind.as_str() {
        "master" => {
            *master_count += 1;
            "master".to_string()
        }
        "focus" => {
            let focus = strv(request, "focus")?;
            if focus.trim().is_empty() {
                return Err("存档数据损坏".into());
            }
            *focus_count += 1;
            format!("focus:{}", focus.trim())
        }
        _ => return Err("存档数据损坏".into()),
    };
    if !seen.insert(key) || *master_count > 1 || *focus_count > 3 {
        return Err("存档数据损坏".into());
    }
    Ok(())
}

fn validate_design_visuals(value: &Value) -> Result<(), String> {
    if strv(value, "status")? != "complete" {
        return Err("存档数据损坏".into());
    }
    let assets = array(value, "assets")?;
    let errors = array(value, "errors")?;
    if assets.len() + errors.len() > 4 {
        return Err("存档数据损坏".into());
    }
    let mut seen = HashSet::new();
    let mut master_count = 0;
    let mut focus_count = 0;
    for asset in assets {
        validate_visual_request(
            obj(asset, "request")?,
            &mut seen,
            &mut master_count,
            &mut focus_count,
        )?;
        let asset_path = strv(asset, "assetPath")?;
        if !asset_path.starts_with("/visuals/") || asset_path.contains("..") {
            return Err("视觉资源命名空间无效".into());
        }
    }
    for error in errors {
        validate_visual_request(
            obj(error, "request")?,
            &mut seen,
            &mut master_count,
            &mut focus_count,
        )?;
        if strv(error, "message")?.trim().is_empty()
            || obj(error, "retryable")?.as_bool() != Some(true)
        {
            return Err("存档数据损坏".into());
        }
    }
    Ok(())
}

fn validate_gene(value: &Value) -> Result<(), String> {
    for key in ["palette", "metal", "lighting", "mood"] {
        strv(value, key)?;
    }
    let materials = obj(value, "materials")?
        .as_array()
        .ok_or_else(|| "存档数据损坏".to_string())?;
    if materials.is_empty()
        || materials
            .iter()
            .any(|item| item.as_str().is_none_or(str::is_empty))
    {
        return Err("存档数据损坏".into());
    }
    Ok(())
}

fn validate_visual_tree(value: &Value) -> Result<(), String> {
    match value {
        Value::Object(map) => {
            if let Some(asset) = map.get("assetPath").and_then(Value::as_str) {
                if !asset.starts_with("/visuals/") || asset.contains("..") {
                    return Err("视觉资源命名空间无效".into());
                }
            }
            for child in map.values() {
                validate_visual_tree(child)?;
            }
        }
        Value::Array(items) => {
            for child in items {
                validate_visual_tree(child)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    type SnapshotMutation = (&'static str, Box<dyn Fn(&mut Value)>);

    fn root(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("cloud-inn-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }
    fn game() -> Value {
        json!({"schemaVersion":1,"rulesetVersion":"prototype-v1","saveId":"save-1","revision":1,"phase":"design","currentDay":0,"cashCents":100,"rateCents":10,"roomBlueprint":null,"floor":{"id":"prototype-floor","rooms":[]},"reports":[],"latestReport":null})
    }
    fn operations_departments() -> Value {
        json!({
            "frontOffice": {"id":"frontOffice","staffing":0,"dailyBudgetCents":0,"trainingBps":0,"serviceStandardBps":5000},
            "housekeeping": {"id":"housekeeping","staffing":0,"dailyBudgetCents":0,"trainingBps":0,"serviceStandardBps":5000},
            "foodAndBeverage": {"id":"foodAndBeverage","staffing":0,"dailyBudgetCents":0,"trainingBps":0,"serviceStandardBps":5000},
            "engineering": {"id":"engineering","staffing":0,"dailyBudgetCents":0,"trainingBps":0,"serviceStandardBps":5000},
            "security": {"id":"security","staffing":0,"dailyBudgetCents":0,"trainingBps":0,"serviceStandardBps":5000},
            "guestRelations": {"id":"guestRelations","staffing":0,"dailyBudgetCents":0,"trainingBps":0,"serviceStandardBps":5000}
        })
    }
    fn minimal_operations() -> Value {
        json!({
            "rulesetVersion":"operations-v1",
            "difficulty":"casual",
            "reputationBps":5000,
            "departments":operations_departments(),
            "pricePolicies":{},
            "offerUpgrades":{},
            "loans":[],
            "discoveredNeeds":[],
            "dailyReports":[],
            "weeklyReports":[],
            "monthlyCloses":[],
            "maximumReputationBps":5000,
            "unlockedContent":[],
            "timeSpeed":0,
            "lastOfflineCheckpointMs":null
        })
    }
    fn operations_daily(day: i64) -> Value {
        json!({
            "day":day,
            "segments":[
                {"segmentId":"business","demand":2,"soldRooms":1,"averageRateCents":1000,"revenueCents":1000,"satisfactionBps":5000 + day},
                {"segmentId":"couple","demand":0,"soldRooms":0,"averageRateCents":0,"revenueCents":0,"satisfactionBps":5000},
                {"segmentId":"family","demand":0,"soldRooms":0,"averageRateCents":0,"revenueCents":0,"satisfactionBps":5000},
                {"segmentId":"leisure","demand":0,"soldRooms":0,"averageRateCents":0,"revenueCents":0,"satisfactionBps":5000},
                {"segmentId":"high-net-worth","demand":0,"soldRooms":0,"averageRateCents":0,"revenueCents":0,"satisfactionBps":5000},
                {"segmentId":"cultural-experience","demand":0,"soldRooms":0,"averageRateCents":0,"revenueCents":0,"satisfactionBps":5000}
            ],
            "revenueCents":1000,"operatingCostCents":100,"financeCostCents":10,"netIncomeCents":890,
            "endingCashCents":1_000_000 + day,"reputationBps":5000 + day,
            "availableRooms":2,"soldRooms":1,"occupancyBps":5000,
            "departmentCostCents":100,"roomRevenueCents":1000,"loanInterestCents":10,"cashShortfallCents":0,
            "lostBookings":[{"segmentId":"couple","code":"price","count":1,"explanation":"rate"}],
            "reviews":[{"segmentId":"business","ratingBps":5000 + day,"text":"ok"}],
            "bookings":[{"segmentId":"business","roomId":"room-1","offerId":"offer-1","rateCents":1000}],
            "reputationDeltaBps":1,
            "discoveredNeeds":[]
        })
    }
    fn operations_week(week: i64) -> Value {
        let start_day = (week - 1) * 7 + 1;
        let end_day = week * 7;
        json!({
            "week":week,"startDay":start_day,"endDay":end_day,
            "revenueCents":7000,"operatingCostCents":700,"financeCostCents":70,"netIncomeCents":6230,
            "availableRooms":14,"soldRooms":7,"averageOccupancyBps":5000,
            "reputationBps":5000 + (start_day + end_day) / 2,
            "topResultCode":"segment:business","topReasonCode":"price","suggestedActionCode":"adjust-pricing"
        })
    }
    fn full_operations_game() -> Value {
        let daily = (1..=30).map(operations_daily).collect::<Vec<_>>();
        let legacy = (1..=30).map(|day| json!({"day":day})).collect::<Vec<_>>();
        let mut operations = minimal_operations();
        operations["dailyReports"] = json!(daily);
        operations["weeklyReports"] = json!((1..=4).map(operations_week).collect::<Vec<_>>());
        operations["monthlyCloses"] = json!([{
            "month":1,"startDay":1,"endDay":30,"revenueCents":30000,"operatingCostCents":3000,
            "financeCostCents":300,"netIncomeCents":26700,"debtPaymentCents":300,
            "availableRooms":60,"soldRooms":30,"averageOccupancyBps":5000,"reputationBps":5015,
            "endingCashCents":1_000_030,"topResultCode":"segment:business","topReasonCode":"price",
            "suggestedActionCode":"adjust-pricing"
        }]);
        operations["reputationBps"] = json!(5030);
        operations["maximumReputationBps"] = json!(6000);
        operations["unlockedContent"] = json!(["operations:pricing-automation"]);
        operations["timeSpeed"] = json!(0);
        operations["lastOfflineCheckpointMs"] = json!(30_000);
        operations["pricePolicies"] = json!({"offer-1":{
            "roomOfferId":"offer-1","nightlyRateCents":1000,"baseRateCents":1000,
            "minRateCents":800,"maxRateCents":1200,"automaticPricing":true
        }});
        operations["offerUpgrades"] = json!({
            "offer-1:workspace":{"roomOfferId":"offer-1","upgradeId":"workspace","kind":"workspace","level":1,"remainingClosureDays":0,"committedDay":2,"costCents":120000},
            "legacy":{"roomOfferId":"removed-offer","upgradeId":"old-custom","level":42}
        });
        operations["loans"] = json!([{"id":"loan-1","principalCents":10000,"outstandingCents":5000,"dailyInterestBps":100,"minimumPaymentCents":500}]);
        let mut state = game();
        state["currentDay"] = json!(30);
        state["cashCents"] = json!(1_000_030);
        state["reports"] = json!(legacy);
        state["latestReport"] = json!({"day":30});
        state["operations"] = operations;
        state
    }
    fn blueprint_game(revision: i64, rooms: Value) -> Value {
        let mut g = game();
        g["revision"] = json!(revision);
        g["roomBlueprint"] = json!({"id":"bp-1","name":"Suite","columns":1,"rows":1,"cells":[],"metrics":{"areaSquareMeters":1,"buildCostCents":1,"suggestedRateCents":1,"businessFitBps":1},"visual":{"status":"idle"}});
        g["floor"]["rooms"] = rooms;
        g
    }
    fn blueprint_with_openings_game() -> Value {
        let mut g = game();
        g["roomBlueprint"] = json!({
            "id": "bp-openings",
            "name": "Opening Suite",
            "columns": 2,
            "rows": 1,
            "cells": [
                {"x": 0, "y": 0, "zone": "bedroom"},
                {"x": 1, "y": 0, "zone": "bathroom"}
            ],
            "openings": {
                "walls": [],
                "doors": [{"x": 0, "y": 0, "side": "north"}],
                "windows": [{"x": 1, "y": 0, "side": "east"}]
            },
            "metrics": {
                "areaSquareMeters": 0.5,
                "buildCostCents": 2_200_000,
                "suggestedRateCents": 33_000,
                "businessFitBps": 2_625
            },
            "visual": {"status": "idle"}
        });
        g
    }
    fn valid_phase2_game() -> Value {
        let mut g = game();
        let gene = json!({
            "palette": "jade",
            "materials": ["wood"],
            "metal": "bronze",
            "lighting": "warm",
            "mood": "quiet"
        });
        let cells = json!([
            {"x": 0, "y": 0, "zone": "bedroom"},
            {"x": 1, "y": 0, "zone": "bathroom"}
        ]);
        let metrics = json!({
            "areaSquareMeters": 0.5,
            "buildCostCents": 2_200_000,
            "suggestedRateCents": 33_000,
            "businessFitBps": 2_625
        });
        let openings = json!({
            "walls": [],
            "doors": [{"x": 0, "y": 0, "side": "north"}],
            "windows": []
        });
        g["phase2"] = json!({
            "hotelGene": gene,
            "roomMaster": {
                "id": "master-1", "name": "Suite", "columns": 2, "rows": 1,
                "cells": cells, "metrics": metrics, "visual": {"status": "idle"},
                "gene": gene, "openings": openings
            },
            "roomVariants": [{
                "id": "variant-1", "name": "King", "masterId": "master-1",
                "variantKind": "king", "cells": cells, "rotation": 0,
                "mirrored": false, "overrides": ["bedType"], "gene": gene,
                "metrics": metrics, "visual": {"status": "idle"}, "openings": openings
            }],
            "corridorTemplate": {
                "id": "test-ring", "name": "Test ring", "width": 6, "height": 6,
                "core": [{"x": 2, "y": 3}],
                "corridor": [{"x": 2, "y": 0}],
                "entrances": [{"x": 2, "y": 1}, {"x": 2, "y": 2}],
                "slots": [{"id": "north", "anchor": {"x": 3, "y": 0}, "width": 2, "height": 2}]
            },
            "floorPlacements": [{
                "slotId": "north", "variantId": "variant-1", "rotation": 0,
                "mirrored": false
            }]
        });
        g
    }
    #[test]
    fn creates_and_migrates_new_db() {
        let r = SaveRepository::new(root("migrate"));
        assert_eq!(r.load_game("save-1").unwrap(), None);
        assert!(r.db_path("save-1").exists());
        assert_eq!(
            r.open("save-1")
                .unwrap()
                .query_row::<i64, _, _>("SELECT count(*) FROM schema_migrations", [], |x| x.get(0))
                .unwrap(),
            6
        );
    }
    #[test]
    fn operations_are_optional_and_minimal_state_is_valid() {
        assert!(validate_game(&game()).is_ok());
        let mut state = game();
        state["operations"] = minimal_operations();
        assert!(validate_game(&state).is_ok());
    }

    #[test]
    fn operations_allow_history_that_starts_after_a_legacy_game_day() {
        let mut state = game();
        state["currentDay"] = json!(5);
        state["cashCents"] = json!(1_000_005);
        state["reports"] = json!((1..=5).map(|day| json!({"day":day})).collect::<Vec<_>>());
        state["latestReport"] = json!({"day":5});
        let mut operations = minimal_operations();
        operations["dailyReports"] = json!([operations_daily(5)]);
        operations["reputationBps"] = json!(5005);
        operations["maximumReputationBps"] = json!(5005);
        state["operations"] = operations;

        assert!(validate_game(&state).is_ok());
    }

    #[test]
    fn operations_day_30_round_trips_through_sqlite() {
        let repository = SaveRepository::new(root("operations-roundtrip"));
        let state = full_operations_game();

        repository.commit_game(0, state.clone()).unwrap();

        assert_eq!(repository.load_game("save-1").unwrap(), Some(state));
    }

    #[test]
    fn operations_day_30_fresh_legacy_initialization_round_trips() {
        let repository = SaveRepository::new(root("operations-day-30-fresh"));
        let mut state = game();
        state["currentDay"] = json!(30);
        state["reports"] = json!((1..=30).map(|day| json!({"day":day})).collect::<Vec<_>>());
        state["latestReport"] = json!({"day":30});
        state["operations"] = minimal_operations();

        repository.commit_game(0, state.clone()).unwrap();

        assert_eq!(repository.load_game("save-1").unwrap(), Some(state));
    }

    #[test]
    fn operations_reject_invalid_scalars_catalogs_and_history() {
        let mutations: Vec<SnapshotMutation> = vec![
            (
                "ruleset",
                Box::new(|g| g["operations"]["rulesetVersion"] = json!("operations-v2")),
            ),
            (
                "difficulty",
                Box::new(|g| g["operations"]["difficulty"] = json!("expert")),
            ),
            (
                "missing department",
                Box::new(|g| {
                    g["operations"]["departments"]
                        .as_object_mut()
                        .unwrap()
                        .remove("security");
                }),
            ),
            (
                "extra department",
                Box::new(|g| g["operations"]["departments"]["spa"] = json!({"id":"spa"})),
            ),
            (
                "department mismatch",
                Box::new(|g| {
                    g["operations"]["departments"]["security"]["id"] = json!("engineering")
                }),
            ),
            (
                "unsafe money",
                Box::new(|g| {
                    g["operations"]["departments"]["security"]["dailyBudgetCents"] =
                        json!(9_007_199_254_740_992_i64)
                }),
            ),
            (
                "fraction bps",
                Box::new(|g| g["operations"]["reputationBps"] = json!(1.5)),
            ),
            (
                "bps range",
                Box::new(|g| g["operations"]["reputationBps"] = json!(10001)),
            ),
            (
                "speed",
                Box::new(|g| g["operations"]["timeSpeed"] = json!(3)),
            ),
            (
                "negative checkpoint",
                Box::new(|g| g["operations"]["lastOfflineCheckpointMs"] = json!(-1)),
            ),
            (
                "unsafe checkpoint",
                Box::new(|g| {
                    g["operations"]["lastOfflineCheckpointMs"] = json!(9_007_199_254_740_992_i64)
                }),
            ),
            (
                "day 30 speed",
                Box::new(|g| g["operations"]["timeSpeed"] = json!(1)),
            ),
            (
                "day 30 checkpoint",
                Box::new(|g| g["operations"]["lastOfflineCheckpointMs"] = Value::Null),
            ),
            (
                "unknown segment",
                Box::new(|g| {
                    g["operations"]["dailyReports"][0]["segments"][0]["segmentId"] = json!("vip")
                }),
            ),
            (
                "duplicate day",
                Box::new(|g| g["operations"]["dailyReports"][1]["day"] = json!(1)),
            ),
            (
                "nonmonotonic day",
                Box::new(|g| {
                    g["operations"]["dailyReports"]
                        .as_array_mut()
                        .unwrap()
                        .swap(1, 2)
                }),
            ),
            (
                "too many days",
                Box::new(|g| {
                    g["operations"]["dailyReports"]
                        .as_array_mut()
                        .unwrap()
                        .push(operations_daily(31))
                }),
            ),
            (
                "outer day mismatch",
                Box::new(|g| g["currentDay"] = json!(29)),
            ),
            (
                "outer cash mismatch",
                Box::new(|g| g["cashCents"] = json!(1_000_031)),
            ),
            (
                "operations reputation mismatch",
                Box::new(|g| g["operations"]["reputationBps"] = json!(5029)),
            ),
        ];
        for (label, mutate) in mutations {
            let mut malformed = full_operations_game();
            mutate(&mut malformed);
            assert!(validate_game(&malformed).is_err(), "{label}");
        }
    }

    #[test]
    fn operations_reject_inconsistent_daily_and_periodic_reports() {
        let mutations: Vec<SnapshotMutation> = vec![
            (
                "segment sum",
                Box::new(|g| g["operations"]["dailyReports"][0]["revenueCents"] = json!(1001)),
            ),
            (
                "net total",
                Box::new(|g| g["operations"]["dailyReports"][0]["netIncomeCents"] = json!(891)),
            ),
            (
                "room revenue",
                Box::new(|g| g["operations"]["dailyReports"][0]["roomRevenueCents"] = json!(999)),
            ),
            (
                "department cost",
                Box::new(|g| g["operations"]["dailyReports"][0]["departmentCostCents"] = json!(99)),
            ),
            (
                "finance cost",
                Box::new(|g| g["operations"]["dailyReports"][0]["loanInterestCents"] = json!(9)),
            ),
            (
                "invalid review",
                Box::new(|g| {
                    g["operations"]["dailyReports"][0]["reviews"][0]["ratingBps"] = json!(10001)
                }),
            ),
            (
                "invalid booking",
                Box::new(|g| {
                    g["operations"]["dailyReports"][0]["bookings"][0]["rateCents"] = json!(-1)
                }),
            ),
            (
                "invalid lost code",
                Box::new(|g| {
                    g["operations"]["dailyReports"][0]["lostBookings"][0]["code"] = json!("unknown")
                }),
            ),
            (
                "missing weekly",
                Box::new(|g| {
                    g["operations"]["weeklyReports"]
                        .as_array_mut()
                        .unwrap()
                        .pop();
                }),
            ),
            (
                "weekly number",
                Box::new(|g| g["operations"]["weeklyReports"][0]["week"] = json!(2)),
            ),
            (
                "weekly window",
                Box::new(|g| g["operations"]["weeklyReports"][0]["startDay"] = json!(2)),
            ),
            (
                "weekly total",
                Box::new(|g| g["operations"]["weeklyReports"][0]["revenueCents"] = json!(7001)),
            ),
            (
                "weekly reputation",
                Box::new(|g| g["operations"]["weeklyReports"][0]["reputationBps"] = json!(5005)),
            ),
            (
                "monthly duplicate",
                Box::new(|g| {
                    let close = g["operations"]["monthlyCloses"][0].clone();
                    g["operations"]["monthlyCloses"]
                        .as_array_mut()
                        .unwrap()
                        .push(close);
                }),
            ),
            (
                "monthly boundary",
                Box::new(|g| g["operations"]["monthlyCloses"][0]["endDay"] = json!(29)),
            ),
            (
                "monthly total",
                Box::new(|g| g["operations"]["monthlyCloses"][0]["netIncomeCents"] = json!(26701)),
            ),
            (
                "monthly cash",
                Box::new(|g| {
                    g["operations"]["monthlyCloses"][0]["endingCashCents"] = json!(1_000_031)
                }),
            ),
        ];
        for (label, mutate) in mutations {
            let mut malformed = full_operations_game();
            mutate(&mut malformed);
            assert!(validate_game(&malformed).is_err(), "{label}");
        }
    }

    #[test]
    fn operations_reject_incomplete_daily_segment_catalogs() {
        let cases = vec![
            ("empty", json!([])),
            (
                "one valid",
                json!([{"segmentId":"business","demand":0,"soldRooms":0,"averageRateCents":0,"revenueCents":0,"satisfactionBps":5000}]),
            ),
            (
                "missing one",
                json!([
                    {"segmentId":"business","demand":0,"soldRooms":0,"averageRateCents":0,"revenueCents":0,"satisfactionBps":5000},
                    {"segmentId":"couple","demand":0,"soldRooms":0,"averageRateCents":0,"revenueCents":0,"satisfactionBps":5000},
                    {"segmentId":"family","demand":0,"soldRooms":0,"averageRateCents":0,"revenueCents":0,"satisfactionBps":5000},
                    {"segmentId":"leisure","demand":0,"soldRooms":0,"averageRateCents":0,"revenueCents":0,"satisfactionBps":5000},
                    {"segmentId":"high-net-worth","demand":0,"soldRooms":0,"averageRateCents":0,"revenueCents":0,"satisfactionBps":5000}
                ]),
            ),
        ];
        for (label, segments) in cases {
            let mut report = operations_daily(1);
            report["segments"] = segments;
            report["revenueCents"] = json!(0);
            report["roomRevenueCents"] = json!(0);
            report["netIncomeCents"] = json!(-110);
            report["soldRooms"] = json!(0);
            report["occupancyBps"] = json!(0);
            let mut operations = minimal_operations();
            operations["dailyReports"] = json!([report]);
            operations["reputationBps"] = json!(5001);
            operations["maximumReputationBps"] = json!(5001);
            let mut state = game();
            state["currentDay"] = json!(1);
            state["cashCents"] = json!(1_000_001);
            state["reports"] = json!([{"day":1}]);
            state["latestReport"] = json!({"day":1});
            state["operations"] = operations;

            assert!(validate_game(&state).is_err(), "{label}");
        }
    }

    #[test]
    fn operations_reject_invalid_finance_upgrades_unlocks_and_market_state() {
        let mutations: Vec<SnapshotMutation> = vec![
            (
                "empty loan",
                Box::new(|g| g["operations"]["loans"][0]["id"] = json!("")),
            ),
            (
                "duplicate loan",
                Box::new(|g| {
                    let loan = g["operations"]["loans"][0].clone();
                    g["operations"]["loans"].as_array_mut().unwrap().push(loan);
                }),
            ),
            (
                "zero balance",
                Box::new(|g| g["operations"]["loans"][0]["outstandingCents"] = json!(0)),
            ),
            (
                "balance principal",
                Box::new(|g| g["operations"]["loans"][0]["outstandingCents"] = json!(10001)),
            ),
            (
                "payment balance",
                Box::new(|g| g["operations"]["loans"][0]["minimumPaymentCents"] = json!(5001)),
            ),
            (
                "reserved contract",
                Box::new(|g| {
                    g["operations"]["loans"][0]["id"] = json!("safety-loan:daily-settlement")
                }),
            ),
            (
                "price key",
                Box::new(|g| {
                    g["operations"]["pricePolicies"]["offer-1"]["roomOfferId"] = json!("offer-2")
                }),
            ),
            (
                "price range",
                Box::new(|g| {
                    g["operations"]["pricePolicies"]["offer-1"]["minRateCents"] = json!(1001)
                }),
            ),
            (
                "price money",
                Box::new(|g| {
                    g["operations"]["pricePolicies"]["offer-1"]["nightlyRateCents"] = json!(-1)
                }),
            ),
            (
                "upgrade missing",
                Box::new(|g| {
                    g["operations"]["offerUpgrades"]["offer-1:workspace"]
                        .as_object_mut()
                        .unwrap()
                        .remove("costCents");
                }),
            ),
            (
                "upgrade key",
                Box::new(|g| {
                    let value = g["operations"]["offerUpgrades"]["offer-1:workspace"].take();
                    g["operations"]["offerUpgrades"]["bad"] = value;
                }),
            ),
            (
                "upgrade id",
                Box::new(|g| {
                    g["operations"]["offerUpgrades"]["offer-1:workspace"]["upgradeId"] =
                        json!("view")
                }),
            ),
            (
                "upgrade kind",
                Box::new(|g| {
                    g["operations"]["offerUpgrades"]["offer-1:workspace"]["kind"] = json!("pool")
                }),
            ),
            (
                "upgrade closure",
                Box::new(|g| {
                    g["operations"]["offerUpgrades"]["offer-1:workspace"]["remainingClosureDays"] =
                        json!(3)
                }),
            ),
            (
                "upgrade cost",
                Box::new(|g| {
                    g["operations"]["offerUpgrades"]["offer-1:workspace"]["costCents"] = json!(1)
                }),
            ),
            (
                "upgrade day",
                Box::new(|g| {
                    g["operations"]["offerUpgrades"]["offer-1:workspace"]["committedDay"] =
                        json!(31)
                }),
            ),
            (
                "maximum reputation",
                Box::new(|g| g["operations"]["maximumReputationBps"] = json!(5029)),
            ),
            (
                "duplicate unlock",
                Box::new(|g| {
                    g["operations"]["unlockedContent"] = json!([
                        "operations:pricing-automation",
                        "operations:pricing-automation"
                    ])
                }),
            ),
            (
                "unknown unlock",
                Box::new(|g| g["operations"]["unlockedContent"] = json!(["unknown"])),
            ),
            (
                "unknown need",
                Box::new(
                    |g| g["operations"]["discoveredNeeds"] = json!([{"id":"n","segmentId":"vip","kind":"service","discoveredDay":1,"strengthBps":1}]),
                ),
            ),
            (
                "duplicate need",
                Box::new(
                    |g| g["operations"]["discoveredNeeds"] = json!([{"id":"n","segmentId":"business","kind":"service","discoveredDay":1,"strengthBps":1},{"id":"n","segmentId":"business","kind":"price","discoveredDay":2,"strengthBps":1}]),
                ),
            ),
            (
                "segment mix",
                Box::new(|g| g["operations"]["segmentMix"] = json!({"business":5000,"vip":5000})),
            ),
        ];
        for (label, mutate) in mutations {
            let mut malformed = full_operations_game();
            mutate(&mut malformed);
            assert!(validate_game(&malformed).is_err(), "{label}");
        }
    }
    #[test]
    fn commits_and_loads_full_state() {
        let r = SaveRepository::new(root("full"));
        let g = game();
        r.commit_game(0, g.clone()).unwrap();
        assert_eq!(r.load_game("save-1").unwrap(), Some(g));
    }

    #[test]
    fn commits_and_loads_blueprint_openings() {
        let r = SaveRepository::new(root("blueprint-openings"));
        let game = blueprint_with_openings_game();

        r.commit_game(0, game.clone()).unwrap();

        assert_eq!(r.load_game("save-1").unwrap(), Some(game));
    }

    #[test]
    fn rejects_malformed_blueprint_openings() {
        let mut game = blueprint_with_openings_game();
        game["roomBlueprint"]["openings"]["doors"][0]["side"] = json!("up");

        assert!(validate_game(&game).is_err());
    }

    #[test]
    fn persists_phase2_design_envelope_and_rejects_unsafe_visual_metadata() {
        let r = SaveRepository::new(root("phase2-roundtrip"));
        let mut g = game();
        g["phase2"] = json!({
            "hotelGene": {"palette": "jade", "materials": ["wood"], "metal":"bronze", "lighting": "warm", "mood": "quiet"},
            "roomMaster": null,
            "roomVariants": [],
            "corridorTemplate": null
        });
        r.commit_game(0, g.clone()).unwrap();
        assert_eq!(r.load_game("save-1").unwrap(), Some(g));

        let mut unsafe_game = game();
        unsafe_game["phase2"] = json!({
            "hotelGene": {}, "roomMaster": null, "roomVariants": [],
            "corridorTemplate": null, "visual": {"assetPath": "data:image/png;base64,AAAA"}
        });
        assert!(r.commit_game(1, unsafe_game).is_err());
    }

    #[test]
    fn rejects_malformed_phase2_envelope() {
        let r = SaveRepository::new(root("phase2-malformed"));
        let mut g = game();
        g["phase2"] = json!({"roomVariants": []});
        assert!(r.commit_game(0, g).is_err());
    }

    #[test]
    fn rejects_duplicate_and_malformed_phase2_rooms() {
        let valid = valid_phase2_game();
        assert!(validate_game(&valid).is_ok());

        let mut variant_without_visual = valid.clone();
        variant_without_visual["phase2"]["roomVariants"][0]
            .as_object_mut()
            .unwrap()
            .remove("visual");
        assert!(
            validate_game(&variant_without_visual).is_ok(),
            "room variants do not own visual state"
        );

        let mut duplicate_id = valid.clone();
        duplicate_id["phase2"]["roomVariants"] = json!([
            duplicate_id["phase2"]["roomVariants"][0].clone(),
            duplicate_id["phase2"]["roomVariants"][0].clone()
        ]);
        assert!(
            validate_game(&duplicate_id).is_err(),
            "duplicate variant id"
        );

        let mut master_id_collision = valid.clone();
        master_id_collision["phase2"]["roomVariants"][0]["id"] = json!("master-1");
        master_id_collision["phase2"]["floorPlacements"][0]["variantId"] = json!("master-1");
        assert!(
            validate_game(&master_id_collision).is_err(),
            "master/variant id collision"
        );

        let mutations: Vec<SnapshotMutation> = vec![
            (
                "invalid zone",
                Box::new(|g| g["phase2"]["roomMaster"]["cells"][0]["zone"] = json!("spa")),
            ),
            (
                "cell out of bounds",
                Box::new(|g| g["phase2"]["roomVariants"][0]["cells"][0]["x"] = json!(2)),
            ),
            (
                "duplicate cell",
                Box::new(|g| {
                    g["phase2"]["roomVariants"][0]["cells"][1] =
                        g["phase2"]["roomVariants"][0]["cells"][0].clone()
                }),
            ),
            (
                "invalid metrics",
                Box::new(|g| g["phase2"]["roomMaster"]["metrics"]["areaSquareMeters"] = json!(-1)),
            ),
            (
                "invalid override",
                Box::new(|g| g["phase2"]["roomVariants"][0]["overrides"] = json!(["pool"])),
            ),
        ];
        for (label, mutate) in mutations {
            let mut malformed = valid.clone();
            mutate(&mut malformed);
            assert!(validate_game(&malformed).is_err(), "{label}");
        }
    }

    #[test]
    fn phase2_metrics_match_typescript_half_rounding() {
        let metrics = json!({
            "areaSquareMeters": 23.75,
            "buildCostCents": 11_500_000,
            "suggestedRateCents": 79_500,
            "businessFitBps": 8_438
        });
        assert!(validate_metrics(&metrics, 95).is_ok());
    }

    #[test]
    fn rejects_malformed_phase2_openings() {
        let valid = valid_phase2_game();
        let mutations: Vec<SnapshotMutation> = vec![
            (
                "invalid side",
                Box::new(|g| {
                    g["phase2"]["roomMaster"]["openings"]["doors"][0]["side"] = json!("up")
                }),
            ),
            (
                "invalid kind",
                Box::new(|g| {
                    g["phase2"]["roomMaster"]["openings"]["doors"][0]["kind"] = json!("window")
                }),
            ),
            (
                "opening not on a room cell",
                Box::new(|g| g["phase2"]["roomMaster"]["openings"]["doors"][0]["y"] = json!(1)),
            ),
            (
                "opening not on boundary side",
                Box::new(|g| {
                    g["phase2"]["roomMaster"]["openings"]["doors"][0]["side"] = json!("east")
                }),
            ),
        ];
        for (label, mutate) in mutations {
            let mut malformed = valid.clone();
            mutate(&mut malformed);
            assert!(validate_game(&malformed).is_err(), "{label}");
        }
    }

    #[test]
    fn persists_phase2_design_visual_assets_and_errors() {
        let repository = SaveRepository::new(root("phase2-design-visuals"));
        let mut game = valid_phase2_game();
        game["phase2"]["designVisuals"] = json!({
            "status": "complete",
            "assets": [
                {"request": {"kind": "master"}, "assetPath": "/visuals/master.png"},
                {"request": {"kind": "focus", "focus": "bathroom"}, "assetPath": "/visuals/bathroom.png"}
            ],
            "errors": [
                {"request": {"kind": "focus", "focus": "view"}, "message": "网络暂不可用", "retryable": true}
            ]
        });

        repository.commit_game(0, game.clone()).unwrap();

        assert_eq!(repository.load_game("save-1").unwrap(), Some(game));
    }

    #[test]
    fn rejects_malformed_phase2_design_visual_metadata() {
        let mut valid = valid_phase2_game();
        valid["phase2"]["designVisuals"] = json!({
            "status": "complete",
            "assets": [
                {"request": {"kind": "master"}, "assetPath": "/visuals/master.png"},
                {"request": {"kind": "focus", "focus": "bathroom"}, "assetPath": "/visuals/bathroom.png"}
            ],
            "errors": []
        });
        let mutations: Vec<SnapshotMutation> = vec![
            (
                "duplicate master",
                Box::new(|g| {
                    let asset = g["phase2"]["designVisuals"]["assets"][0].clone();
                    g["phase2"]["designVisuals"]["assets"]
                        .as_array_mut()
                        .unwrap()
                        .push(asset);
                }),
            ),
            (
                "empty focus",
                Box::new(|g| {
                    g["phase2"]["designVisuals"]["assets"][1]["request"]["focus"] = json!("");
                }),
            ),
            (
                "duplicate focus",
                Box::new(|g| {
                    let asset = g["phase2"]["designVisuals"]["assets"][1].clone();
                    g["phase2"]["designVisuals"]["assets"]
                        .as_array_mut()
                        .unwrap()
                        .push(asset);
                }),
            ),
            (
                "unsafe asset",
                Box::new(|g| {
                    g["phase2"]["designVisuals"]["assets"][0]["assetPath"] =
                        json!("data:image/png;base64,x");
                }),
            ),
            (
                "too many focuses",
                Box::new(|g| {
                    for focus in ["lighting", "view", "extra"] {
                        g["phase2"]["designVisuals"]["assets"]
                            .as_array_mut()
                            .unwrap()
                            .push(json!({
                                "request": {"kind": "focus", "focus": focus},
                                "assetPath": format!("/visuals/{focus}.png")
                            }));
                    }
                }),
            ),
            (
                "invalid retryable error",
                Box::new(|g| {
                    g["phase2"]["designVisuals"]["errors"] = json!([{
                        "request": {"kind": "focus", "focus": "view"},
                        "message": "",
                        "retryable": false
                    }]);
                }),
            ),
        ];
        for (label, mutate) in mutations {
            let mut malformed = valid.clone();
            mutate(&mut malformed);
            assert!(validate_game(&malformed).is_err(), "{label}");
        }
    }

    #[test]
    fn rejects_malformed_phase2_corridor_templates() {
        let valid = valid_phase2_game();
        let mutations: Vec<SnapshotMutation> = vec![
            (
                "invalid corridor cell",
                Box::new(|g| g["phase2"]["corridorTemplate"]["corridor"][0]["x"] = json!("two")),
            ),
            (
                "non-positive slot dimensions",
                Box::new(|g| g["phase2"]["corridorTemplate"]["slots"][0]["width"] = json!(0)),
            ),
            (
                "slot out of bounds",
                Box::new(|g| g["phase2"]["corridorTemplate"]["slots"][0]["anchor"]["x"] = json!(5)),
            ),
            (
                "slot dimensions overflow",
                Box::new(|g| {
                    g["phase2"]["corridorTemplate"]["width"] = json!(i64::MAX);
                    g["phase2"]["corridorTemplate"]["slots"][0]["anchor"]["x"] =
                        json!(i64::MAX - 1);
                    g["phase2"]["corridorTemplate"]["slots"][0]["width"] = json!(2);
                }),
            ),
            (
                "duplicate slot id",
                Box::new(|g| {
                    let slot = g["phase2"]["corridorTemplate"]["slots"][0].clone();
                    g["phase2"]["corridorTemplate"]["slots"] = json!([slot.clone(), slot]);
                }),
            ),
            (
                "slot overlaps corridor",
                Box::new(|g| g["phase2"]["corridorTemplate"]["slots"][0]["anchor"]["x"] = json!(2)),
            ),
            (
                "slots overlap each other",
                Box::new(|g| {
                    let mut slot = g["phase2"]["corridorTemplate"]["slots"][0].clone();
                    slot["id"] = json!("north-2");
                    g["phase2"]["corridorTemplate"]["slots"]
                        .as_array_mut()
                        .unwrap()
                        .push(slot);
                }),
            ),
            (
                "slot not adjacent to corridor",
                Box::new(|g| {
                    g["phase2"]["corridorTemplate"]["slots"][0]["anchor"] = json!({"x": 4, "y": 3})
                }),
            ),
            (
                "disconnected corridor",
                Box::new(|g| {
                    g["phase2"]["corridorTemplate"]["corridor"]
                        .as_array_mut()
                        .unwrap()
                        .push(json!({"x": 5, "y": 5}))
                }),
            ),
            (
                "entrance does not bridge core and corridor",
                Box::new(|g| {
                    g["phase2"]["corridorTemplate"]["entrances"] = json!([{"x": 0, "y": 5}])
                }),
            ),
        ];
        for (label, mutate) in mutations {
            let mut malformed = valid.clone();
            mutate(&mut malformed);
            assert!(validate_game(&malformed).is_err(), "{label}");
        }
    }

    #[test]
    fn rejects_invalid_phase2_placements_and_transformed_fit() {
        let valid = valid_phase2_game();

        let mut unknown_slot = valid.clone();
        unknown_slot["phase2"]["floorPlacements"][0]["slotId"] = json!("unknown");
        assert!(
            validate_game(&unknown_slot).is_err(),
            "unknown template slot"
        );

        let mut oversized = valid.clone();
        oversized["phase2"]["corridorTemplate"]["slots"][0]["width"] = json!(1);
        assert!(
            validate_game(&oversized).is_err(),
            "unrotated footprint does not fit"
        );

        let mut rotated_oversized = valid.clone();
        rotated_oversized["phase2"]["corridorTemplate"]["slots"][0]["height"] = json!(1);
        rotated_oversized["phase2"]["floorPlacements"][0]["rotation"] = json!(90);
        assert!(
            validate_game(&rotated_oversized).is_err(),
            "rotated footprint does not fit"
        );
    }
    #[test]
    fn stale_revision_no_partial_writes() {
        let r = SaveRepository::new(root("stale"));
        r.commit_game(0, game()).unwrap();
        let mut g = game();
        g["revision"] = json!(2);
        assert!(r.commit_game(0, g).is_err());
        assert_eq!(r.load_game("save-1").unwrap(), Some(game()));
    }
    #[test]
    fn duplicate_report_rejected() {
        let r = SaveRepository::new(root("dup"));
        let mut g = game();
        g["reports"] = json!([{"day":1},{"day":1}]);
        assert!(r.commit_game(0, g).is_err());
    }
    #[test]
    fn rolls_back_when_room_insert_fails() {
        let r = SaveRepository::new(root("rollback"));
        let mut prior = blueprint_game(1, json!([]));
        prior["cashCents"] = json!(777);
        r.commit_game(0, prior.clone()).unwrap();
        let conn = r.open("save-1").unwrap();
        conn.execute_batch("CREATE TABLE trigger_probe(count INTEGER NOT NULL); INSERT INTO trigger_probe VALUES(0); CREATE TRIGGER fail_room BEFORE INSERT ON room_instances BEGIN UPDATE trigger_probe SET count=count+1; SELECT RAISE(ABORT, 'forced'); END;").unwrap();
        let mut next = blueprint_game(
            2,
            json!([{"id":"room-1","slotId":"slot-ne","roomBlueprintId":"bp-1","committedBuildCostCents":1}]),
        );
        next["cashCents"] = json!(888);
        let error = r.commit_game(1, next).unwrap_err();
        assert!(error.contains("forced"));
        assert_eq!(r.load_game("save-1").unwrap(), Some(prior));
    }
    #[test]
    fn invalid_save_id_rejected() {
        let r = SaveRepository::new(root("id"));
        assert!(r.load_game("../x").is_err());
    }
    #[test]
    fn concurrent_revision_commits_only_one_wins() {
        let root = root("race");
        let first = SaveRepository::new(root.clone());
        first.load_game("save-1").unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let a = SaveRepository::new(root.clone());
        let b = SaveRepository::new(root);
        let ga = game();
        let gb = game();
        let ba = barrier.clone();
        let ha = std::thread::spawn(move || {
            ba.wait();
            a.commit_game(0, ga)
        });
        let bb = barrier;
        let hb = std::thread::spawn(move || {
            bb.wait();
            b.commit_game(0, gb)
        });
        let results = [ha.join().unwrap(), hb.join().unwrap()];
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|r| r.is_err()).count(), 1);
    }
    #[test]
    fn rejects_rooms_without_matching_blueprint() {
        let r = SaveRepository::new(root("fk-validation"));
        let mut no_blueprint = game();
        no_blueprint["floor"]["rooms"] = json!([{"id":"r","slotId":"slot-ne","roomBlueprintId":"bp-1","committedBuildCostCents":1}]);
        assert!(r.commit_game(0, no_blueprint).is_err());
        let mismatch = blueprint_game(
            1,
            json!([{"id":"r","slotId":"slot-ne","roomBlueprintId":"other","committedBuildCostCents":1}]),
        );
        assert!(r.commit_game(0, mismatch).is_err());
    }

    #[test]
    fn rejects_unknown_slots_and_more_than_four_rooms() {
        let r = SaveRepository::new(root("slot-validation"));
        let invalid_slot = blueprint_game(
            1,
            json!([{"id":"r","slotId":"slot-center","roomBlueprintId":"bp-1","committedBuildCostCents":1}]),
        );
        assert!(r.commit_game(0, invalid_slot).is_err());

        let rooms = (0..5)
            .map(|i| json!({"id":format!("r-{i}"),"slotId":format!("slot-{i}"),"roomBlueprintId":"bp-1","committedBuildCostCents":1}))
            .collect::<Vec<_>>();
        let too_many = blueprint_game(1, json!(rooms));
        assert!(r.commit_game(0, too_many).is_err());
    }

    #[test]
    fn rejects_duplicate_room_instance_ids() {
        let r = SaveRepository::new(root("room-id-validation"));
        let duplicate = blueprint_game(
            1,
            json!([
                {"id":"same","slotId":"slot-ne","roomBlueprintId":"bp-1","committedBuildCostCents":1},
                {"id":"same","slotId":"slot-nw","roomBlueprintId":"bp-1","committedBuildCostCents":1}
            ]),
        );
        assert!(r.commit_game(0, duplicate).is_err());
    }

    #[test]
    fn rejects_ready_or_open_without_blueprint() {
        let r = SaveRepository::new(root("phase-blueprint-validation"));
        for phase in ["ready", "open"] {
            let mut g = game();
            g["phase"] = json!(phase);
            assert!(r.commit_game(0, g).is_err());
        }
    }

    #[test]
    fn rejects_zero_or_out_of_order_report_days() {
        let r = SaveRepository::new(root("report-day-validation"));
        let mut zero = game();
        zero["reports"] = json!([{"day":0}]);
        assert!(r.commit_game(0, zero).is_err());

        let mut out_of_order = game();
        out_of_order["currentDay"] = json!(3);
        out_of_order["reports"] = json!([{"day":1},{"day":3}]);
        out_of_order["latestReport"] = json!({"day":3});
        assert!(r.commit_game(0, out_of_order).is_err());
    }

    #[test]
    fn rejects_latest_report_that_does_not_match_current_day() {
        let r = SaveRepository::new(root("latest-report-validation"));
        let mut g = game();
        g["currentDay"] = json!(2);
        g["reports"] = json!([{"day":1},{"day":2}]);
        g["latestReport"] = json!({"day":1});
        assert!(r.commit_game(0, g).is_err());
    }

    #[test]
    fn rejects_corrupted_loaded_snapshot() {
        let r = SaveRepository::new(root("load-validation"));
        r.commit_game(0, game()).unwrap();
        let conn = r.open("save-1").unwrap();
        conn.execute(
            "UPDATE saves SET phase='open', latest_report_json=?1",
            [r#"{"day":1}"#],
        )
        .unwrap();
        assert!(r.load_game("save-1").is_err());
    }
    #[test]
    fn preserves_room_array_order() {
        let r = SaveRepository::new(root("order"));
        let rooms = json!([
            {"id":"r-ne","slotId":"slot-ne","roomBlueprintId":"bp-1","committedBuildCostCents":1},
            {"id":"r-nw","slotId":"slot-nw","roomBlueprintId":"bp-1","committedBuildCostCents":2}
        ]);
        let g = blueprint_game(1, rooms);
        r.commit_game(0, g.clone()).unwrap();
        assert_eq!(r.load_game("save-1").unwrap(), Some(g));
    }
    #[test]
    fn migrates_legacy_v1_schema() {
        let root = root("legacy");
        let r = SaveRepository::new(root.clone());
        let path = r.db_path("save-1");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES(1,'now'); CREATE TABLE saves(save_id TEXT PRIMARY KEY,schema_version INTEGER NOT NULL,ruleset_version TEXT NOT NULL,revision INTEGER NOT NULL,phase TEXT NOT NULL,current_day INTEGER NOT NULL,cash_cents INTEGER NOT NULL,rate_cents INTEGER NOT NULL,latest_report_json TEXT,updated_at TEXT NOT NULL); CREATE TABLE room_blueprints(save_id TEXT PRIMARY KEY,blueprint_id TEXT NOT NULL,name TEXT NOT NULL,columns_count INTEGER NOT NULL,rows_count INTEGER NOT NULL,cells_json TEXT NOT NULL,metrics_json TEXT NOT NULL,visual_json TEXT NOT NULL); CREATE TABLE room_instances(save_id TEXT NOT NULL,instance_id TEXT NOT NULL,slot_id TEXT NOT NULL,blueprint_id TEXT NOT NULL,committed_build_cost_cents INTEGER NOT NULL,PRIMARY KEY(save_id,instance_id),UNIQUE(save_id,slot_id)); CREATE TABLE daily_reports(save_id TEXT NOT NULL,game_day INTEGER NOT NULL,report_json TEXT NOT NULL,PRIMARY KEY(save_id,game_day)); INSERT INTO saves VALUES('save-1',1,'prototype-v1',1,'design',0,100,10,NULL,'now'); INSERT INTO room_blueprints VALUES('save-1','bp-1','Suite',1,1,'[]','{}','{\"status\":\"idle\"}'); INSERT INTO room_instances VALUES('save-1','r-ne','slot-ne','bp-1',1); INSERT INTO room_instances VALUES('save-1','r-nw','slot-nw','bp-1',2);").unwrap();
        let loaded = r.load_game("save-1").unwrap().unwrap();
        assert_eq!(loaded["floor"]["rooms"][0]["id"], "r-ne");
        assert_eq!(loaded["floor"]["rooms"][1]["id"], "r-nw");
        let conn = r.open("save-1").unwrap();
        assert!(
            conn.query_row::<i64, _, _>(
                "SELECT count(*) FROM schema_migrations WHERE version=2",
                [],
                |x| x.get(0)
            )
            .unwrap()
                == 1
        );
        let g = blueprint_game(2, json!([]));
        r.commit_game(1, g).unwrap();
        assert!(
            conn.query_row::<i64, _, _>(
                "SELECT count(*) FROM pragma_table_info('room_instances') WHERE name='ordinal'",
                [],
                |x| x.get(0)
            )
            .unwrap()
                == 1
        );
    }
    #[test]
    fn rejects_duplicate_room_ordinals_at_database_layer() {
        let r = SaveRepository::new(root("ordinal-unique"));
        let g = blueprint_game(
            1,
            json!([
                {"id":"r-ne","slotId":"slot-ne","roomBlueprintId":"bp-1","committedBuildCostCents":1},
                {"id":"r-nw","slotId":"slot-nw","roomBlueprintId":"bp-1","committedBuildCostCents":2}
            ]),
        );
        r.commit_game(0, g).unwrap();
        let conn = r.open("save-1").unwrap();
        let err = conn
            .execute(
                "UPDATE room_instances SET ordinal=0 WHERE instance_id='r-nw'",
                [],
            )
            .unwrap_err();
        assert!(err.to_string().contains("UNIQUE"));
    }
    #[test]
    fn concurrent_legacy_open_migration_is_idempotent() {
        let root = root("legacy-race");
        let r = SaveRepository::new(root.clone());
        let path = r.db_path("save-1");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES(1,'now'); CREATE TABLE saves(save_id TEXT PRIMARY KEY,schema_version INTEGER NOT NULL,ruleset_version TEXT NOT NULL,revision INTEGER NOT NULL,phase TEXT NOT NULL,current_day INTEGER NOT NULL,cash_cents INTEGER NOT NULL,rate_cents INTEGER NOT NULL,latest_report_json TEXT,updated_at TEXT NOT NULL); CREATE TABLE room_blueprints(save_id TEXT PRIMARY KEY,blueprint_id TEXT NOT NULL,name TEXT NOT NULL,columns_count INTEGER NOT NULL,rows_count INTEGER NOT NULL,cells_json TEXT NOT NULL,metrics_json TEXT NOT NULL,visual_json TEXT NOT NULL); CREATE TABLE room_instances(save_id TEXT NOT NULL,instance_id TEXT NOT NULL,slot_id TEXT NOT NULL,blueprint_id TEXT NOT NULL,committed_build_cost_cents INTEGER NOT NULL,PRIMARY KEY(save_id,instance_id),UNIQUE(save_id,slot_id)); CREATE TABLE daily_reports(save_id TEXT NOT NULL,game_day INTEGER NOT NULL,report_json TEXT NOT NULL,PRIMARY KEY(save_id,game_day)); INSERT INTO saves VALUES('save-1',1,'prototype-v1',1,'design',0,100,10,NULL,'now'); INSERT INTO room_blueprints VALUES('save-1','bp-1','Suite',1,1,'[]','{}','{\"status\":\"idle\"}'); INSERT INTO room_instances VALUES('save-1','r-ne','slot-ne','bp-1',1);").unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let a = SaveRepository::new(root.clone());
        let b = SaveRepository::new(root);
        let ba = barrier.clone();
        let ha = std::thread::spawn(move || {
            ba.wait();
            a.load_game("save-1")
        });
        let bb = barrier;
        let hb = std::thread::spawn(move || {
            bb.wait();
            b.load_game("save-1")
        });
        assert!(ha.join().unwrap().is_ok());
        assert!(hb.join().unwrap().is_ok());
    }

    fn phase4_fixture(raw: &str) -> Value {
        serde_json::from_str(raw).unwrap()
    }

    fn phase4_fixture_with_snapshot_slot(slot_id: &str) -> Value {
        let mut game = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
        let mut snapshot = game["phase4"]["floorTemplates"]["template:facility:standard"].clone();
        snapshot["id"] = json!("template-snapshot:floor:03");
        snapshot["publicSpaceSlots"][0]["id"] = json!(slot_id);
        game["phase4"]["floorTemplates"]
            .as_object_mut()
            .unwrap()
            .insert("template-snapshot:floor:03".into(), snapshot);
        game
    }

    fn phase4_fixture_json_with_money_token(token: &str) -> String {
        let raw = include_str!("../tests/fixtures/phase4-valid.json");
        let original = "\"committedBuildCostCents\": 2500000";
        assert!(raw.contains(original));
        raw.replacen(
            original,
            &format!("\"committedBuildCostCents\": {token}"),
            1,
        )
    }

    fn phase4_fixture_with_money_token(token: &str) -> Value {
        phase4_fixture(&phase4_fixture_json_with_money_token(token))
    }

    const PHASE4_INVALID_FIXTURES: [(&str, &str); 10] = [
        ("bad-report-arithmetic.json", "经营报告算术不一致"),
        ("excessive-cells.json", "公共空间蓝图格子最多保留8192项"),
        ("excessive-floors.json", "楼层最多保留64层"),
        ("excessive-flow-events.json", "流动事件最多保留150项"),
        ("excessive-history.json", "设施历史最多保留30天"),
        ("excessive-items.json", "公共空间蓝图物品最多保留256项"),
        ("excessive-rooms.json", "客房最多保留240间"),
        ("forbidden-base64.json", "禁止持久化Base64数据"),
        ("forbidden-credential.json", "禁止持久化凭据"),
        ("unknown-catalog-reference.json", "目录引用无效"),
    ];

    const PHASE4_TASK2_ERROR_CLASSES: [(&str, &str); 8] = [
        ("duplicate-floor-id", "楼层编号重复"),
        ("unknown-room-floor", "客房楼层引用无效"),
        ("unsafe-money", "施工金额必须是安全整数"),
        ("wrong-containing-floor", "客房必须属于所在楼层"),
        ("malformed-record-key", "记录键必须是稳定 ID"),
        ("non-object-record-value", "公共空间蓝图结构无效"),
        ("record-key-id-mismatch", "记录键与编号不一致"),
        ("duplicate-record-value-id", "公共空间编号重复"),
    ];

    fn phase4_fixture_with_serialized_bytes(target: usize) -> Value {
        let mut game = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
        let phase4 = game["phase4"].as_object_mut().unwrap();
        phase4.insert(
            "persistenceMetadata".into(),
            json!({
                "asciiKey": "ascii value",
                "非ASCII键": "中文值",
                "exponentNumber": phase4_fixture("1e2"),
            }),
        );
        let phase4_without_metadata = serde_json::to_vec(&Value::Object(
            phase4
                .iter()
                .filter(|(key, _)| key.as_str() != "persistenceMetadata")
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
        ))
        .unwrap()
        .len();
        let metadata = phase4["persistenceMetadata"].as_object_mut().unwrap();
        let mut bytes = serde_json::to_vec(metadata).unwrap().len();
        bytes += phase4_without_metadata + ",\"persistenceMetadata\":".len() - 2;
        let mut index = 0usize;
        let mut last_key = String::new();

        loop {
            let key = format!("{}{index:06}", "界".repeat(122));
            let empty_entry_bytes = serde_json::to_vec(&json!({key.clone(): ""})).unwrap().len()
                - 2
                + usize::from(!metadata.is_empty());
            let full_entry_bytes = empty_entry_bytes + 4_096;
            if bytes + full_entry_bytes > target {
                break;
            }
            metadata.insert(key.clone(), json!("!".repeat(4_096)));
            bytes += full_entry_bytes;
            last_key = key;
            index += 1;
        }

        let key = format!("{}{index:06}", "界".repeat(122));
        let empty_entry_bytes =
            serde_json::to_vec(&json!({key.clone(): ""})).unwrap().len() - 2 + 1;
        let mut deficit = target - bytes;
        if deficit > 0 && deficit < empty_entry_bytes {
            let prior = metadata[&last_key].as_str().unwrap();
            metadata.insert(
                last_key.clone(),
                json!(&prior[..prior.len() - (empty_entry_bytes - deficit)]),
            );
            bytes -= empty_entry_bytes - deficit;
            deficit = target - bytes;
        }
        if deficit > 0 {
            metadata.insert(key, json!("!".repeat(deficit - empty_entry_bytes)));
        }

        let actual = serde_json::to_vec(&game["phase4"]).unwrap().len();
        if actual != target {
            let metadata = game["phase4"]["persistenceMetadata"]
                .as_object_mut()
                .unwrap();
            let calibration_key = last_key.clone();
            let prior = metadata[&calibration_key].as_str().unwrap();
            let calibrated = if actual > target {
                prior[..prior.len() - (actual - target)].to_string()
            } else {
                format!("{prior}{}", "!".repeat(target - actual))
            };
            metadata.insert(calibration_key, json!(calibrated));
        }
        assert_eq!(serde_json::to_vec(&game["phase4"]).unwrap().len(), target);
        game
    }

    #[test]
    fn phase4_shared_fixture_manifest_is_exact() {
        let directory =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/phase4-invalid");
        let mut actual = fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect::<Vec<_>>();
        actual.sort();
        assert_eq!(
            actual,
            PHASE4_INVALID_FIXTURES
                .iter()
                .map(|(name, _)| name.to_string())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn phase4_shared_invalid_fixtures_have_stable_error_classes() {
        let directory =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/phase4-invalid");
        for (name, expected) in PHASE4_INVALID_FIXTURES {
            let mut invalid = phase4_fixture(&fs::read_to_string(directory.join(name)).unwrap());
            invalid["revision"] = json!(1);
            let repository = SaveRepository::new(root(&format!("phase4-task8-{name}")));
            let error = match repository.commit_game(0, invalid) {
                Err(error) => error,
                Ok(()) => panic!("{name} unexpectedly accepted"),
            };
            assert!(
                error.contains(expected),
                "{name} expected {expected}, got {error}"
            );
        }
    }

    #[test]
    fn phase4_retains_task2_validation_regressions() {
        type Phase4Mutation = (&'static str, Box<dyn Fn(&mut Value)>);
        let cases: Vec<Phase4Mutation> = vec![
            (
                "duplicate-floor-id",
                Box::new(|value| value["phase4"]["floors"][1]["id"] = json!("floor:01")),
            ),
            (
                "unknown-room-floor",
                Box::new(|value| {
                    value["phase4"]["floors"][4]["rooms"][0]["floorId"] = json!("floor:unknown")
                }),
            ),
            (
                "unsafe-money",
                Box::new(|value| {
                    value["phase4"]["floors"][4]["rooms"][0]["committedBuildCostCents"] =
                        json!(JS_MAX_SAFE_INTEGER + 1)
                }),
            ),
            (
                "wrong-containing-floor",
                Box::new(|value| {
                    value["phase4"]["floors"][4]["rooms"][0]["floorId"] = json!("floor:06")
                }),
            ),
            (
                "malformed-record-key",
                Box::new(|value| {
                    let record = value["phase4"]["publicSpaces"].as_object_mut().unwrap();
                    let first = record.values().next().unwrap().clone();
                    record.insert("Bad Key".into(), first);
                }),
            ),
            (
                "non-object-record-value",
                Box::new(|value| {
                    let record = value["phase4"]["spaceBlueprints"].as_object_mut().unwrap();
                    let key = record.keys().next().unwrap().clone();
                    record.insert(key, json!("bad"));
                }),
            ),
            (
                "record-key-id-mismatch",
                Box::new(|value| {
                    let record = value["phase4"]["facilities"].as_object_mut().unwrap();
                    record.values_mut().next().unwrap()["id"] = json!("facility:mismatch");
                }),
            ),
            (
                "duplicate-record-value-id",
                Box::new(|value| {
                    let record = value["phase4"]["publicSpaces"].as_object_mut().unwrap();
                    let keys = record.keys().take(2).cloned().collect::<Vec<_>>();
                    let first_id = record[&keys[0]]["id"].clone();
                    record.get_mut(&keys[1]).unwrap()["id"] = first_id;
                }),
            ),
        ];
        assert_eq!(
            cases.iter().map(|(name, _)| *name).collect::<Vec<_>>(),
            PHASE4_TASK2_ERROR_CLASSES
                .iter()
                .map(|(name, _)| *name)
                .collect::<Vec<_>>()
        );
        for ((name, mutate), (_, expected)) in cases.into_iter().zip(PHASE4_TASK2_ERROR_CLASSES) {
            let mut invalid = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
            mutate(&mut invalid);
            let error = validate_game(&invalid).err().unwrap();
            assert!(
                error.contains(expected),
                "{name} expected {expected}, got {error}"
            );
        }
    }

    #[test]
    fn phase4_enforces_exact_serialized_json_size() {
        for (target, rejected) in [
            (PHASE4_MAX_JSON_BYTES - 1, false),
            (PHASE4_MAX_JSON_BYTES, false),
            (PHASE4_MAX_JSON_BYTES + 1, true),
            (8_630_528, true),
        ] {
            let game = phase4_fixture_with_serialized_bytes(target);
            let result = validate_game(&game);
            if rejected {
                assert!(
                    result.err().unwrap().contains("JSON超过大小限制"),
                    "{target} bytes"
                );
            } else {
                assert!(result.is_ok(), "{target} bytes");
            }
        }
    }

    #[test]
    fn phase4_rejects_graph_cardinality_and_item_containment_mutations() {
        type Phase4Mutation = (&'static str, &'static str, Box<dyn Fn(&mut Value)>);
        let cases: Vec<Phase4Mutation> = vec![
            (
                "duplicate-public-space-placement",
                "公共空间放置重复",
                Box::new(|value| {
                    let mut spaces = value["phase4"]["publicSpaces"]
                        .as_object_mut()
                        .unwrap()
                        .values_mut()
                        .take(2)
                        .collect::<Vec<_>>();
                    let floor_id = spaces[0]["floorId"].clone();
                    let placement_id = spaces[0]["localPlacementId"].clone();
                    spaces[1]["floorId"] = floor_id;
                    spaces[1]["localPlacementId"] = placement_id;
                }),
            ),
            (
                "duplicate-facility-ownership",
                "设施公共空间引用重复",
                Box::new(|value| {
                    let mut facilities = value["phase4"]["facilities"]
                        .as_object_mut()
                        .unwrap()
                        .values_mut()
                        .take(2)
                        .collect::<Vec<_>>();
                    let instance_id = facilities[0]["publicSpaceInstanceId"].clone();
                    let type_id = facilities[0]["type"].clone();
                    facilities[1]["publicSpaceInstanceId"] = instance_id;
                    facilities[1]["type"] = type_id;
                }),
            ),
            (
                "duplicate-permitted-type",
                "允许设施类型无效",
                Box::new(|value| {
                    let permitted = value["phase4"]["floorTemplates"]["template:facility:standard"]
                        ["publicSpaceSlots"][0]["permittedTypes"]
                        .as_array_mut()
                        .unwrap();
                    permitted.push(permitted[0].clone());
                }),
            ),
            (
                "item-outside-blueprint",
                "公共空间物品超出蓝图",
                Box::new(|value| {
                    let blueprint =
                        &mut value["phase4"]["spaceBlueprints"]["space-blueprint:all-day-dining"];
                    blueprint["placedItems"][0]["x"] = json!(127);
                    blueprint["placedItems"][0]["width"] = json!(2);
                }),
            ),
        ];
        for (name, expected, mutate) in cases {
            let mut invalid = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
            mutate(&mut invalid);
            let error = validate_game(&invalid).err().unwrap();
            assert!(
                error.contains(expected),
                "{name} expected {expected}, got {error}"
            );
        }

        let mut boundary = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
        let blueprint =
            &mut boundary["phase4"]["spaceBlueprints"]["space-blueprint:all-day-dining"];
        blueprint["placedItems"][0]["x"] = json!(127);
        blueprint["placedItems"][0]["y"] = json!(63);
        assert!(validate_game(&boundary).is_ok());
    }

    #[test]
    fn phase4_validates_optional_public_space_slot_geometry() {
        type SlotMutation = (&'static str, &'static str, Box<dyn Fn(&mut Value)>);
        let cases: Vec<SlotMutation> = vec![
            (
                "partial",
                "公共空间槽位几何必须完整",
                Box::new(|slot| slot["anchorX"] = json!(0)),
            ),
            (
                "string",
                "公共空间槽位几何必须是安全整数",
                Box::new(|slot| {
                    slot["anchorX"] = json!("0");
                    slot["anchorY"] = json!(0);
                    slot["width"] = json!(1);
                    slot["height"] = json!(1);
                }),
            ),
            (
                "fraction",
                "公共空间槽位几何必须是安全整数",
                Box::new(|slot| {
                    slot["anchorX"] = json!(0.5);
                    slot["anchorY"] = json!(0);
                    slot["width"] = json!(1);
                    slot["height"] = json!(1);
                }),
            ),
            (
                "negative",
                "公共空间槽位几何必须是安全整数",
                Box::new(|slot| {
                    slot["anchorX"] = json!(-1);
                    slot["anchorY"] = json!(0);
                    slot["width"] = json!(1);
                    slot["height"] = json!(1);
                }),
            ),
            (
                "zero-size",
                "公共空间槽位几何必须是安全整数",
                Box::new(|slot| {
                    slot["anchorX"] = json!(0);
                    slot["anchorY"] = json!(0);
                    slot["width"] = json!(0);
                    slot["height"] = json!(1);
                }),
            ),
            (
                "out-of-bounds",
                "公共空间槽位几何超出楼层模板",
                Box::new(|slot| {
                    slot["anchorX"] = json!(23);
                    slot["anchorY"] = json!(23);
                    slot["width"] = json!(2);
                    slot["height"] = json!(2);
                }),
            ),
        ];
        for (name, expected, mutate) in cases {
            let mut invalid = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
            let slot = &mut invalid["phase4"]["floorTemplates"]["template:facility:standard"]
                ["publicSpaceSlots"][0];
            mutate(slot);
            let error = validate_game(&invalid).err().unwrap();
            assert!(
                error.contains(expected),
                "{name} expected {expected}, got {error}"
            );
        }

        let legacy = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
        assert!(validate_game(&legacy).is_ok());
        let mut boundary = legacy;
        let slot = &mut boundary["phase4"]["floorTemplates"]["template:facility:standard"]
            ["publicSpaceSlots"][0];
        slot["anchorX"] = json!(16);
        slot["anchorY"] = json!(15);
        slot["width"] = json!(8);
        slot["height"] = json!(9);
        assert!(validate_game(&boundary).is_ok());
    }

    #[test]
    fn phase4_extension_ids_and_credential_keys_match_browser() {
        let mut extension = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
        extension["phase4"]["persistenceMetadata"] =
            json!({"futureId": "Future ID", "futureIds": ["Future ID"]});
        assert!(validate_game(&extension).is_ok());

        for field in [
            "password",
            "secret",
            "credential",
            "apiKey",
            "APIKey",
            "ACCESS_TOKEN",
            "Api-Key",
        ] {
            let mut invalid = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
            invalid["phase4"]["persistenceMetadata"] = json!({field: "fixture"});
            let error = validate_game(&invalid).err().unwrap();
            assert!(error.contains("禁止持久化凭据"), "{field}: {error}");
        }
    }

    #[test]
    fn phase4_deep_extension_tree_has_a_controlled_error() {
        let mut nested = Value::Null;
        for _ in 0..100 {
            nested = json!({"child": nested});
        }
        let error = validate_phase4_tree(&nested).err().unwrap();
        assert!(error.contains("JSON嵌套过深"), "{error}");
    }

    #[test]
    fn phase4_rejects_catalog_and_envelope_mutations_with_stable_classes() {
        type Phase4Mutation = (&'static str, &'static str, Box<dyn Fn(&mut Value)>);
        let cases: Vec<Phase4Mutation> = vec![
            (
                "unknown-developed-offering",
                "目录引用无效",
                Box::new(|value| {
                    value["phase4"]["facilities"]["facility:floor:02:all-day-dining"]
                        ["developedOfferingIds"] = json!(["dish:unknown"]);
                }),
            ),
            (
                "unknown-signature-in-developed",
                "目录引用无效",
                Box::new(|value| {
                    let facility =
                        &mut value["phase4"]["facilities"]["facility:floor:02:all-day-dining"];
                    facility["developedOfferingIds"] = json!(["dish:unknown"]);
                    facility["policy"]["signatureOfferingId"] = json!("dish:unknown");
                }),
            ),
            (
                "wrong-offering-type",
                "目录引用无效",
                Box::new(|value| {
                    value["phase4"]["facilities"]["facility:floor:02:all-day-dining"]
                        ["developedOfferingIds"] = json!(["drink:cloud-negroni"]);
                }),
            ),
            (
                "wrong-signature-group",
                "目录引用无效",
                Box::new(|value| {
                    let facility =
                        &mut value["phase4"]["facilities"]["facility:floor:02:all-day-dining"];
                    facility["developedOfferingIds"] = json!(["drink:cloud-negroni"]);
                    facility["policy"]["signatureOfferingId"] = json!("drink:cloud-negroni");
                }),
            ),
            (
                "unknown-menu",
                "目录引用无效",
                Box::new(|value| {
                    value["phase4"]["facilities"]["facility:floor:02:all-day-dining"]
                        ["menuSelection"]["menuStructureId"] = json!("menu:unknown");
                }),
            ),
            (
                "incompatible-menu",
                "目录引用无效",
                Box::new(|value| {
                    value["phase4"]["facilities"]["facility:floor:02:all-day-dining"]
                        ["menuSelection"]["menuStructureId"] = json!("menu:bar-classics");
                }),
            ),
            (
                "unknown-positioning",
                "目录引用无效",
                Box::new(|value| {
                    value["phase4"]["facilities"]["facility:floor:02:all-day-dining"]["policy"]
                        ["positioningId"] = json!("positioning:unknown");
                }),
            ),
            (
                "unknown-price",
                "目录引用无效",
                Box::new(|value| {
                    value["phase4"]["facilities"]["facility:floor:02:all-day-dining"]["policy"]
                        ["priceBandId"] = json!("price-band:unknown");
                }),
            ),
            (
                "unknown-opening",
                "目录引用无效",
                Box::new(|value| {
                    value["phase4"]["facilities"]["facility:floor:02:all-day-dining"]["policy"]
                        ["openingPolicyId"] = json!("opening-policy:unknown");
                }),
            ),
            (
                "wrong-policy-group",
                "目录引用无效",
                Box::new(|value| {
                    let policy = &mut value["phase4"]["facilities"]
                        ["facility:floor:02:all-day-dining"]["policy"];
                    policy["positioningId"] = json!("positioning:restorative-wellness");
                    policy["openingPolicyId"] = json!("opening-policy:appointment-daily");
                }),
            ),
            (
                "65-templates",
                "楼层模板最多保留64项",
                Box::new(|value| {
                    let source =
                        value["phase4"]["floorTemplates"]["template:entrance:standard"].clone();
                    let record = value["phase4"]["floorTemplates"].as_object_mut().unwrap();
                    for index in 0..60 {
                        let id = format!("template:extra:{index:02}");
                        let mut template = source.clone();
                        template["id"] = json!(id);
                        record.insert(id, template);
                    }
                }),
            ),
            (
                "zero-template-columns",
                "楼层模板列数必须是安全整数",
                Box::new(|value| {
                    value["phase4"]["floorTemplates"]["template:guest:dense-ring"]["columns"] =
                        json!(0);
                }),
            ),
            (
                "oversized-template-rows",
                "楼层模板行数必须是安全整数",
                Box::new(|value| {
                    value["phase4"]["floorTemplates"]["template:guest:dense-ring"]["rows"] =
                        json!(513);
                }),
            ),
            (
                "wrong-cell-area",
                "楼层模板单元面积无效",
                Box::new(|value| {
                    value["phase4"]["floorTemplates"]["template:guest:dense-ring"]
                        ["cellAreaSquareMeters"] = json!(2);
                }),
            ),
            (
                "fractional-anchor",
                "客房横坐标必须是安全整数",
                Box::new(|value| {
                    value["phase4"]["floorTemplates"]["template:guest:dense-ring"]
                        ["roomPlacements"][0]["anchorX"] = json!(0.5);
                }),
            ),
            (
                "negative-anchor",
                "客房纵坐标必须是安全整数",
                Box::new(|value| {
                    value["phase4"]["floorTemplates"]["template:guest:dense-ring"]
                        ["roomPlacements"][0]["anchorY"] = json!(-1);
                }),
            ),
            (
                "zero-placement-width",
                "客房宽度必须是安全整数",
                Box::new(|value| {
                    value["phase4"]["floorTemplates"]["template:guest:dense-ring"]
                        ["roomPlacements"][0]["width"] = json!(0);
                }),
            ),
            (
                "placement-out-of-bounds",
                "客房放置超出楼层模板",
                Box::new(|value| {
                    let placement = &mut value["phase4"]["floorTemplates"]
                        ["template:guest:dense-ring"]["roomPlacements"][0];
                    placement["anchorX"] = json!(23);
                    placement["width"] = json!(2);
                }),
            ),
            (
                "blank-blueprint-name",
                "公共空间名称文本无效",
                Box::new(|value| {
                    value["phase4"]["spaceBlueprints"]["space-blueprint:bar"]["name"] = json!(" ");
                }),
            ),
            (
                "long-blueprint-name",
                "公共空间名称文本无效",
                Box::new(|value| {
                    value["phase4"]["spaceBlueprints"]["space-blueprint:bar"]["name"] =
                        json!("中".repeat(257));
                }),
            ),
        ];
        for (name, expected, mutate) in cases {
            let mut invalid = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
            mutate(&mut invalid);
            let error = validate_game(&invalid).err().unwrap();
            assert!(
                error.contains(expected),
                "{name} expected {expected}, got {error}"
            );
        }
    }

    #[test]
    fn phase4_scalar_and_forbidden_rules_match_browser() {
        let raw = include_str!("../tests/fixtures/phase4-valid.json");
        let exponent = raw.replacen("\"columns\": 24", "\"columns\": 1e2", 1);
        assert!(validate_game(&phase4_fixture(&exponent)).is_ok());
        assert_eq!(
            phase4_int(&phase4_fixture("1e2"), "测试数值", 0, JS_MAX_SAFE_INTEGER).unwrap(),
            100
        );
        assert!(phase4_int(
            &json!(9_007_199_254_740_992_i64),
            "测试数值",
            0,
            JS_MAX_SAFE_INTEGER
        )
        .is_err());
        assert!(phase4_int(
            &phase4_fixture("9.007199254740992e15"),
            "测试数值",
            0,
            JS_MAX_SAFE_INTEGER
        )
        .is_err());
        assert!(validate_phase4_money(&json!(9_007_199_254_740_992_i64)).is_err());
        assert!(validate_phase4_money(&phase4_fixture("9.007199254740992e15")).is_err());

        let mut unicode = phase4_fixture(raw);
        unicode["phase4"]["persistenceMetadata"] = json!({"description": "😀".repeat(3_000)});
        assert!(validate_game(&unicode).is_ok());
        unicode["phase4"]["persistenceMetadata"] = json!({"description": "中".repeat(4_097)});
        assert!(validate_game(&unicode)
            .err()
            .unwrap()
            .contains("文本超过长度限制"));

        let mut unicode_key = phase4_fixture(raw);
        unicode_key["phase4"]["persistenceMetadata"] = json!({"😀".repeat(100): "fixture"});
        assert!(validate_game(&unicode_key).is_ok());
        unicode_key["phase4"]["persistenceMetadata"] = json!({"中".repeat(129): "fixture"});
        assert!(validate_game(&unicode_key)
            .err()
            .unwrap()
            .contains("字段名超过长度限制"));

        for credential in [
            "password=hunter2",
            "secret: fixture",
            "credential=fixture",
            "api-key: fixture",
            "access_token=fixture",
            "Bearer abcdefghijklmnop",
            "secret phrase then secret=fixture",
        ] {
            let mut invalid = phase4_fixture(raw);
            invalid["phase4"]["persistenceMetadata"] = json!({"description": credential});
            assert!(
                validate_game(&invalid)
                    .err()
                    .unwrap()
                    .contains("禁止持久化凭据"),
                "{credential}"
            );
        }
        for description in ["notsecret=fixture", "Bearer short"] {
            let mut valid = phase4_fixture(raw);
            valid["phase4"]["persistenceMetadata"] = json!({"description": description});
            assert!(validate_game(&valid).is_ok(), "{description}");
        }
        for field in ["password", "secret", "credential", "apiKey", "access_token"] {
            let mut invalid = phase4_fixture(raw);
            invalid["phase4"]["persistenceMetadata"] = json!({field: "fixture"});
            assert!(
                validate_game(&invalid)
                    .err()
                    .unwrap()
                    .contains("禁止持久化凭据"),
                "{field}"
            );
        }
        let mut internal_padding = phase4_fixture(raw);
        internal_padding["phase4"]["persistenceMetadata"] =
            json!({"description": format!("{}={}", "A".repeat(64), "A".repeat(64))});
        assert!(validate_game(&internal_padding).is_ok());
        internal_padding["phase4"]["persistenceMetadata"] = json!({"description": "A".repeat(128)});
        assert!(validate_game(&internal_padding)
            .err()
            .unwrap()
            .contains("禁止持久化Base64数据"));
    }

    #[test]
    fn phase4_only_maps_report_errors_to_report_arithmetic() {
        let mut invalid_loan = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
        invalid_loan["operations"]["loans"] = json!([{
            "id": "loan:bad", "principalCents": 1, "outstandingCents": 0,
            "dailyInterestBps": 1, "minimumPaymentCents": 1
        }]);
        let loan_error = validate_game(&invalid_loan).err().unwrap();
        assert!(loan_error.contains("经营存档"), "{loan_error}");
        assert!(!loan_error.contains("经营报告算术"), "{loan_error}");

        let mut incomplete_segments =
            phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
        incomplete_segments["operations"]["dailyReports"][0]["segments"]
            .as_array_mut()
            .unwrap()
            .pop();
        let segment_error = validate_game(&incomplete_segments).err().unwrap();
        assert!(segment_error.contains("经营存档"), "{segment_error}");
        assert!(!segment_error.contains("经营报告算术"), "{segment_error}");

        let mut invalid_report =
            phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
        invalid_report["operations"]["dailyReports"][0]["revenueCents"] = json!(1_501);
        assert!(validate_game(&invalid_report)
            .err()
            .unwrap()
            .contains("经营报告算术不一致"));

        let mut invalid_aggregate =
            phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
        invalid_aggregate["operations"]["weeklyReports"][0]["revenueCents"] = json!(10_501);
        assert!(validate_game(&invalid_aggregate)
            .err()
            .unwrap()
            .contains("经营报告算术不一致"));

        let mut partial_categories =
            phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
        partial_categories["operations"]["weeklyReports"][0]
            .as_object_mut()
            .unwrap()
            .remove("publicSpaceRevenueCents");
        assert!(validate_game(&partial_categories)
            .err()
            .unwrap()
            .contains("经营报告算术不一致"));
    }

    #[test]
    fn phase4_rejects_facility_history_after_current_day() {
        let game = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
        let phase4 = game["phase4"].clone();
        let mut earlier_game = game.clone();
        earlier_game["currentDay"] = json!(29);

        assert!(validate_phase4(&phase4, &earlier_game)
            .err()
            .unwrap()
            .contains("设施历史日期无效"));
    }

    #[test]
    fn phase4_minimal_commits_and_reopens_shared_fixture() {
        let repository = SaveRepository::new(root("phase4-shared"));
        let mut game = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
        let expected_phase4 = game["phase4"].clone();
        game["revision"] = json!(1);

        repository.commit_game(0, game).unwrap();

        let loaded = repository.load_game("phase4-shared").unwrap().unwrap();
        assert_eq!(loaded["phase4"], expected_phase4);
    }

    #[test]
    fn phase4_commits_and_reopens_public_space_in_snapshot_only_slot() {
        let repository = SaveRepository::new(root("phase4-snapshot-slot"));
        let mut game = phase4_fixture_with_snapshot_slot("space:snapshot-only");
        game["phase4"]["publicSpaces"]["public-space:floor:03:space:01"]["localPlacementId"] =
            json!("space:snapshot-only");
        game["revision"] = json!(1);

        repository.commit_game(0, game.clone()).unwrap();

        assert_eq!(repository.load_game("phase4-shared").unwrap(), Some(game));
    }

    #[test]
    fn phase4_rejects_public_space_excluded_by_applied_snapshot() {
        let mut game = phase4_fixture_with_snapshot_slot("space:01");
        game["phase4"]["floorTemplates"]["template-snapshot:floor:03"]["publicSpaceSlots"][0]
            ["permittedTypes"] = json!(["spa"]);

        assert!(validate_game(&game)
            .err()
            .unwrap()
            .contains("公共空间槽位或类型引用无效"));
    }

    #[test]
    fn phase4_minimal_rejects_null_envelope_like_browser_validation() {
        let mut invalid = game();
        invalid["phase4"] = Value::Null;

        assert!(validate_game(&invalid).is_err());
    }

    #[test]
    fn phase4_minimal_rejects_malformed_stable_ids() {
        let mut invalid = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
        invalid["phase4"]["building"]["templateId"] = json!("Building Template");

        let error = validate_game(&invalid).err().unwrap();
        assert!(error.contains("稳定 ID"));
    }

    #[test]
    fn phase4_minimal_accepts_safe_integral_float_and_exponent_money() {
        for token in ["2500000.0", "25e5", "9007199254740991.0"] {
            let fixture = phase4_fixture_with_money_token(token);
            assert!(
                validate_game(&fixture).is_ok(),
                "safe money token rejected: {token}"
            );
        }
    }

    #[test]
    fn phase4_minimal_rejects_fractional_and_unsafe_money() {
        for token in [
            "2500000.5",
            "-1.0",
            "9007199254740992",
            "9007199254740992.0",
            "1e400",
        ] {
            let raw = phase4_fixture_json_with_money_token(token);
            match serde_json::from_str::<Value>(&raw) {
                Ok(fixture) => {
                    let error = validate_game(&fixture).err().unwrap();
                    assert!(
                        error.contains("施工金额必须是安全整数"),
                        "unexpected error for {token}: {error}"
                    );
                }
                Err(error) => assert_eq!(token, "1e400", "unexpected parse error: {error}"),
            }
        }
    }

    #[test]
    fn phase4_invalid_update_leaves_prior_revision_unchanged() {
        let repository = SaveRepository::new(root("phase4-rollback"));
        let mut valid = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
        valid["revision"] = json!(1);
        repository.commit_game(0, valid.clone()).unwrap();

        for (name, raw, expected) in [
            (
                "unknown-catalog",
                include_str!("../tests/fixtures/phase4-invalid/unknown-catalog-reference.json"),
                "目录引用无效",
            ),
            (
                "bad-report",
                include_str!("../tests/fixtures/phase4-invalid/bad-report-arithmetic.json"),
                "经营报告算术不一致",
            ),
            (
                "excessive-flow",
                include_str!("../tests/fixtures/phase4-invalid/excessive-flow-events.json"),
                "流动事件最多保留150项",
            ),
            (
                "credential",
                include_str!("../tests/fixtures/phase4-invalid/forbidden-credential.json"),
                "禁止持久化凭据",
            ),
        ] {
            let mut invalid = phase4_fixture(raw);
            invalid["revision"] = json!(2);
            let error = repository.commit_game(1, invalid).unwrap_err();
            assert!(error.contains(expected), "{name}: {error}");
            assert_eq!(
                repository.load_game("phase4-shared").unwrap(),
                Some(valid.clone()),
                "{name} changed persisted state"
            );
        }
    }

    #[test]
    fn phase4_minimal_migrates_old_schema_and_loads_without_envelope() {
        let repository = SaveRepository::new(root("phase4-old-schema"));
        repository.commit_game(0, game()).unwrap();
        let conn = repository.open("save-1").unwrap();
        conn.execute_batch(
            "ALTER TABLE saves DROP COLUMN phase4_json;
             DELETE FROM schema_migrations WHERE version=6;",
        )
        .unwrap();
        drop(conn);

        let loaded = repository.load_game("save-1").unwrap().unwrap();

        assert!(loaded.get("phase4").is_none());
        let conn = repository.open("save-1").unwrap();
        assert_eq!(
            conn.query_row::<i64, _, _>(
                "SELECT count(*) FROM pragma_table_info('saves') WHERE name='phase4_json'",
                [],
                |row| row.get(0),
            )
            .unwrap(),
            1
        );
    }
}

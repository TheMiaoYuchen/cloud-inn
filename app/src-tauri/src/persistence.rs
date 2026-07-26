use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::collections::HashSet;
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
                "SELECT schema_version,ruleset_version,revision,phase,current_day,cash_cents,rate_cents,phase2_json,latest_report_json FROM saves WHERE save_id=?1",
                [save_id],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?,
                        r.get::<_, String>(3)?, r.get::<_, i64>(4)?, r.get::<_, i64>(5)?,
                        r.get::<_, i64>(6)?, r.get::<_, Option<String>>(7)?,
                        r.get::<_, Option<String>>(8)?,
                    ))
                },
            )
            .optional()
            .map_err(db_err)?;
        let Some((schema, ruleset, revision, phase, day, cash, rate, phase2, latest)) = row else {
            return Ok(None);
        };
        let blueprint = conn
            .query_row("SELECT blueprint_id,name,columns_count,rows_count,cells_json,metrics_json,visual_json FROM room_blueprints WHERE save_id=?1", [save_id], |r| {
                Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"columns":r.get::<_,i64>(2)?,"rows":r.get::<_,i64>(3)?,"cells":serde_json::from_str::<Value>(&r.get::<_,String>(4)?).map_err(|_| rusqlite::Error::InvalidQuery)?,"metrics":serde_json::from_str::<Value>(&r.get::<_,String>(5)?).map_err(|_| rusqlite::Error::InvalidQuery)?,"visual":serde_json::from_str::<Value>(&r.get::<_,String>(6)?).map_err(|_| rusqlite::Error::InvalidQuery)?}))
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
        tx.execute("INSERT INTO saves(save_id,schema_version,ruleset_version,revision,phase,current_day,cash_cents,rate_cents,phase2_json,latest_report_json,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,datetime('now')) ON CONFLICT(save_id) DO UPDATE SET schema_version=excluded.schema_version,ruleset_version=excluded.ruleset_version,revision=excluded.revision,phase=excluded.phase,current_day=excluded.current_day,cash_cents=excluded.cash_cents,rate_cents=excluded.rate_cents,phase2_json=excluded.phase2_json,latest_report_json=excluded.latest_report_json,updated_at=excluded.updated_at", params![save_id, fields.schema_version, fields.ruleset, fields.revision, fields.phase, fields.current_day, fields.cash_cents, fields.rate_cents, fields.phase2, fields.latest_report]).map_err(db_err)?;
        tx.execute("DELETE FROM room_instances WHERE save_id=?1", [&save_id])
            .map_err(db_err)?;
        tx.execute("DELETE FROM room_blueprints WHERE save_id=?1", [&save_id])
            .map_err(db_err)?;
        if let Some(bp) = fields.blueprint {
            tx.execute("INSERT INTO room_blueprints(save_id,blueprint_id,name,columns_count,rows_count,cells_json,metrics_json,visual_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)", params![save_id,bp.id,bp.name,bp.columns,bp.rows,bp.cells,bp.metrics,bp.visual]).map_err(db_err)?;
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

fn db_err(e: rusqlite::Error) -> String {
    format!("数据库操作失败: {e}")
}
fn parse_json(s: String) -> Result<Value, String> {
    serde_json::from_str(&s).map_err(|_| "存档数据损坏".to_string())
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
        Some(v) => Some(Blueprint {
            id: strv(v, "id")?,
            name: strv(v, "name")?,
            columns: intv(v, "columns", 1, true)?,
            rows: intv(v, "rows", 1, true)?,
            cells: serde_json::to_string(obj(v, "cells")?)
                .map_err(|_| "存档数据损坏".to_string())?,
            metrics: serde_json::to_string(obj(v, "metrics")?)
                .map_err(|_| "存档数据损坏".to_string())?,
            visual: {
                validate_visual_tree(obj(v, "visual")?)?;
                serde_json::to_string(obj(v, "visual")?)
            }
            .map_err(|_| "存档数据损坏".to_string())?,
        }),
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
        blueprint,
        rooms,
        reports,
    })
}

fn validate_phase2(value: &Value) -> Result<String, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "存档数据损坏".to_string())?;
    for key in ["hotelGene", "roomVariants", "corridorTemplate"] {
        if !object.contains_key(key) {
            return Err("存档数据损坏".into());
        }
    }
    validate_gene(&object["hotelGene"])?;
    let variants = object["roomVariants"]
        .as_array()
        .ok_or_else(|| "存档数据损坏".to_string())?;
    if !object["roomVariants"].is_array() {
        return Err("存档数据损坏".into());
    }
    let template = &object["corridorTemplate"];
    if !template.is_null() {
        let width = intv(template, "width", 1, true)?;
        let height = intv(template, "height", 1, true)?;
        for key in ["core", "corridor", "entrances", "slots"] {
            if !obj(template, key)?.is_array() {
                return Err("存档数据损坏".into());
            }
        }
        for point in obj(template, "core")?
            .as_array()
            .unwrap()
            .iter()
            .chain(obj(template, "corridor")?.as_array().unwrap())
            .chain(obj(template, "entrances")?.as_array().unwrap())
        {
            let x = intv(point, "x", 0, false)?;
            let y = intv(point, "y", 0, false)?;
            if x >= width || y >= height {
                return Err("存档数据损坏".into());
            }
        }
    }
    if let Some(placements) = object.get("floorPlacements") {
        let placements = placements
            .as_array()
            .ok_or_else(|| "存档数据损坏".to_string())?;
        let variant_ids = variants
            .iter()
            .map(|v| strv(v, "id"))
            .collect::<Result<HashSet<_>, _>>()?;
        let mut slots = HashSet::new();
        for placement in placements {
            if !slots.insert(strv(placement, "slotId")?)
                || !variant_ids.contains(&strv(placement, "variantId")?)
            {
                return Err("存档数据损坏".into());
            }
            if ![0, 90, 180, 270].contains(&intv(placement, "rotation", 0, false)?)
                || obj(placement, "mirrored")?.as_bool().is_none()
            {
                return Err("存档数据损坏".into());
            }
        }
    }
    if let Some(master) = object.get("roomMaster") {
        if !master.is_null() && !master.is_object() {
            return Err("存档数据损坏".into());
        }
        if master.is_object() {
            let master_id = strv(master, "id")?;
            validate_visual_tree(master)?;
            for variant in variants {
                if strv(variant, "masterId")? != master_id {
                    return Err("存档数据损坏".into());
                }
                if ![0, 90, 180, 270].contains(&intv(variant, "rotation", 0, false)?) {
                    return Err("存档数据损坏".into());
                }
                if !obj(variant, "cells")?.is_array() || !obj(variant, "overrides")?.is_array() {
                    return Err("存档数据损坏".into());
                }
                validate_gene(obj(variant, "gene")?)?;
                validate_visual_tree(variant)?;
            }
        } else if !variants.is_empty() {
            return Err("存档数据损坏".into());
        }
    } else {
        return Err("存档数据损坏".into());
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
    fn root(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("cloud-inn-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }
    fn game() -> Value {
        json!({"schemaVersion":1,"rulesetVersion":"prototype-v1","saveId":"save-1","revision":1,"phase":"design","currentDay":0,"cashCents":100,"rateCents":10,"roomBlueprint":null,"floor":{"id":"prototype-floor","rooms":[]},"reports":[],"latestReport":null})
    }
    fn blueprint_game(revision: i64, rooms: Value) -> Value {
        let mut g = game();
        g["revision"] = json!(revision);
        g["roomBlueprint"] = json!({"id":"bp-1","name":"Suite","columns":1,"rows":1,"cells":[],"metrics":{"areaSquareMeters":1,"buildCostCents":1,"suggestedRateCents":1,"businessFitBps":1},"visual":{"status":"idle"}});
        g["floor"]["rooms"] = rooms;
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
            3
        );
    }
    #[test]
    fn commits_and_loads_full_state() {
        let r = SaveRepository::new(root("full"));
        let g = game();
        r.commit_game(0, g.clone()).unwrap();
        assert_eq!(r.load_game("save-1").unwrap(), Some(g));
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
}

use crate::redaction::SafeError;
use rusqlite::{params, Connection, OptionalExtension};

struct IssuedGrant {
    save_id: String,
    job_id: String,
    job_revision: i64,
    attempt_sequence: i64,
    model: String,
    request_fingerprint: String,
}

pub fn validate_issued_grants_for_save(
    save_connection: &Connection,
    control_connection: &Connection,
    expected_save_id: &str,
) -> Result<(), SafeError> {
    if expected_save_id.is_empty()
        || expected_save_id.len() > 128
        || !expected_save_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(control_invalid());
    }

    let mut statement = control_connection
        .prepare(
            "SELECT save_id,job_id,job_revision,attempt_sequence,model,request_fingerprint
             FROM provider_send_grants
             WHERE state='issued' AND save_id=?1
             ORDER BY grant_id",
        )
        .map_err(|_| control_invalid())?;
    let grants = statement
        .query_map([expected_save_id], |row| {
            Ok(IssuedGrant {
                save_id: row.get(0)?,
                job_id: row.get(1)?,
                job_revision: row.get(2)?,
                attempt_sequence: row.get(3)?,
                model: row.get(4)?,
                request_fingerprint: row.get(5)?,
            })
        })
        .map_err(|_| control_invalid())?;

    for grant in grants {
        let grant = grant.map_err(|_| control_invalid())?;
        let job = save_connection
            .query_row(
                "SELECT save_id,job_revision,request_fingerprint,selected_model
                 FROM generation_jobs
                 WHERE job_id=?1",
                [&grant.job_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| control_invalid())?
            .ok_or_else(control_invalid)?;

        let last_attempt_sequence = control_connection
            .query_row(
                "SELECT MAX(sequence)
                 FROM provider_attempts
                 WHERE save_id=?1 AND job_id=?2",
                params![&grant.save_id, &grant.job_id],
                |row| row.get::<_, Option<i64>>(0),
            )
            .map_err(|_| control_invalid())?;
        let next_attempt_sequence = match last_attempt_sequence {
            Some(sequence) => sequence.checked_add(1).ok_or_else(control_invalid)?,
            None => 1,
        };

        if grant.save_id != expected_save_id
            || job.0 != expected_save_id
            || grant.job_revision != job.1
            || grant.request_fingerprint != job.2
            || job.3.as_deref() != Some(grant.model.as_str())
            || grant.attempt_sequence != next_attempt_sequence
        {
            return Err(control_invalid());
        }
    }

    Ok(())
}

fn control_invalid() -> SafeError {
    SafeError::new(
        "provider.control-invalid",
        "图片服务计费控制记录无效或不可用",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const OTHER_HASH: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn test_connections() -> (Connection, Connection) {
        let save = Connection::open_in_memory().expect("open save database");
        save.execute_batch(
            "CREATE TABLE generation_jobs(
               job_id TEXT PRIMARY KEY,
               save_id TEXT NOT NULL,
               job_revision INTEGER NOT NULL,
               request_fingerprint TEXT NOT NULL,
               selected_model TEXT
             );",
        )
        .expect("create save schema");

        let control = Connection::open_in_memory().expect("open control database");
        control
            .execute_batch(
                "CREATE TABLE provider_attempts(
                   attempt_id TEXT PRIMARY KEY,
                   save_id TEXT NOT NULL,
                   job_id TEXT NOT NULL,
                   sequence INTEGER NOT NULL
                 );
                 CREATE TABLE provider_send_grants(
                   grant_id TEXT PRIMARY KEY,
                   save_id TEXT NOT NULL,
                   job_id TEXT NOT NULL,
                   job_revision INTEGER NOT NULL,
                   attempt_sequence INTEGER NOT NULL,
                   model TEXT NOT NULL,
                   request_fingerprint TEXT NOT NULL,
                   state TEXT NOT NULL
                 );",
            )
            .expect("create control schema");
        (save, control)
    }

    fn insert_valid_pair(save: &Connection, control: &Connection) {
        save.execute(
            "INSERT INTO generation_jobs(
               job_id,save_id,job_revision,request_fingerprint,selected_model
             ) VALUES('job-1','save-1',7,?1,'model-1')",
            [HASH],
        )
        .expect("insert generation job");
        control
            .execute(
                "INSERT INTO provider_attempts(attempt_id,save_id,job_id,sequence)
                 VALUES('attempt-1','save-1','job-1',1)",
                [],
            )
            .expect("insert prior attempt");
        control
            .execute(
                "INSERT INTO provider_send_grants(
                   grant_id,save_id,job_id,job_revision,attempt_sequence,model,
                   request_fingerprint,state
                 ) VALUES('grant-1','save-1','job-1',7,2,'model-1',?1,'issued')",
                [HASH],
            )
            .expect("insert issued grant");
    }

    fn expect_control_invalid(result: Result<(), SafeError>) {
        let error = result.expect_err("cross-database validation should fail closed");
        let serialized = serde_json::to_value(error).expect("serialize safe error");
        assert_eq!(serialized["code"], "provider.control-invalid");
        assert!(serialized["detail"].is_null());
    }

    #[test]
    fn empty_issued_set_passes_and_consumed_history_is_out_of_scope() {
        let (save, control) = test_connections();
        control
            .execute(
                "INSERT INTO provider_send_grants(
                   grant_id,save_id,job_id,job_revision,attempt_sequence,model,
                   request_fingerprint,state
                 ) VALUES('old-grant','save-1','missing-job',99,9,'wrong',?1,'consumed')",
                [OTHER_HASH],
            )
            .expect("insert consumed history");

        validate_issued_grants_for_save(&save, &control, "save-1").expect("empty issued set");
    }

    #[test]
    fn matching_issued_grant_passes() {
        let (save, control) = test_connections();
        insert_valid_pair(&save, &control);

        validate_issued_grants_for_save(&save, &control, "save-1").expect("matching issued grant");
    }

    #[test]
    fn mismatched_save_id_fails_closed() {
        let (save, control) = test_connections();
        insert_valid_pair(&save, &control);
        save.execute(
            "UPDATE generation_jobs SET save_id='save-2' WHERE job_id='job-1'",
            [],
        )
        .expect("mutate save id");

        expect_control_invalid(validate_issued_grants_for_save(&save, &control, "save-1"));
    }

    #[test]
    fn mismatched_job_id_fails_closed() {
        let (save, control) = test_connections();
        insert_valid_pair(&save, &control);
        control
            .execute(
                "UPDATE provider_send_grants SET job_id='job-missing'
                 WHERE grant_id='grant-1'",
                [],
            )
            .expect("mutate job id");

        expect_control_invalid(validate_issued_grants_for_save(&save, &control, "save-1"));
    }

    #[test]
    fn mismatched_job_revision_fails_closed() {
        let (save, control) = test_connections();
        insert_valid_pair(&save, &control);
        control
            .execute(
                "UPDATE provider_send_grants SET job_revision=8 WHERE grant_id='grant-1'",
                [],
            )
            .expect("mutate job revision");

        expect_control_invalid(validate_issued_grants_for_save(&save, &control, "save-1"));
    }

    #[test]
    fn mismatched_request_fingerprint_fails_closed() {
        let (save, control) = test_connections();
        insert_valid_pair(&save, &control);
        control
            .execute(
                "UPDATE provider_send_grants SET request_fingerprint=?1
                 WHERE grant_id='grant-1'",
                [OTHER_HASH],
            )
            .expect("mutate request fingerprint");

        expect_control_invalid(validate_issued_grants_for_save(&save, &control, "save-1"));
    }

    #[test]
    fn mismatched_selected_model_fails_closed() {
        let (save, control) = test_connections();
        insert_valid_pair(&save, &control);
        save.execute(
            "UPDATE generation_jobs SET selected_model='model-2' WHERE job_id='job-1'",
            [],
        )
        .expect("mutate selected model");

        expect_control_invalid(validate_issued_grants_for_save(&save, &control, "save-1"));
    }

    #[test]
    fn null_selected_model_fails_closed() {
        let (save, control) = test_connections();
        insert_valid_pair(&save, &control);
        save.execute(
            "UPDATE generation_jobs SET selected_model=NULL WHERE job_id='job-1'",
            [],
        )
        .expect("clear selected model");

        expect_control_invalid(validate_issued_grants_for_save(&save, &control, "save-1"));
    }

    #[test]
    fn mismatched_next_attempt_sequence_fails_closed() {
        let (save, control) = test_connections();
        insert_valid_pair(&save, &control);
        control
            .execute(
                "UPDATE provider_send_grants SET attempt_sequence=3 WHERE grant_id='grant-1'",
                [],
            )
            .expect("mutate attempt sequence");

        expect_control_invalid(validate_issued_grants_for_save(&save, &control, "save-1"));
    }

    #[test]
    fn issued_grants_for_other_saves_are_ignored_by_the_per_save_gate() {
        let (save, control) = test_connections();
        control
            .execute(
                "INSERT INTO provider_send_grants(
                   grant_id,save_id,job_id,job_revision,attempt_sequence,model,
                   request_fingerprint,state
                 ) VALUES('other-grant','save-2','missing-job',99,9,'wrong',?1,'issued')",
                [OTHER_HASH],
            )
            .expect("insert other save grant");

        validate_issued_grants_for_save(&save, &control, "save-1")
            .expect("other save is outside this gate");
    }
}

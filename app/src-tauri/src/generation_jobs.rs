use crate::redaction::SafeError;
use rusqlite::{named_params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GenerationJobStatus {
    Queued,
    BlockedNoCredential,
    WaitingNetwork,
    CheckingModel,
    RunningPrimary,
    RetryDelay,
    RunningFallback,
    StagingAsset,
    ReadyForReview,
    Adopted,
    NeedsRetryConfirmation,
    NeedsPlayerConfirmation,
    Superseded,
    FailedRetryable,
    FailedTerminal,
    Cancelled,
}

impl GenerationJobStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::BlockedNoCredential => "blocked-no-credential",
            Self::WaitingNetwork => "waiting-network",
            Self::CheckingModel => "checking-model",
            Self::RunningPrimary => "running-primary",
            Self::RetryDelay => "retry-delay",
            Self::RunningFallback => "running-fallback",
            Self::StagingAsset => "staging-asset",
            Self::ReadyForReview => "ready-for-review",
            Self::Adopted => "adopted",
            Self::NeedsRetryConfirmation => "needs-retry-confirmation",
            Self::NeedsPlayerConfirmation => "needs-player-confirmation",
            Self::Superseded => "superseded",
            Self::FailedRetryable => "failed-retryable",
            Self::FailedTerminal => "failed-terminal",
            Self::Cancelled => "cancelled",
        }
    }

    pub const fn can_transition_to(self, next: Self) -> bool {
        use GenerationJobStatus::{
            Adopted, BlockedNoCredential, Cancelled, CheckingModel, FailedRetryable,
            FailedTerminal, NeedsPlayerConfirmation, NeedsRetryConfirmation, Queued,
            ReadyForReview, RetryDelay, RunningFallback, RunningPrimary, StagingAsset, Superseded,
            WaitingNetwork,
        };
        match self {
            Queued => matches!(
                next,
                Queued
                    | BlockedNoCredential
                    | WaitingNetwork
                    | CheckingModel
                    | NeedsPlayerConfirmation
                    | Superseded
                    | FailedTerminal
                    | Cancelled
            ),
            BlockedNoCredential => matches!(
                next,
                BlockedNoCredential
                    | Queued
                    | WaitingNetwork
                    | CheckingModel
                    | NeedsPlayerConfirmation
                    | Superseded
                    | FailedTerminal
                    | Cancelled
            ),
            WaitingNetwork => matches!(
                next,
                WaitingNetwork
                    | Queued
                    | BlockedNoCredential
                    | CheckingModel
                    | NeedsPlayerConfirmation
                    | Superseded
                    | FailedTerminal
                    | Cancelled
            ),
            CheckingModel => matches!(
                next,
                CheckingModel
                    | BlockedNoCredential
                    | WaitingNetwork
                    | RunningPrimary
                    | NeedsPlayerConfirmation
                    | FailedRetryable
                    | FailedTerminal
                    | Superseded
                    | Cancelled
            ),
            RunningPrimary => matches!(
                next,
                RunningPrimary
                    | RetryDelay
                    | RunningFallback
                    | StagingAsset
                    | NeedsRetryConfirmation
                    | NeedsPlayerConfirmation
                    | FailedRetryable
                    | FailedTerminal
                    | Superseded
                    | Cancelled
            ),
            RetryDelay => matches!(
                next,
                RetryDelay
                    | RunningPrimary
                    | RunningFallback
                    | BlockedNoCredential
                    | WaitingNetwork
                    | NeedsRetryConfirmation
                    | NeedsPlayerConfirmation
                    | FailedRetryable
                    | FailedTerminal
                    | Superseded
                    | Cancelled
            ),
            RunningFallback => matches!(
                next,
                RunningFallback
                    | RetryDelay
                    | StagingAsset
                    | NeedsRetryConfirmation
                    | NeedsPlayerConfirmation
                    | FailedRetryable
                    | FailedTerminal
                    | Superseded
                    | Cancelled
            ),
            StagingAsset => matches!(
                next,
                StagingAsset
                    | ReadyForReview
                    | NeedsPlayerConfirmation
                    | FailedRetryable
                    | FailedTerminal
                    | Superseded
                    | Cancelled
            ),
            ReadyForReview => {
                matches!(
                    next,
                    ReadyForReview | Adopted | Superseded | FailedTerminal | Cancelled
                )
            }
            Adopted => matches!(next, Superseded | FailedTerminal),
            NeedsRetryConfirmation => matches!(
                next,
                NeedsRetryConfirmation
                    | CheckingModel
                    | RunningPrimary
                    | RunningFallback
                    | NeedsPlayerConfirmation
                    | Superseded
                    | FailedTerminal
                    | Cancelled
            ),
            NeedsPlayerConfirmation => matches!(
                next,
                NeedsPlayerConfirmation
                    | Queued
                    | BlockedNoCredential
                    | WaitingNetwork
                    | CheckingModel
                    | RunningPrimary
                    | RunningFallback
                    | Superseded
                    | FailedTerminal
                    | Cancelled
            ),
            FailedRetryable => matches!(
                next,
                FailedRetryable
                    | Queued
                    | CheckingModel
                    | NeedsPlayerConfirmation
                    | Superseded
                    | FailedTerminal
                    | Cancelled
            ),
            Superseded | FailedTerminal | Cancelled => false,
        }
    }

    pub const fn requires_lease(self) -> bool {
        matches!(
            self,
            Self::CheckingModel | Self::RunningPrimary | Self::RunningFallback | Self::StagingAsset
        )
    }
}

impl TryFrom<&str> for GenerationJobStatus {
    type Error = SafeError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "queued" => Ok(Self::Queued),
            "blocked-no-credential" => Ok(Self::BlockedNoCredential),
            "waiting-network" => Ok(Self::WaitingNetwork),
            "checking-model" => Ok(Self::CheckingModel),
            "running-primary" => Ok(Self::RunningPrimary),
            "retry-delay" => Ok(Self::RetryDelay),
            "running-fallback" => Ok(Self::RunningFallback),
            "staging-asset" => Ok(Self::StagingAsset),
            "ready-for-review" => Ok(Self::ReadyForReview),
            "adopted" => Ok(Self::Adopted),
            "needs-retry-confirmation" => Ok(Self::NeedsRetryConfirmation),
            "needs-player-confirmation" => Ok(Self::NeedsPlayerConfirmation),
            "superseded" => Ok(Self::Superseded),
            "failed-retryable" => Ok(Self::FailedRetryable),
            "failed-terminal" => Ok(Self::FailedTerminal),
            "cancelled" => Ok(Self::Cancelled),
            _ => Err(invalid_transition()),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum GenerationJobLeaseUpdate {
    Clear {
        lease_epoch: i64,
    },
    Hold {
        lease_owner: String,
        lease_until_ms: i64,
        lease_epoch: i64,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum GenerationJobLease {
    Clear {
        lease_epoch: i64,
    },
    Held {
        lease_owner: String,
        lease_until_ms: i64,
        lease_epoch: i64,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerationJobNextState {
    pub status: GenerationJobStatus,
    pub selected_model: Option<String>,
    pub next_attempt_at_ms: Option<i64>,
    pub lease: GenerationJobLeaseUpdate,
    pub asset_id: Option<String>,
    pub error_code: Option<String>,
    pub response_ambiguous: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerationJobTransitionRequest {
    pub job_id: String,
    pub save_id: String,
    pub expected_revision: i64,
    pub expected_status: GenerationJobStatus,
    pub expected_request_fingerprint: String,
    pub expected_lease_epoch: i64,
    pub next: GenerationJobNextState,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationJobTransitionProjection {
    pub job_id: String,
    pub save_id: String,
    pub job_revision: i64,
    pub status: GenerationJobStatus,
    pub request_fingerprint: String,
    pub selected_model: Option<String>,
    pub next_attempt_at_ms: Option<i64>,
    pub lease: GenerationJobLease,
    pub asset_id: Option<String>,
    pub error_code: Option<String>,
    pub response_ambiguous: bool,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "kebab-case")]
pub enum GenerationJobTransitionResult {
    Applied {
        job: Box<GenerationJobTransitionProjection>,
    },
    CompareAndSetMiss,
}

pub trait GenerationJobTransitionExt {
    fn compare_and_set_generation_job(
        &self,
        request: &GenerationJobTransitionRequest,
    ) -> Result<GenerationJobTransitionResult, SafeError>;
}

impl GenerationJobTransitionExt for Connection {
    fn compare_and_set_generation_job(
        &self,
        request: &GenerationJobTransitionRequest,
    ) -> Result<GenerationJobTransitionResult, SafeError> {
        compare_and_set_generation_job(self, request)
    }
}

impl GenerationJobTransitionExt for Transaction<'_> {
    fn compare_and_set_generation_job(
        &self,
        request: &GenerationJobTransitionRequest,
    ) -> Result<GenerationJobTransitionResult, SafeError> {
        compare_and_set_generation_job(self, request)
    }
}

fn compare_and_set_generation_job(
    connection: &Connection,
    request: &GenerationJobTransitionRequest,
) -> Result<GenerationJobTransitionResult, SafeError> {
    validate_request(request)?;
    let (replace_lease, lease_owner, lease_until_ms, next_lease_epoch) =
        lease_bindings(&request.next.lease);
    let projection = connection
        .query_row(
            "UPDATE generation_jobs
             SET job_revision = job_revision + 1,
                 status = :next_status,
                 selected_model = :selected_model,
                 next_attempt_at_ms = :next_attempt_at_ms,
                 lease_owner = CASE WHEN :replace_lease THEN :lease_owner ELSE lease_owner END,
                 lease_until_ms = CASE WHEN :replace_lease THEN :lease_until_ms ELSE lease_until_ms END,
                 lease_epoch = CASE WHEN :replace_lease THEN :next_lease_epoch ELSE lease_epoch END,
                 asset_id = :asset_id,
                 error_code = :error_code,
                 response_ambiguous = :response_ambiguous,
                 updated_at_ms = :updated_at_ms
             WHERE job_id = :job_id
               AND save_id = :save_id
               AND job_revision = :expected_revision
               AND status = :expected_status
               AND request_fingerprint = :expected_request_fingerprint
               AND lease_epoch = :expected_lease_epoch
             RETURNING job_id,save_id,job_revision,status,request_fingerprint,
                       selected_model,next_attempt_at_ms,lease_owner,lease_until_ms,
                       lease_epoch,asset_id,error_code,response_ambiguous,updated_at_ms",
            named_params! {
                ":next_status": request.next.status.as_str(),
                ":selected_model": request.next.selected_model,
                ":next_attempt_at_ms": request.next.next_attempt_at_ms,
                ":replace_lease": replace_lease,
                ":lease_owner": lease_owner,
                ":lease_until_ms": lease_until_ms,
                ":next_lease_epoch": next_lease_epoch,
                ":asset_id": request.next.asset_id,
                ":error_code": request.next.error_code,
                ":response_ambiguous": request.next.response_ambiguous,
                ":updated_at_ms": request.updated_at_ms,
                ":job_id": request.job_id,
                ":save_id": request.save_id,
                ":expected_revision": request.expected_revision,
                ":expected_status": request.expected_status.as_str(),
                ":expected_request_fingerprint": request.expected_request_fingerprint,
                ":expected_lease_epoch": request.expected_lease_epoch,
            },
            read_projection,
        )
        .optional()
        .map_err(|_| transition_storage_error())?;
    Ok(match projection {
        Some(job) => GenerationJobTransitionResult::Applied { job: Box::new(job) },
        None => GenerationJobTransitionResult::CompareAndSetMiss,
    })
}

fn validate_request(request: &GenerationJobTransitionRequest) -> Result<(), SafeError> {
    if request.job_id.is_empty()
        || request.job_id.len() > 128
        || request.save_id.is_empty()
        || request.expected_revision < 0
        || request.expected_revision == i64::MAX
        || request.expected_lease_epoch < 0
        || request.updated_at_ms < 0
        || !is_lowercase_sha256(&request.expected_request_fingerprint)
        || !request
            .expected_status
            .can_transition_to(request.next.status)
    {
        return Err(invalid_transition());
    }
    if (request.next.status == GenerationJobStatus::RetryDelay)
        != request.next.next_attempt_at_ms.is_some()
        || request
            .next
            .next_attempt_at_ms
            .is_some_and(|value| value < 0)
    {
        return Err(invalid_transition());
    }
    validate_optional_bounded(&request.next.selected_model, 128)?;
    validate_optional_bounded(&request.next.asset_id, 128)?;
    validate_optional_bounded(&request.next.error_code, 128)?;
    if matches!(
        request.next.status,
        GenerationJobStatus::ReadyForReview | GenerationJobStatus::Adopted
    ) && request.next.asset_id.is_none()
    {
        return Err(invalid_transition());
    }
    if request.next.response_ambiguous
        && !matches!(
            request.next.status,
            GenerationJobStatus::NeedsRetryConfirmation
                | GenerationJobStatus::NeedsPlayerConfirmation
                | GenerationJobStatus::FailedTerminal
        )
    {
        return Err(invalid_transition());
    }
    match &request.next.lease {
        GenerationJobLeaseUpdate::Clear { lease_epoch } => {
            if request.next.status.requires_lease() || *lease_epoch < request.expected_lease_epoch {
                return Err(invalid_transition());
            }
        }
        GenerationJobLeaseUpdate::Hold {
            lease_owner,
            lease_until_ms,
            lease_epoch,
        } => {
            if !request.next.status.requires_lease()
                || lease_owner.is_empty()
                || lease_owner.len() > 128
                || *lease_until_ms < 0
                || *lease_epoch <= request.expected_lease_epoch
            {
                return Err(invalid_transition());
            }
        }
    }
    Ok(())
}

fn validate_optional_bounded(value: &Option<String>, maximum: usize) -> Result<(), SafeError> {
    if value
        .as_ref()
        .is_some_and(|value| value.is_empty() || value.len() > maximum)
    {
        return Err(invalid_transition());
    }
    Ok(())
}

fn is_lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn lease_bindings(lease: &GenerationJobLeaseUpdate) -> (bool, Option<&str>, Option<i64>, i64) {
    match lease {
        GenerationJobLeaseUpdate::Clear { lease_epoch } => (true, None, None, *lease_epoch),
        GenerationJobLeaseUpdate::Hold {
            lease_owner,
            lease_until_ms,
            lease_epoch,
        } => (
            true,
            Some(lease_owner.as_str()),
            Some(*lease_until_ms),
            *lease_epoch,
        ),
    }
}

fn read_projection(row: &rusqlite::Row<'_>) -> rusqlite::Result<GenerationJobTransitionProjection> {
    let status_text: String = row.get(3)?;
    let status = GenerationJobStatus::try_from(status_text.as_str())
        .map_err(|_| rusqlite::Error::InvalidQuery)?;
    let lease_owner: Option<String> = row.get(7)?;
    let lease_until_ms: Option<i64> = row.get(8)?;
    let lease_epoch: i64 = row.get(9)?;
    let lease = match (lease_owner, lease_until_ms) {
        (None, None) => GenerationJobLease::Clear { lease_epoch },
        (Some(lease_owner), Some(lease_until_ms)) => GenerationJobLease::Held {
            lease_owner,
            lease_until_ms,
            lease_epoch,
        },
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    Ok(GenerationJobTransitionProjection {
        job_id: row.get(0)?,
        save_id: row.get(1)?,
        job_revision: row.get(2)?,
        status,
        request_fingerprint: row.get(4)?,
        selected_model: row.get(5)?,
        next_attempt_at_ms: row.get(6)?,
        lease,
        asset_id: row.get(10)?,
        error_code: row.get(11)?,
        response_ambiguous: row.get(12)?,
        updated_at_ms: row.get(13)?,
    })
}

fn invalid_transition() -> SafeError {
    SafeError::new("provider.invalid-transition", "图片生成任务状态转换无效")
}

fn transition_storage_error() -> SafeError {
    SafeError::new("provider.invalid-transition", "图片生成任务状态更新失败")
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn database(status: GenerationJobStatus) -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .unwrap();
        connection
            .execute_batch(
                "CREATE TABLE saves(save_id TEXT PRIMARY KEY);
                 CREATE TABLE assets(asset_id TEXT PRIMARY KEY);
                 CREATE TABLE generation_jobs(
                   job_id TEXT PRIMARY KEY,
                   save_id TEXT NOT NULL REFERENCES saves(save_id),
                   request_fingerprint TEXT NOT NULL,
                   job_revision INTEGER NOT NULL CHECK(job_revision >= 0),
                   status TEXT NOT NULL,
                   selected_model TEXT,
                   next_attempt_at_ms INTEGER,
                   lease_owner TEXT,
                   lease_until_ms INTEGER,
                   lease_epoch INTEGER NOT NULL CHECK(lease_epoch >= 0),
                   asset_id TEXT REFERENCES assets(asset_id),
                   error_code TEXT,
                   response_ambiguous INTEGER NOT NULL CHECK(response_ambiguous IN (0,1)),
                   created_at_ms INTEGER NOT NULL,
                   updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
                   CHECK(
                     (status = 'retry-delay' AND next_attempt_at_ms IS NOT NULL)
                     OR (status <> 'retry-delay' AND next_attempt_at_ms IS NULL)
                   ),
                   CHECK(
                     (
                       status IN (
                         'checking-model','running-primary','running-fallback','staging-asset'
                       )
                       AND lease_owner IS NOT NULL
                       AND lease_until_ms IS NOT NULL
                     )
                     OR (
                       status NOT IN (
                         'checking-model','running-primary','running-fallback','staging-asset'
                       )
                       AND lease_owner IS NULL
                       AND lease_until_ms IS NULL
                     )
                   ),
                   CHECK(
                     response_ambiguous = 0
                     OR status IN (
                       'needs-retry-confirmation','needs-player-confirmation','failed-terminal'
                     )
                   ),
                   CHECK(
                     status NOT IN ('ready-for-review','adopted') OR asset_id IS NOT NULL
                   )
                 );
                 INSERT INTO saves VALUES('save-1');
                 INSERT INTO assets VALUES('asset-1');",
            )
            .unwrap();
        if status.requires_lease() {
            connection
                .execute(
                    "INSERT INTO generation_jobs(
                       job_id,save_id,request_fingerprint,job_revision,status,
                       lease_owner,lease_until_ms,lease_epoch,response_ambiguous,
                       created_at_ms,updated_at_ms
                     ) VALUES('job-1','save-1',?1,0,?2,'worker-0',100,1,0,0,0)",
                    (HASH, status.as_str()),
                )
                .unwrap();
        } else {
            connection
                .execute(
                    "INSERT INTO generation_jobs(
                       job_id,save_id,request_fingerprint,job_revision,status,
                       lease_epoch,response_ambiguous,created_at_ms,updated_at_ms
                     ) VALUES('job-1','save-1',?1,0,?2,0,0,0,0)",
                    (HASH, status.as_str()),
                )
                .unwrap();
        }
        connection
    }

    fn request(
        expected_status: GenerationJobStatus,
        next_status: GenerationJobStatus,
    ) -> GenerationJobTransitionRequest {
        let expected_lease_epoch = if expected_status.requires_lease() {
            1
        } else {
            0
        };
        let lease = if next_status.requires_lease() {
            GenerationJobLeaseUpdate::Hold {
                lease_owner: "worker-1".to_string(),
                lease_until_ms: 1_000,
                lease_epoch: expected_lease_epoch + 1,
            }
        } else {
            GenerationJobLeaseUpdate::Clear {
                lease_epoch: expected_lease_epoch,
            }
        };
        GenerationJobTransitionRequest {
            job_id: "job-1".to_string(),
            save_id: "save-1".to_string(),
            expected_revision: 0,
            expected_status,
            expected_request_fingerprint: HASH.to_string(),
            expected_lease_epoch,
            next: GenerationJobNextState {
                status: next_status,
                selected_model: None,
                next_attempt_at_ms: None,
                lease,
                asset_id: None,
                error_code: None,
                response_ambiguous: false,
            },
            updated_at_ms: 1,
        }
    }

    fn applied(result: GenerationJobTransitionResult) -> GenerationJobTransitionProjection {
        match result {
            GenerationJobTransitionResult::Applied { job } => *job,
            GenerationJobTransitionResult::CompareAndSetMiss => panic!("expected applied result"),
        }
    }

    fn expect_invalid(result: Result<GenerationJobTransitionResult, SafeError>) {
        let error = result.expect_err("expected invalid transition");
        let json = serde_json::to_value(error).unwrap();
        assert_eq!(json["code"], "provider.invalid-transition");
        assert!(json.get("detail").is_none());
    }

    #[test]
    fn connection_cas_increments_only_revision_and_does_not_use_updated_at_as_token() {
        let connection = database(GenerationJobStatus::Queued);
        let mut transition = request(
            GenerationJobStatus::Queued,
            GenerationJobStatus::CheckingModel,
        );
        transition.updated_at_ms = 77;
        let job = applied(
            connection
                .compare_and_set_generation_job(&transition)
                .unwrap(),
        );

        assert_eq!(job.job_revision, 1);
        assert_eq!(job.status, GenerationJobStatus::CheckingModel);
        assert_eq!(job.updated_at_ms, 77);
    }

    #[test]
    fn every_expected_identity_field_participates_in_the_compare_and_set() {
        let cases = [
            ("job_id", "wrong"),
            ("save_id", "wrong"),
            ("revision", "wrong"),
            ("status", "wrong"),
            ("fingerprint", "wrong"),
            ("lease_epoch", "wrong"),
        ];
        for (field, _) in cases {
            let connection = database(GenerationJobStatus::Queued);
            let mut transition = request(
                GenerationJobStatus::Queued,
                GenerationJobStatus::CheckingModel,
            );
            match field {
                "job_id" => transition.job_id = "job-2".to_string(),
                "save_id" => transition.save_id = "save-2".to_string(),
                "revision" => transition.expected_revision = 1,
                "status" => transition.expected_status = GenerationJobStatus::WaitingNetwork,
                "fingerprint" => transition.expected_request_fingerprint = "b".repeat(64),
                "lease_epoch" => {
                    transition.expected_lease_epoch = 1;
                    transition.next.lease = GenerationJobLeaseUpdate::Hold {
                        lease_owner: "worker-1".to_string(),
                        lease_until_ms: 1_000,
                        lease_epoch: 2,
                    };
                }
                _ => unreachable!(),
            }
            assert_eq!(
                connection
                    .compare_and_set_generation_job(&transition)
                    .unwrap(),
                GenerationJobTransitionResult::CompareAndSetMiss,
                "{field}"
            );
            let revision: i64 = connection
                .query_row(
                    "SELECT job_revision FROM generation_jobs WHERE job_id='job-1'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(revision, 0, "{field}");
        }
    }

    #[test]
    fn stale_revision_misses_without_mutation() {
        let connection = database(GenerationJobStatus::Queued);
        let transition = request(
            GenerationJobStatus::Queued,
            GenerationJobStatus::CheckingModel,
        );
        assert!(matches!(
            connection
                .compare_and_set_generation_job(&transition)
                .unwrap(),
            GenerationJobTransitionResult::Applied { .. }
        ));
        assert_eq!(
            connection
                .compare_and_set_generation_job(&transition)
                .unwrap(),
            GenerationJobTransitionResult::CompareAndSetMiss
        );
        let state: (i64, String) = connection
            .query_row(
                "SELECT job_revision,status FROM generation_jobs WHERE job_id='job-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(state, (1, "checking-model".to_string()));
    }

    #[test]
    fn illegal_graph_edge_is_rejected_before_sql() {
        let connection = database(GenerationJobStatus::Queued);
        let mut transition = request(GenerationJobStatus::Queued, GenerationJobStatus::Adopted);
        transition.next.asset_id = Some("asset-1".to_string());
        expect_invalid(connection.compare_and_set_generation_job(&transition));
        assert!(!GenerationJobStatus::Cancelled.can_transition_to(GenerationJobStatus::Queued));
        assert!(GenerationJobStatus::Adopted.can_transition_to(GenerationJobStatus::Superseded));
    }

    #[test]
    fn retry_delay_requires_timestamp_and_other_states_forbid_it() {
        let connection = database(GenerationJobStatus::RunningPrimary);
        let mut transition = request(
            GenerationJobStatus::RunningPrimary,
            GenerationJobStatus::RetryDelay,
        );
        expect_invalid(connection.compare_and_set_generation_job(&transition));

        transition.next.next_attempt_at_ms = Some(500);
        let delayed = applied(
            connection
                .compare_and_set_generation_job(&transition)
                .unwrap(),
        );
        assert_eq!(delayed.next_attempt_at_ms, Some(500));

        let mut resume = request(
            GenerationJobStatus::RetryDelay,
            GenerationJobStatus::RunningPrimary,
        );
        resume.expected_revision = 1;
        resume.expected_lease_epoch = 1;
        resume.next.lease = GenerationJobLeaseUpdate::Hold {
            lease_owner: "worker-1".to_string(),
            lease_until_ms: 1_000,
            lease_epoch: 2,
        };
        resume.next.next_attempt_at_ms = Some(500);
        expect_invalid(connection.compare_and_set_generation_job(&resume));
        resume.next.next_attempt_at_ms = None;
        let resumed = applied(connection.compare_and_set_generation_job(&resume).unwrap());
        assert_eq!(resumed.next_attempt_at_ms, None);
    }

    #[test]
    fn lease_pair_is_typed_monotonic_and_fences_each_active_transition() {
        let connection = database(GenerationJobStatus::Queued);
        let claim = request(
            GenerationJobStatus::Queued,
            GenerationJobStatus::CheckingModel,
        );
        let claimed = applied(connection.compare_and_set_generation_job(&claim).unwrap());
        assert_eq!(
            claimed.lease,
            GenerationJobLease::Held {
                lease_owner: "worker-1".to_string(),
                lease_until_ms: 1_000,
                lease_epoch: 1,
            }
        );

        let mut renewed = request(
            GenerationJobStatus::CheckingModel,
            GenerationJobStatus::CheckingModel,
        );
        renewed.expected_revision = 1;
        renewed.expected_lease_epoch = 1;
        renewed.next.lease = GenerationJobLeaseUpdate::Hold {
            lease_owner: "worker-2".to_string(),
            lease_until_ms: 2_000,
            lease_epoch: 2,
        };
        let renewed = applied(connection.compare_and_set_generation_job(&renewed).unwrap());
        assert_eq!(
            renewed.lease,
            GenerationJobLease::Held {
                lease_owner: "worker-2".to_string(),
                lease_until_ms: 2_000,
                lease_epoch: 2,
            }
        );

        let mut lower_epoch = request(
            GenerationJobStatus::CheckingModel,
            GenerationJobStatus::CheckingModel,
        );
        lower_epoch.expected_revision = 2;
        lower_epoch.expected_lease_epoch = 2;
        lower_epoch.next.lease = GenerationJobLeaseUpdate::Hold {
            lease_owner: "worker-3".to_string(),
            lease_until_ms: 3_000,
            lease_epoch: 2,
        };
        expect_invalid(connection.compare_and_set_generation_job(&lower_epoch));
    }

    #[test]
    fn ambiguity_is_only_recorded_in_confirmation_or_terminal_states() {
        let running = database(GenerationJobStatus::RunningPrimary);
        let mut invalid = request(
            GenerationJobStatus::RunningPrimary,
            GenerationJobStatus::RetryDelay,
        );
        invalid.next.next_attempt_at_ms = Some(500);
        invalid.next.response_ambiguous = true;
        expect_invalid(running.compare_and_set_generation_job(&invalid));

        let connection = database(GenerationJobStatus::RunningPrimary);
        let mut ambiguous = request(
            GenerationJobStatus::RunningPrimary,
            GenerationJobStatus::NeedsRetryConfirmation,
        );
        ambiguous.next.response_ambiguous = true;
        let job = applied(
            connection
                .compare_and_set_generation_job(&ambiguous)
                .unwrap(),
        );
        assert!(job.response_ambiguous);
    }

    #[test]
    fn ready_and_adopted_states_require_a_real_asset() {
        let connection = database(GenerationJobStatus::StagingAsset);
        let mut ready = request(
            GenerationJobStatus::StagingAsset,
            GenerationJobStatus::ReadyForReview,
        );
        expect_invalid(connection.compare_and_set_generation_job(&ready));

        ready.next.asset_id = Some("missing-asset".to_string());
        expect_invalid(connection.compare_and_set_generation_job(&ready));

        ready.next.asset_id = Some("asset-1".to_string());
        let ready_job = applied(connection.compare_and_set_generation_job(&ready).unwrap());
        assert_eq!(ready_job.asset_id.as_deref(), Some("asset-1"));

        let mut adopt = request(
            GenerationJobStatus::ReadyForReview,
            GenerationJobStatus::Adopted,
        );
        adopt.expected_revision = 1;
        adopt.expected_lease_epoch = 1;
        adopt.next.lease = GenerationJobLeaseUpdate::Clear { lease_epoch: 1 };
        expect_invalid(connection.compare_and_set_generation_job(&adopt));
        adopt.next.asset_id = Some("asset-1".to_string());
        let adopted = applied(connection.compare_and_set_generation_job(&adopt).unwrap());
        assert_eq!(adopted.status, GenerationJobStatus::Adopted);
    }

    #[test]
    fn transaction_implementation_participates_in_caller_atomicity() {
        let mut connection = database(GenerationJobStatus::Queued);
        {
            let transaction = connection.transaction().unwrap();
            let transition = request(
                GenerationJobStatus::Queued,
                GenerationJobStatus::CheckingModel,
            );
            assert!(matches!(
                transaction
                    .compare_and_set_generation_job(&transition)
                    .unwrap(),
                GenerationJobTransitionResult::Applied { .. }
            ));
            transaction.rollback().unwrap();
        }
        let revision: i64 = connection
            .query_row(
                "SELECT job_revision FROM generation_jobs WHERE job_id='job-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(revision, 0);
    }
}

//! Durable visual-job application service.
//!
//! This module owns the narrow coordination surface used by Tauri commands.
//! It deliberately keeps provider credentials inside Rust and makes provider
//! I/O an explicit `run_one` operation; enqueue/list/UI actions never send.

use crate::assets::AssetStore;
use crate::generation_jobs::{
    GenerationJobLeaseUpdate, GenerationJobNextState, GenerationJobStatus,
    GenerationJobTransitionExt, GenerationJobTransitionProjection, GenerationJobTransitionRequest,
    GenerationJobTransitionResult,
};
use crate::keychain::PlatformKeychainService;
use crate::persistence::{persist_verified_asset_reference, SaveRepository};
use crate::provider::{
    ApiNebulaProvider, GenerateImageRequest, GeneratedImage, ImageResolution,
    PrimaryUnavailableReason, ProviderError, ReferenceImage, FALLBACK_MODEL, PRIMARY_MODEL,
};
use crate::provider_control::ProviderControlStore;
use crate::redaction::SafeError;
use crate::reliability::validate_current_save_database;
use rusqlite::{
    params, Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

const MAX_PROMPT_CHARS: usize = 12_000;
const MAX_REFERENCES: usize = 4;
const LEASE_MS: i64 = 10 * 60 * 1_000;
const RETRY_BACKOFF_MS: [i64; 3] = [5_000, 30_000, 120_000];
const MAX_RETRY_DELAY_MS: i64 = 15 * 60 * 1_000;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VisualResolution {
    #[serde(rename = "1k")]
    OneK,
    #[serde(rename = "2k")]
    TwoK,
    #[serde(rename = "4k")]
    FourK,
}

impl VisualResolution {
    fn provider(self) -> ImageResolution {
        match self {
            Self::OneK => ImageResolution::OneK,
            Self::TwoK => ImageResolution::TwoK,
            Self::FourK => ImageResolution::FourK,
        }
    }

    const fn as_str(self) -> &'static str {
        match self {
            Self::OneK => "1k",
            Self::TwoK => "2k",
            Self::FourK => "4k",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VisualTargetKind {
    Master,
    Focus,
}

impl VisualTargetKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Master => "master",
            Self::Focus => "focus",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualJobRequest {
    pub target_kind: VisualTargetKind,
    pub prompt: String,
    pub resolution: VisualResolution,
    pub reference_asset_ids: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetProjection {
    pub asset_id: String,
    pub mime_type: String,
    pub byte_length: i64,
    pub width: i64,
    pub height: i64,
    pub sha256: String,
    pub resolver_url: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualJobProjection {
    pub job_id: String,
    pub save_id: String,
    pub job_revision: i64,
    pub status: GenerationJobStatus,
    pub target_kind: VisualTargetKind,
    pub target_fingerprint: String,
    pub request_fingerprint: String,
    pub resolution: VisualResolution,
    pub selected_model: Option<String>,
    pub attempt_count: i64,
    pub next_attempt_at_ms: Option<i64>,
    pub asset: Option<AssetProjection>,
    pub error_code: Option<String>,
    pub response_ambiguous: bool,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualAdoptionResult {
    pub job: VisualJobProjection,
    pub game_revision: i64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FallbackChoice {
    #[serde(rename = "compatible-1k")]
    CompatibleOneK,
}

pub struct VisualRuntimeService {
    app_root: PathBuf,
}

impl VisualRuntimeService {
    pub fn new(app_root: PathBuf) -> Self {
        Self { app_root }
    }

    pub fn enqueue_visual_job(
        &self,
        save_id: &str,
        request: VisualJobRequest,
        expected_revision: i64,
        target_fingerprint: &str,
        now_ms: i64,
    ) -> Result<VisualJobProjection, SafeError> {
        validate_request(&request, target_fingerprint, now_ms)?;
        let (_prepared, mut connection) = self.open_save(save_id)?;
        let game_revision: i64 = connection
            .query_row(
                "SELECT revision FROM saves WHERE save_id=?1",
                [save_id],
                |row| row.get(0),
            )
            .map_err(|_| save_error())?;
        if game_revision != expected_revision {
            return Err(stale_save());
        }
        let request_json = serde_json::to_string(&request).map_err(|_| invalid_request())?;
        let request_fingerprint = sha256_hex(request_json.as_bytes());
        let job_id = Uuid::new_v4().to_string();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| save_error())?;
        transaction
            .execute(
                "INSERT INTO generation_jobs(
                   job_id,save_id,target_kind,target_fingerprint,request_fingerprint,
                   job_revision,request_json,status,selected_model,next_attempt_at_ms,
                   lease_owner,lease_until_ms,lease_epoch,asset_id,error_code,
                   response_ambiguous,created_at_ms,updated_at_ms
                 ) VALUES(?1,?2,?3,?4,?5,0,?6,'queued',NULL,NULL,NULL,NULL,0,NULL,NULL,0,?7,?7)",
                params![
                    job_id,
                    save_id,
                    request.target_kind.as_str(),
                    target_fingerprint,
                    request_fingerprint,
                    request_json,
                    now_ms
                ],
            )
            .map_err(|_| save_error())?;
        transaction.commit().map_err(|_| save_error())?;
        self.require_job(&connection, save_id, &job_id)
    }

    pub fn list_visual_jobs(&self, save_id: &str) -> Result<Vec<VisualJobProjection>, SafeError> {
        let (_prepared, connection) = self.open_save(save_id)?;
        let now_ms = observe_wall_clock(&connection, current_time_ms()?)?;
        recover_expired_leases(&connection, save_id, now_ms)?;
        self.recover_due_retries(&connection, save_id, now_ms)?;
        self.list_jobs_on(&connection, save_id)
    }

    pub fn recover_expired_visual_jobs(
        &self,
        save_id: &str,
        now_ms: i64,
    ) -> Result<Vec<VisualJobProjection>, SafeError> {
        if now_ms < 0 {
            return Err(invalid_transition());
        }
        let (_prepared, connection) = self.open_save(save_id)?;
        let now_ms = observe_wall_clock(&connection, now_ms)?;
        recover_expired_leases(&connection, save_id, now_ms)?;
        self.recover_due_retries(&connection, save_id, now_ms)?;
        self.list_jobs_on(&connection, save_id)
    }

    fn recover_due_retries(
        &self,
        connection: &Connection,
        save_id: &str,
        now_ms: i64,
    ) -> Result<(), SafeError> {
        let mut statement = connection
            .prepare(
                "SELECT job_id FROM generation_jobs
                 WHERE save_id=?1 AND status='retry-delay'
                   AND response_ambiguous=0 AND next_attempt_at_ms<=?2
                 ORDER BY next_attempt_at_ms,job_id",
            )
            .map_err(|_| save_error())?;
        let job_ids = statement
            .query_map(params![save_id, now_ms], |row| row.get::<_, String>(0))
            .map_err(|_| save_error())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| save_error())?;
        drop(statement);
        for job_id in job_ids {
            let current = self.require_job(connection, save_id, &job_id)?;
            let status = if current.attempt_count >= 3 {
                GenerationJobStatus::FailedTerminal
            } else {
                GenerationJobStatus::FailedRetryable
            };
            transition_on(
                connection,
                &current,
                TransitionSpec {
                    status,
                    selected_model: current.selected_model.clone(),
                    next_attempt_at_ms: None,
                    asset_id: current.asset.as_ref().map(|asset| asset.asset_id.clone()),
                    error_code: current.error_code.clone(),
                    response_ambiguous: false,
                    lease: GenerationJobLeaseUpdate::Clear {
                        lease_epoch: current.lease_epoch(),
                    },
                    now_ms,
                },
            )?;
        }
        Ok(())
    }

    fn list_jobs_on(
        &self,
        connection: &Connection,
        save_id: &str,
    ) -> Result<Vec<VisualJobProjection>, SafeError> {
        let mut statement = connection
            .prepare(
                "SELECT job_id FROM generation_jobs WHERE save_id=?1 ORDER BY created_at_ms,job_id",
            )
            .map_err(|_| save_error())?;
        let ids = statement
            .query_map([save_id], |row| row.get::<_, String>(0))
            .map_err(|_| save_error())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| save_error())?;
        ids.iter()
            .map(|id| self.require_job(connection, save_id, id))
            .collect()
    }

    pub fn retry_visual_job(
        &self,
        save_id: &str,
        job_id: &str,
        expected_job_revision: i64,
        now_ms: i64,
    ) -> Result<VisualJobProjection, SafeError> {
        let (_prepared, connection) = self.open_save(save_id)?;
        let current = self.require_job(&connection, save_id, job_id)?;
        require_revision(&current, expected_job_revision)?;
        if current.attempt_count >= 3 {
            return Err(invalid_transition());
        }
        match current.status {
            GenerationJobStatus::FailedRetryable
            | GenerationJobStatus::WaitingNetwork
            | GenerationJobStatus::BlockedNoCredential => self.clear_transition(
                &connection,
                &current,
                GenerationJobStatus::Queued,
                None,
                now_ms,
            ),
            GenerationJobStatus::NeedsRetryConfirmation => {
                let model = current
                    .selected_model
                    .clone()
                    .unwrap_or_else(|| PRIMARY_MODEL.to_owned());
                let confirmed = self.clear_transition_with_model(
                    &connection,
                    &current,
                    GenerationJobStatus::NeedsRetryConfirmation,
                    Some(model.clone()),
                    None,
                    now_ms,
                )?;
                self.issue_grant(&confirmed, &model, "player-confirmed", now_ms)?;
                Ok(confirmed)
            }
            _ => Err(invalid_transition()),
        }
    }

    pub fn cancel_visual_job(
        &self,
        save_id: &str,
        job_id: &str,
        expected_job_revision: i64,
        now_ms: i64,
    ) -> Result<VisualJobProjection, SafeError> {
        let (_prepared, connection) = self.open_save(save_id)?;
        let current = self.require_job(&connection, save_id, job_id)?;
        require_revision(&current, expected_job_revision)?;
        self.expire_issued_grants(save_id, job_id)?;
        let next = self.clear_transition(
            &connection,
            &current,
            GenerationJobStatus::Cancelled,
            None,
            now_ms,
        )?;
        Ok(next)
    }

    pub fn confirm_visual_send(
        &self,
        save_id: &str,
        job_id: &str,
        expected_job_revision: i64,
        now_ms: i64,
    ) -> Result<VisualJobProjection, SafeError> {
        let (_prepared, connection) = self.open_save(save_id)?;
        let current = self.require_job(&connection, save_id, job_id)?;
        require_revision(&current, expected_job_revision)?;
        if !matches!(
            current.status,
            GenerationJobStatus::Queued
                | GenerationJobStatus::NeedsPlayerConfirmation
                | GenerationJobStatus::NeedsRetryConfirmation
        ) {
            return Err(invalid_transition());
        }
        let model = current
            .selected_model
            .clone()
            .unwrap_or_else(|| PRIMARY_MODEL.to_owned());
        let next = self.clear_transition_with_model(
            &connection,
            &current,
            current.status,
            Some(model.clone()),
            None,
            now_ms,
        )?;
        self.issue_grant(&next, &model, "player-confirmed", now_ms)?;
        Ok(next)
    }

    pub fn choose_visual_fallback(
        &self,
        save_id: &str,
        job_id: &str,
        expected_job_revision: i64,
        _choice: FallbackChoice,
        now_ms: i64,
    ) -> Result<VisualJobProjection, SafeError> {
        let (_prepared, connection) = self.open_save(save_id)?;
        let current = self.require_job(&connection, save_id, job_id)?;
        require_revision(&current, expected_job_revision)?;
        if current.resolution != VisualResolution::OneK
            || !matches!(
                current.status,
                GenerationJobStatus::NeedsPlayerConfirmation
                    | GenerationJobStatus::NeedsRetryConfirmation
            )
        {
            return Err(invalid_transition());
        }
        let next = self.clear_transition_with_model(
            &connection,
            &current,
            current.status,
            Some(FALLBACK_MODEL.to_owned()),
            None,
            now_ms,
        )?;
        self.issue_grant(&next, FALLBACK_MODEL, "player-fallback-choice", now_ms)?;
        Ok(next)
    }

    pub fn confirm_visual_adoption(
        &self,
        save_id: &str,
        job_id: &str,
        expected_job_revision: i64,
        expected_revision: i64,
        target_fingerprint: &str,
        now_ms: i64,
    ) -> Result<VisualAdoptionResult, SafeError> {
        let (prepared, mut connection) = self.open_save(save_id)?;
        let current = self.require_job(&connection, save_id, job_id)?;
        require_revision(&current, expected_job_revision)?;
        if current.status != GenerationJobStatus::ReadyForReview
            || current.target_fingerprint != target_fingerprint
            || current.asset.is_none()
        {
            return Err(invalid_transition());
        }
        let asset_id = current
            .asset
            .as_ref()
            .map(|asset| asset.asset_id.clone())
            .ok_or_else(invalid_transition)?;
        let repository = SaveRepository::new(self.app_root.clone());
        let recovery = repository.prepare_critical_recovery(
            &prepared,
            expected_revision,
            crate::recovery::RecoveryReason::VisualAdoption,
        )?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| save_error())?;
        let updated = transaction
            .execute(
                "UPDATE saves SET revision=revision+1 WHERE save_id=?1 AND revision=?2",
                params![save_id, expected_revision],
            )
            .map_err(|_| save_error())?;
        if updated != 1 {
            return Err(stale_save());
        }
        transaction
            .execute(
                "INSERT INTO asset_references(owner_kind,owner_id,asset_id)
                 VALUES('visual-target',?1,?2) ON CONFLICT DO NOTHING",
                params![target_fingerprint, asset_id],
            )
            .map_err(|_| save_error())?;
        apply_adopted_visual(&transaction, &current, &asset_id)?;
        recovery.record_pending(&transaction, expected_revision + 1)?;
        let transitioned = transition_on(
            &transaction,
            &current,
            TransitionSpec {
                status: GenerationJobStatus::Adopted,
                selected_model: current.selected_model.clone(),
                next_attempt_at_ms: None,
                asset_id: current.asset.as_ref().map(|asset| asset.asset_id.clone()),
                error_code: None,
                response_ambiguous: false,
                lease: GenerationJobLeaseUpdate::Clear {
                    lease_epoch: current.lease_epoch(),
                },
                now_ms,
            },
        )?;
        transaction.commit().map_err(|_| save_error())?;
        let job = self.require_job(&connection, save_id, &transitioned.job_id)?;
        repository.finish_critical_recovery(&mut connection, recovery);
        Ok(VisualAdoptionResult {
            job,
            game_revision: expected_revision + 1,
        })
    }

    /// Executes at most one explicitly authorized job. Callers decide when to
    /// trigger it; no background loop or UI operation can cause provider I/O.
    pub fn run_one(
        &self,
        save_id: &str,
        job_id: &str,
        keychain: &PlatformKeychainService,
        provider: &ApiNebulaProvider,
        now_ms: i64,
    ) -> Result<VisualJobProjection, SafeError> {
        self.run_one_with(save_id, job_id, keychain, provider, now_ms)
    }

    pub(crate) fn automatic_followup_ready(
        &self,
        job: &VisualJobProjection,
        now_ms: i64,
    ) -> Result<bool, SafeError> {
        Ok(job.status == GenerationJobStatus::NeedsPlayerConfirmation
            && job.selected_model.as_deref() == Some(FALLBACK_MODEL)
            && self.has_issued_grant(job, FALLBACK_MODEL, now_ms)?)
    }

    fn run_one_with<T: TokenSource, P: ProviderBackend>(
        &self,
        save_id: &str,
        job_id: &str,
        tokens: &T,
        provider: &P,
        now_ms: i64,
    ) -> Result<VisualJobProjection, SafeError> {
        let now_ms = {
            let (_prepared, connection) = self.open_save(save_id)?;
            observe_wall_clock(&connection, now_ms)?
        };
        let Some(token) = tokens.token()? else {
            let (_prepared, connection) = self.open_save(save_id)?;
            let current = self.require_job(&connection, save_id, job_id)?;
            return self.clear_transition(
                &connection,
                &current,
                GenerationJobStatus::BlockedNoCredential,
                Some("keychain.missing"),
                now_ms,
            );
        };

        let (attempt_id, model, request, running) = {
            let (_prepared, connection) = self.open_save(save_id)?;
            let mut current = self.require_job(&connection, save_id, job_id)?;
            if !matches!(
                current.status,
                GenerationJobStatus::Queued
                    | GenerationJobStatus::NeedsPlayerConfirmation
                    | GenerationJobStatus::NeedsRetryConfirmation
            ) {
                return Err(invalid_transition());
            }
            let model = current
                .selected_model
                .as_deref()
                .unwrap_or(PRIMARY_MODEL)
                .to_owned();
            if !self.has_issued_grant(&current, &model, now_ms)?
                && !self.has_reusable_reservation(&current, &model, now_ms)?
            {
                let preferences =
                    ProviderControlStore::new(self.app_root.clone()).get_preferences(now_ms)?;
                if preferences.require_send_confirmation {
                    return self.clear_transition(
                        &connection,
                        &current,
                        GenerationJobStatus::NeedsPlayerConfirmation,
                        Some("provider.confirmation-required"),
                        now_ms,
                    );
                }
                self.issue_grant(&current, &model, "confirmation-disabled", now_ms)?;
            }
            let (attempt_id, _sequence) =
                self.consume_grant_and_reserve(&current, &model, now_ms)?;
            let checking_status = if model == FALLBACK_MODEL {
                GenerationJobStatus::RunningFallback
            } else {
                GenerationJobStatus::CheckingModel
            };
            current = self.hold_transition(
                &connection,
                &current,
                checking_status,
                Some(model.clone()),
                now_ms,
            )?;
            let request = self.provider_request(&connection, save_id, &current)?;
            let running_status = if model == FALLBACK_MODEL {
                GenerationJobStatus::RunningFallback
            } else {
                GenerationJobStatus::RunningPrimary
            };
            let running = self.hold_transition(
                &connection,
                &current,
                running_status,
                Some(model.clone()),
                now_ms,
            )?;
            (attempt_id, model, request, running)
        };

        if let Err(error) = provider.check_health(token.as_str()) {
            self.finish_attempt(&attempt_id, &error, now_ms, false)?;
            let (_prepared, connection) = self.open_save(save_id)?;
            let current = self.require_matching_running(&connection, &running)?;
            return self.finish_provider_error(&connection, &current, error, false, now_ms);
        }
        self.mark_attempt_sent(&attempt_id, now_ms)?;
        let generated = if model == FALLBACK_MODEL {
            provider.generate_fallback(token.as_str(), &request)
        } else {
            provider.generate_primary(token.as_str(), &request)
        };
        match &generated {
            Ok(_) => self.finish_attempt_success(&attempt_id, now_ms)?,
            Err(error) => self.finish_attempt(&attempt_id, error, now_ms, true)?,
        }
        let (_prepared, mut connection) = self.open_save(save_id)?;
        let current = match self.require_matching_running(&connection, &running) {
            Ok(current) => current,
            Err(_) => return self.require_job(&connection, save_id, job_id),
        };
        match generated {
            Ok(image) => {
                let staging = self.hold_transition(
                    &connection,
                    &current,
                    GenerationJobStatus::StagingAsset,
                    Some(model),
                    now_ms,
                )?;
                self.finish_asset(&mut connection, &staging, image, now_ms)
            }
            Err(error) => self.finish_provider_error(&connection, &current, error, true, now_ms),
        }
    }

    fn require_matching_running(
        &self,
        connection: &Connection,
        expected: &VisualJobProjection,
    ) -> Result<VisualJobProjection, SafeError> {
        let current = self.require_job(connection, &expected.save_id, &expected.job_id)?;
        if current.job_revision != expected.job_revision
            || current.status != expected.status
            || current.request_fingerprint != expected.request_fingerprint
            || current.target_fingerprint != expected.target_fingerprint
        {
            return Err(job_stale());
        }
        Ok(current)
    }

    fn open_save(
        &self,
        save_id: &str,
    ) -> Result<(crate::persistence::PreparedSaveDatabase, Connection), SafeError> {
        let prepared = SaveRepository::new(self.app_root.clone()).prepare_save_database(save_id)?;
        let path = self.save_path(save_id);
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| save_error())?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(|_| save_error())?;
        connection
            .pragma_update(None, "trusted_schema", "OFF")
            .map_err(|_| save_error())?;
        validate_current_save_database(&connection)?;
        Ok((prepared, connection))
    }

    fn save_path(&self, save_id: &str) -> PathBuf {
        self.app_root
            .join("saves")
            .join(save_id)
            .join("save.sqlite3")
    }

    fn require_job(
        &self,
        connection: &Connection,
        save_id: &str,
        job_id: &str,
    ) -> Result<VisualJobProjection, SafeError> {
        let mut job = read_job(connection, save_id, job_id)?.ok_or_else(job_not_found)?;
        let control = ProviderControlStore::new(self.app_root.clone()).open_validated()?;
        job.attempt_count = control
            .query_row(
                "SELECT count(*) FROM provider_attempts WHERE save_id=?1 AND job_id=?2",
                params![save_id, job_id],
                |row| row.get(0),
            )
            .map_err(|_| control_error())?;
        Ok(job)
    }

    fn clear_transition(
        &self,
        connection: &Connection,
        current: &VisualJobProjection,
        status: GenerationJobStatus,
        error: Option<&str>,
        now_ms: i64,
    ) -> Result<VisualJobProjection, SafeError> {
        self.clear_transition_with_model(
            connection,
            current,
            status,
            current.selected_model.clone(),
            error,
            now_ms,
        )
    }

    fn clear_transition_with_model(
        &self,
        connection: &Connection,
        current: &VisualJobProjection,
        status: GenerationJobStatus,
        selected_model: Option<String>,
        error: Option<&str>,
        now_ms: i64,
    ) -> Result<VisualJobProjection, SafeError> {
        transition_on(
            connection,
            current,
            TransitionSpec {
                status,
                selected_model,
                next_attempt_at_ms: None,
                asset_id: current.asset.as_ref().map(|asset| asset.asset_id.clone()),
                error_code: error.map(str::to_owned),
                response_ambiguous: false,
                lease: GenerationJobLeaseUpdate::Clear {
                    lease_epoch: current.lease_epoch(),
                },
                now_ms,
            },
        )?;
        self.require_job(connection, &current.save_id, &current.job_id)
    }

    fn hold_transition(
        &self,
        connection: &Connection,
        current: &VisualJobProjection,
        status: GenerationJobStatus,
        selected_model: Option<String>,
        now_ms: i64,
    ) -> Result<VisualJobProjection, SafeError> {
        let epoch = current
            .lease_epoch()
            .checked_add(1)
            .ok_or_else(invalid_transition)?;
        transition_on(
            connection,
            current,
            TransitionSpec {
                status,
                selected_model,
                next_attempt_at_ms: None,
                asset_id: current.asset.as_ref().map(|asset| asset.asset_id.clone()),
                error_code: None,
                response_ambiguous: false,
                lease: GenerationJobLeaseUpdate::Hold {
                    lease_owner: format!("manual-{}", Uuid::new_v4()),
                    lease_until_ms: now_ms
                        .checked_add(LEASE_MS)
                        .ok_or_else(invalid_transition)?,
                    lease_epoch: epoch,
                },
                now_ms,
            },
        )?;
        self.require_job(connection, &current.save_id, &current.job_id)
    }

    fn issue_grant(
        &self,
        current: &VisualJobProjection,
        model: &str,
        source: &str,
        now_ms: i64,
    ) -> Result<(), SafeError> {
        let store = ProviderControlStore::new(self.app_root.clone());
        let day = store.get_preferences(now_ms)?.effective_quota_day;
        let mut connection = store.open_validated()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| control_error())?;
        tx.execute(
            "UPDATE provider_send_grants SET state='expired'
             WHERE state='issued' AND quota_day<>?1",
            [day],
        )
        .map_err(|_| control_error())?;
        tx.execute(
            "UPDATE provider_preferences
             SET last_quota_day=max(last_quota_day,?1),updated_at_ms=max(updated_at_ms,?2)
             WHERE singleton=1",
            params![day, now_ms],
        )
        .map_err(|_| control_error())?;
        let attempts: i64 = tx
            .query_row(
                "SELECT count(*) FROM provider_attempts WHERE quota_day=?1",
                [day],
                |row| row.get(0),
            )
            .map_err(|_| control_error())?;
        let ceiling: i64 = tx
            .query_row(
                "SELECT daily_request_ceiling FROM provider_preferences WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .map_err(|_| control_error())?;
        if attempts >= ceiling {
            return Err(SafeError::new(
                "provider.quota-exceeded",
                "今日图片请求次数已达上限",
            ));
        }
        let sequence: i64 = tx.query_row("SELECT COALESCE(MAX(sequence),0)+1 FROM provider_attempts WHERE save_id=?1 AND job_id=?2", params![current.save_id, current.job_id], |row| row.get(0)).map_err(|_| control_error())?;
        tx.execute("INSERT INTO provider_send_grants(grant_id,save_id,job_id,job_revision,attempt_sequence,model,request_fingerprint,quota_day,source,state,issued_at_ms,consumed_attempt_id,consumed_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'issued',?10,NULL,NULL)", params![Uuid::new_v4().to_string(), current.save_id, current.job_id, current.job_revision, sequence, model, current.request_fingerprint, day, source, now_ms]).map_err(|_| control_error())?;
        tx.commit().map_err(|_| control_error())
    }

    fn has_issued_grant(
        &self,
        current: &VisualJobProjection,
        model: &str,
        now_ms: i64,
    ) -> Result<bool, SafeError> {
        let store = ProviderControlStore::new(self.app_root.clone());
        let day = store.get_preferences(now_ms)?.effective_quota_day;
        let connection = store.open_validated()?;
        let count: i64 = connection.query_row("SELECT count(*) FROM provider_send_grants WHERE save_id=?1 AND job_id=?2 AND job_revision=?3 AND model=?4 AND request_fingerprint=?5 AND quota_day=?6 AND state='issued'", params![current.save_id,current.job_id,current.job_revision,model,current.request_fingerprint,day], |row| row.get(0)).map_err(|_| control_error())?;
        Ok(count == 1)
    }

    fn has_reusable_reservation(
        &self,
        current: &VisualJobProjection,
        model: &str,
        now_ms: i64,
    ) -> Result<bool, SafeError> {
        let store = ProviderControlStore::new(self.app_root.clone());
        let day = store.get_preferences(now_ms)?.effective_quota_day;
        let connection = store.open_validated()?;
        let count: i64 = connection
            .query_row(
                "SELECT count(*)
                 FROM provider_attempts a
                 JOIN provider_send_grants g ON g.consumed_attempt_id=a.attempt_id
                 WHERE a.save_id=?1 AND a.job_id=?2 AND a.model=?3
                   AND a.quota_day=?4 AND a.state='reserved'
                   AND g.state='consumed' AND g.job_revision=?5
                   AND g.request_fingerprint=?6",
                params![
                    current.save_id,
                    current.job_id,
                    model,
                    day,
                    current.job_revision,
                    current.request_fingerprint
                ],
                |row| row.get(0),
            )
            .map_err(|_| control_error())?;
        Ok(count == 1)
    }

    fn consume_grant_and_reserve(
        &self,
        current: &VisualJobProjection,
        model: &str,
        now_ms: i64,
    ) -> Result<(String, i64), SafeError> {
        let store = ProviderControlStore::new(self.app_root.clone());
        let day = store.get_preferences(now_ms)?.effective_quota_day;
        let mut connection = store.open_validated()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| control_error())?;
        let reusable: Option<(String, i64)> = tx
            .query_row(
                "SELECT a.attempt_id,a.sequence
                 FROM provider_attempts a
                 JOIN provider_send_grants g ON g.consumed_attempt_id=a.attempt_id
                 WHERE a.save_id=?1 AND a.job_id=?2 AND a.model=?3
                   AND a.quota_day=?4 AND a.state='reserved'
                   AND g.state='consumed' AND g.job_revision=?5
                   AND g.request_fingerprint=?6",
                params![
                    current.save_id,
                    current.job_id,
                    model,
                    day,
                    current.job_revision,
                    current.request_fingerprint
                ],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|_| control_error())?;
        if let Some(reusable) = reusable {
            return Ok(reusable);
        }
        let ceiling: i64 = tx
            .query_row(
                "SELECT daily_request_ceiling FROM provider_preferences WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .map_err(|_| control_error())?;
        let used: i64 = tx
            .query_row(
                "SELECT count(*) FROM provider_attempts WHERE quota_day=?1",
                [day],
                |row| row.get(0),
            )
            .map_err(|_| control_error())?;
        if used >= ceiling {
            return Err(SafeError::new(
                "provider.quota-exceeded",
                "今日图片请求次数已达上限",
            ));
        }
        let grant: Option<(String,i64)> = tx.query_row("SELECT grant_id,attempt_sequence FROM provider_send_grants WHERE save_id=?1 AND job_id=?2 AND job_revision=?3 AND model=?4 AND request_fingerprint=?5 AND quota_day=?6 AND state='issued'", params![current.save_id,current.job_id,current.job_revision,model,current.request_fingerprint,day], |row| Ok((row.get(0)?,row.get(1)?))).optional().map_err(|_| control_error())?;
        let (grant_id, sequence) = grant.ok_or_else(|| {
            SafeError::new("provider.confirmation-required", "发送图片请求前需要确认")
        })?;
        let attempt_id = Uuid::new_v4().to_string();
        tx.execute("INSERT INTO provider_attempts(attempt_id,save_id,job_id,quota_day,model,sequence,state,reserved_at_ms,sent_at_ms,completed_at_ms,outcome_code) VALUES(?1,?2,?3,?4,?5,?6,'reserved',?7,NULL,NULL,NULL)", params![attempt_id,current.save_id,current.job_id,day,model,sequence,now_ms]).map_err(|_| control_error())?;
        let changed = tx.execute("UPDATE provider_send_grants SET state='consumed',consumed_attempt_id=?1,consumed_at_ms=?2 WHERE grant_id=?3 AND state='issued'", params![attempt_id,now_ms,grant_id]).map_err(|_| control_error())?;
        if changed != 1 {
            return Err(control_error());
        }
        tx.commit().map_err(|_| control_error())?;
        Ok((attempt_id, sequence))
    }

    fn expire_issued_grants(&self, save_id: &str, job_id: &str) -> Result<(), SafeError> {
        let connection = ProviderControlStore::new(self.app_root.clone()).open_validated()?;
        connection.execute("UPDATE provider_send_grants SET state='expired' WHERE save_id=?1 AND job_id=?2 AND state='issued'", params![save_id,job_id]).map_err(|_| control_error())?;
        Ok(())
    }

    fn mark_attempt_sent(&self, attempt_id: &str, now_ms: i64) -> Result<(), SafeError> {
        let connection = ProviderControlStore::new(self.app_root.clone()).open_validated()?;
        let changed = connection.execute("UPDATE provider_attempts SET state='sent',sent_at_ms=?1 WHERE attempt_id=?2 AND state='reserved'", params![now_ms,attempt_id]).map_err(|_| control_error())?;
        if changed == 1 {
            Ok(())
        } else {
            Err(control_error())
        }
    }

    fn finish_attempt_success(&self, attempt_id: &str, now_ms: i64) -> Result<(), SafeError> {
        self.finish_attempt_code(attempt_id, "outcome-known", "success", now_ms)
    }

    fn finish_attempt(
        &self,
        attempt_id: &str,
        error: &ProviderError,
        now_ms: i64,
        sent: bool,
    ) -> Result<(), SafeError> {
        let (state, code) = if !sent {
            ("expired-unsent", "expired-unsent")
        } else if matches!(
            error,
            ProviderError::NeedsRetryConfirmation | ProviderError::NetworkUnavailable
        ) {
            ("outcome-unknown", provider_error_code(error))
        } else {
            ("outcome-known", provider_error_code(error))
        };
        self.finish_attempt_code(attempt_id, state, code, now_ms)
    }

    fn finish_attempt_code(
        &self,
        attempt_id: &str,
        state: &str,
        code: &str,
        now_ms: i64,
    ) -> Result<(), SafeError> {
        let connection = ProviderControlStore::new(self.app_root.clone()).open_validated()?;
        let changed = connection.execute("UPDATE provider_attempts SET state=?1,completed_at_ms=?2,outcome_code=?3 WHERE attempt_id=?4 AND state IN ('reserved','sent')", params![state,now_ms,code,attempt_id]).map_err(|_| control_error())?;
        if changed == 1 {
            Ok(())
        } else {
            Err(control_error())
        }
    }

    fn provider_request(
        &self,
        connection: &Connection,
        save_id: &str,
        current: &VisualJobProjection,
    ) -> Result<GenerateImageRequest, SafeError> {
        let request_json: String = connection
            .query_row(
                "SELECT request_json FROM generation_jobs WHERE save_id=?1 AND job_id=?2",
                params![save_id, current.job_id],
                |row| row.get(0),
            )
            .map_err(|_| save_error())?;
        let request: VisualJobRequest =
            serde_json::from_str(&request_json).map_err(|_| save_error())?;
        let mut references = Vec::with_capacity(request.reference_asset_ids.len());
        for asset_id in &request.reference_asset_ids {
            let (relative_path, mime_type, sha256): (String, String, String) = connection
                .query_row(
                    "SELECT relative_path,mime_type,sha256 FROM assets WHERE asset_id=?1",
                    [asset_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .map_err(|_| SafeError::new("asset.not-found", "引用图片不存在"))?;
            let path = self
                .app_root
                .join("saves")
                .join(save_id)
                .join(relative_path);
            let metadata = fs::symlink_metadata(&path)
                .map_err(|_| SafeError::new("asset.not-found", "引用图片不存在"))?;
            if metadata.file_type().is_symlink()
                || !metadata.is_file()
                || metadata.len() > 32 * 1024 * 1024
            {
                return Err(SafeError::new("asset.corrupt", "引用图片无效"));
            }
            let bytes =
                fs::read(path).map_err(|_| SafeError::new("asset.corrupt", "引用图片无效"))?;
            if sha256_hex(&bytes) != sha256 {
                return Err(SafeError::new("asset.corrupt", "引用图片无效"));
            }
            references.push(ReferenceImage { mime_type, bytes });
        }
        Ok(GenerateImageRequest {
            prompt: request.prompt,
            references,
            aspect_ratio: None,
            resolution: request.resolution.provider(),
        })
    }

    fn finish_asset(
        &self,
        connection: &mut Connection,
        current: &VisualJobProjection,
        image: GeneratedImage,
        now_ms: i64,
    ) -> Result<VisualJobProjection, SafeError> {
        let save_directory = self.app_root.join("saves").join(&current.save_id);
        let stored = AssetStore::new(&save_directory)
            .store(&image.bytes, &image.mime_type, image.width, image.height)
            .map_err(|_| SafeError::new("asset.write-failed", "无法保存生成图片"))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| save_error())?;
        let asset_id = persist_verified_asset_reference(
            &transaction,
            &stored,
            "generation-job",
            &current.job_id,
        )?;
        transition_on(
            &transaction,
            current,
            TransitionSpec {
                status: GenerationJobStatus::ReadyForReview,
                selected_model: Some(image.actual_model.to_owned()),
                next_attempt_at_ms: None,
                asset_id: Some(asset_id),
                error_code: None,
                response_ambiguous: false,
                lease: GenerationJobLeaseUpdate::Clear {
                    lease_epoch: current.lease_epoch(),
                },
                now_ms,
            },
        )?;
        transaction.commit().map_err(|_| save_error())?;
        self.require_job(connection, &current.save_id, &current.job_id)
    }

    fn finish_provider_error(
        &self,
        connection: &Connection,
        current: &VisualJobProjection,
        error: ProviderError,
        sent: bool,
        now_ms: i64,
    ) -> Result<VisualJobProjection, SafeError> {
        if matches!(error, ProviderError::ModelUnavailable)
            && current.resolution == VisualResolution::OneK
            && current.selected_model.as_deref() != Some(FALLBACK_MODEL)
            && current.attempt_count < 3
        {
            let preferences =
                ProviderControlStore::new(self.app_root.clone()).get_preferences(now_ms)?;
            if preferences.allow_automatic_1k_fallback {
                let status = GenerationJobStatus::NeedsPlayerConfirmation;
                transition_on(
                    connection,
                    current,
                    TransitionSpec {
                        status,
                        selected_model: Some(FALLBACK_MODEL.to_owned()),
                        next_attempt_at_ms: None,
                        asset_id: current.asset.as_ref().map(|asset| asset.asset_id.clone()),
                        error_code: Some(provider_error_code(&error).to_owned()),
                        response_ambiguous: false,
                        lease: GenerationJobLeaseUpdate::Clear {
                            lease_epoch: current.lease_epoch(),
                        },
                        now_ms,
                    },
                )?;
                let next = self.require_job(connection, &current.save_id, &current.job_id)?;
                if !preferences.require_send_confirmation {
                    self.issue_grant(&next, FALLBACK_MODEL, "confirmation-disabled", now_ms)?;
                }
                return Ok(next);
            }
        }

        let retry_at = match &error {
            ProviderError::RateLimited {
                retry_after_seconds,
            } => Some(retry_deadline(
                now_ms,
                current.attempt_count,
                retry_after_seconds
                    .and_then(|seconds| i64::try_from(seconds).ok())
                    .and_then(|seconds| seconds.checked_mul(1_000)),
            )?),
            ProviderError::Transient { .. } => {
                Some(retry_deadline(now_ms, current.attempt_count, None)?)
            }
            _ => None,
        };
        let (status, ambiguous) = match error {
            ProviderError::NetworkUnavailable if sent => {
                (GenerationJobStatus::NeedsRetryConfirmation, true)
            }
            ProviderError::NetworkUnavailable => (GenerationJobStatus::WaitingNetwork, false),
            ProviderError::NeedsRetryConfirmation => {
                (GenerationJobStatus::NeedsRetryConfirmation, true)
            }
            ProviderError::RateLimited { .. } | ProviderError::Transient { .. }
                if current.attempt_count < 3 =>
            {
                (GenerationJobStatus::RetryDelay, false)
            }
            ProviderError::RateLimited { .. } | ProviderError::Transient { .. } => {
                (GenerationJobStatus::FailedTerminal, false)
            }
            ProviderError::ModelUnavailable => {
                (GenerationJobStatus::NeedsPlayerConfirmation, false)
            }
            _ => (GenerationJobStatus::FailedTerminal, false),
        };
        transition_on(
            connection,
            current,
            TransitionSpec {
                status,
                selected_model: current.selected_model.clone(),
                next_attempt_at_ms: if status == GenerationJobStatus::RetryDelay {
                    retry_at
                } else {
                    None
                },
                asset_id: current.asset.as_ref().map(|asset| asset.asset_id.clone()),
                error_code: Some(provider_error_code(&error).to_owned()),
                response_ambiguous: ambiguous,
                lease: GenerationJobLeaseUpdate::Clear {
                    lease_epoch: current.lease_epoch(),
                },
                now_ms,
            },
        )?;
        self.require_job(connection, &current.save_id, &current.job_id)
    }
}

trait TokenSource {
    fn token(&self) -> Result<Option<RuntimeToken>, SafeError>;
}

struct RuntimeToken(String);
impl RuntimeToken {
    fn as_str(&self) -> &str {
        &self.0
    }
}
impl Drop for RuntimeToken {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.0.zeroize();
    }
}

impl TokenSource for PlatformKeychainService {
    fn token(&self) -> Result<Option<RuntimeToken>, SafeError> {
        Ok(self
            .read_token_for_native_provider()?
            .map(|token| RuntimeToken(token.expose_for_native_provider().to_owned())))
    }
}

trait ProviderBackend {
    fn check_health(&self, token: &str) -> Result<(), ProviderError>;
    fn generate_primary(
        &self,
        token: &str,
        request: &GenerateImageRequest,
    ) -> Result<GeneratedImage, ProviderError>;
    fn generate_fallback(
        &self,
        token: &str,
        request: &GenerateImageRequest,
    ) -> Result<GeneratedImage, ProviderError>;
}

impl ProviderBackend for ApiNebulaProvider {
    fn check_health(&self, token: &str) -> Result<(), ProviderError> {
        ApiNebulaProvider::check_health(self, token).map(|_| ())
    }
    fn generate_primary(
        &self,
        token: &str,
        request: &GenerateImageRequest,
    ) -> Result<GeneratedImage, ProviderError> {
        ApiNebulaProvider::generate_primary(self, token, request)
    }
    fn generate_fallback(
        &self,
        token: &str,
        request: &GenerateImageRequest,
    ) -> Result<GeneratedImage, ProviderError> {
        ApiNebulaProvider::generate_compatible_1k_fallback(
            self,
            token,
            request,
            PrimaryUnavailableReason::ModelMissing,
        )
    }
}

impl VisualJobProjection {
    // `transition_on` replaces this placeholder with the authoritative epoch
    // read under the same save lock immediately before the CAS.
    fn lease_epoch(&self) -> i64 {
        0
    }
}

struct TransitionSpec {
    status: GenerationJobStatus,
    selected_model: Option<String>,
    next_attempt_at_ms: Option<i64>,
    asset_id: Option<String>,
    error_code: Option<String>,
    response_ambiguous: bool,
    lease: GenerationJobLeaseUpdate,
    now_ms: i64,
}

fn retry_deadline(
    now_ms: i64,
    attempt_count: i64,
    provider_delay_ms: Option<i64>,
) -> Result<i64, SafeError> {
    let index = usize::try_from(attempt_count.saturating_sub(1))
        .unwrap_or(usize::MAX)
        .min(RETRY_BACKOFF_MS.len() - 1);
    let delay = RETRY_BACKOFF_MS[index]
        .max(provider_delay_ms.unwrap_or(0))
        .min(MAX_RETRY_DELAY_MS);
    now_ms.checked_add(delay).ok_or_else(invalid_transition)
}

fn observe_wall_clock(connection: &Connection, now_ms: i64) -> Result<i64, SafeError> {
    if now_ms < 0 {
        return Err(invalid_transition());
    }
    connection
        .execute(
            "UPDATE runtime_session
             SET last_observed_wall_ms=MAX(last_observed_wall_ms,?1),
                 updated_at_ms=MAX(updated_at_ms,?1)
             WHERE singleton=1",
            [now_ms],
        )
        .map_err(|_| save_error())?;
    connection
        .query_row(
            "SELECT last_observed_wall_ms FROM runtime_session WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .map_err(|_| save_error())
}

fn recover_expired_leases(
    connection: &Connection,
    save_id: &str,
    now_ms: i64,
) -> Result<(), SafeError> {
    let mut statement = connection
        .prepare(
            "SELECT job_id,job_revision,status,request_fingerprint,selected_model,
                    lease_epoch,asset_id
             FROM generation_jobs
             WHERE save_id=?1
               AND status IN ('checking-model','running-primary','running-fallback','staging-asset')
               AND lease_until_ms<=?2
             ORDER BY job_id",
        )
        .map_err(|_| save_error())?;
    let expired = statement
        .query_map(params![save_id, now_ms], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        })
        .map_err(|_| save_error())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| save_error())?;
    drop(statement);

    for (job_id, revision, status, fingerprint, model, lease_epoch, asset_id) in expired {
        let _status = GenerationJobStatus::try_from(status.as_str())?;
        let next_epoch = lease_epoch.checked_add(1).ok_or_else(invalid_transition)?;
        // Lease expiry is a recovery edge, not a player/worker state-machine
        // edge. All active states fail closed into explicit confirmation.
        connection
            .execute(
                "UPDATE generation_jobs
                 SET job_revision=job_revision+1,
                     status='needs-retry-confirmation',
                     selected_model=?1,next_attempt_at_ms=NULL,
                     lease_owner=NULL,lease_until_ms=NULL,lease_epoch=?2,
                     asset_id=?3,error_code='provider.confirmation-required',
                     response_ambiguous=1,updated_at_ms=?4
                 WHERE save_id=?5 AND job_id=?6 AND job_revision=?7
                   AND status=?8 AND request_fingerprint=?9 AND lease_epoch=?10
                   AND lease_until_ms<=?4",
                params![
                    model,
                    next_epoch,
                    asset_id,
                    now_ms,
                    save_id,
                    job_id,
                    revision,
                    status,
                    fingerprint,
                    lease_epoch
                ],
            )
            .map_err(|_| save_error())?;
    }
    Ok(())
}

fn transition_on(
    connection: &Connection,
    current: &VisualJobProjection,
    spec: TransitionSpec,
) -> Result<GenerationJobTransitionProjection, SafeError> {
    let lease_epoch: i64 = connection
        .query_row(
            "SELECT lease_epoch FROM generation_jobs WHERE save_id=?1 AND job_id=?2",
            params![current.save_id, current.job_id],
            |row| row.get(0),
        )
        .map_err(|_| save_error())?;
    let lease = match spec.lease {
        GenerationJobLeaseUpdate::Clear { .. } => GenerationJobLeaseUpdate::Clear { lease_epoch },
        GenerationJobLeaseUpdate::Hold {
            lease_owner,
            lease_until_ms,
            ..
        } => GenerationJobLeaseUpdate::Hold {
            lease_owner,
            lease_until_ms,
            lease_epoch: lease_epoch.checked_add(1).ok_or_else(invalid_transition)?,
        },
    };
    let request = GenerationJobTransitionRequest {
        job_id: current.job_id.clone(),
        save_id: current.save_id.clone(),
        expected_revision: current.job_revision,
        expected_status: current.status,
        expected_request_fingerprint: current.request_fingerprint.clone(),
        expected_lease_epoch: lease_epoch,
        next: GenerationJobNextState {
            status: spec.status,
            selected_model: spec.selected_model,
            next_attempt_at_ms: spec.next_attempt_at_ms,
            lease,
            asset_id: spec.asset_id,
            error_code: spec.error_code,
            response_ambiguous: spec.response_ambiguous,
        },
        updated_at_ms: spec.now_ms,
    };
    match connection.compare_and_set_generation_job(&request)? {
        GenerationJobTransitionResult::Applied { job } => Ok(*job),
        GenerationJobTransitionResult::CompareAndSetMiss => Err(job_stale()),
    }
}

fn read_job(
    connection: &Connection,
    save_id: &str,
    job_id: &str,
) -> Result<Option<VisualJobProjection>, SafeError> {
    let raw = connection.query_row(
        "SELECT job_id,save_id,job_revision,status,target_kind,target_fingerprint,request_fingerprint,
                json_extract(request_json,'$.resolution'),selected_model,next_attempt_at_ms,asset_id,
                error_code,response_ambiguous,created_at_ms,updated_at_ms
         FROM generation_jobs WHERE save_id=?1 AND job_id=?2",
        params![save_id,job_id],
        |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,i64>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?,row.get::<_,String>(6)?,row.get::<_,String>(7)?,row.get::<_,Option<String>>(8)?,row.get::<_,Option<i64>>(9)?,row.get::<_,Option<String>>(10)?,row.get::<_,Option<String>>(11)?,row.get::<_,bool>(12)?,row.get::<_,i64>(13)?,row.get::<_,i64>(14)?)),
    ).optional().map_err(|_| save_error())?;
    let Some((
        job_id,
        save_id,
        job_revision,
        status,
        target_kind,
        target_fingerprint,
        request_fingerprint,
        resolution,
        selected_model,
        next_attempt_at_ms,
        asset_id,
        error_code,
        response_ambiguous,
        created_at_ms,
        updated_at_ms,
    )) = raw
    else {
        return Ok(None);
    };
    let status = GenerationJobStatus::try_from(status.as_str())?;
    let target_kind = match target_kind.as_str() {
        "master" => VisualTargetKind::Master,
        "focus" => VisualTargetKind::Focus,
        _ => return Err(save_error()),
    };
    let resolution = match resolution.as_str() {
        "1k" => VisualResolution::OneK,
        "2k" => VisualResolution::TwoK,
        "4k" => VisualResolution::FourK,
        _ => return Err(save_error()),
    };
    let asset = asset_id.as_ref().map(|id| connection.query_row("SELECT asset_id,mime_type,byte_length,width,height,sha256 FROM assets WHERE asset_id=?1", [id], |row| Ok(AssetProjection { asset_id: row.get(0)?, mime_type: row.get(1)?, byte_length: row.get(2)?, width: row.get(3)?, height: row.get(4)?, sha256: row.get(5)?, resolver_url: format!("cloudinn-asset://{id}") })).map_err(|_| save_error())).transpose()?;
    Ok(Some(VisualJobProjection {
        job_id,
        save_id,
        job_revision,
        status,
        target_kind,
        target_fingerprint,
        request_fingerprint,
        resolution,
        selected_model,
        attempt_count: 0,
        next_attempt_at_ms,
        asset,
        error_code,
        response_ambiguous,
        created_at_ms,
        updated_at_ms,
    }))
}

fn apply_adopted_visual(
    transaction: &Transaction<'_>,
    job: &VisualJobProjection,
    asset_id: &str,
) -> Result<(), SafeError> {
    let resolver_url = format!("cloudinn-asset://{asset_id}");
    let mut applied = false;

    if job.target_kind == VisualTargetKind::Master {
        let visual_json = serde_json::to_string(&json!({
            "status": "ready",
            "assetPath": resolver_url.clone(),
        }))
        .map_err(|_| save_error())?;
        let changed = transaction
            .execute(
                "UPDATE room_blueprints SET visual_json=?1 WHERE save_id=?2",
                params![visual_json, job.save_id],
            )
            .map_err(|_| save_error())?;
        applied |= changed > 0;
    }

    let phase2_json: Option<String> = transaction
        .query_row(
            "SELECT phase2_json FROM saves WHERE save_id=?1",
            [&job.save_id],
            |row| row.get(0),
        )
        .map_err(|_| save_error())?;
    if let Some(phase2_json) = phase2_json {
        let mut phase2: Value = serde_json::from_str(&phase2_json).map_err(|_| save_error())?;
        let object = phase2.as_object_mut().ok_or_else(save_error)?;
        let visuals = object
            .entry("designVisuals")
            .or_insert_with(|| json!({ "status": "complete", "assets": [], "errors": [] }));
        let visuals = visuals.as_object_mut().ok_or_else(save_error)?;
        visuals.insert("status".to_owned(), Value::String("complete".to_owned()));
        let request = match job.target_kind {
            VisualTargetKind::Master => json!({ "kind": "master" }),
            // The frozen IPC request intentionally contains no separate focus
            // label. The target fingerprint is therefore the only stable,
            // non-path identity available for a focus result.
            VisualTargetKind::Focus => {
                json!({ "kind": "focus", "focus": job.target_fingerprint })
            }
        };
        let asset_count = {
            let assets = visuals
                .entry("assets")
                .or_insert_with(|| Value::Array(Vec::new()))
                .as_array_mut()
                .ok_or_else(save_error)?;
            assets.retain(|entry| entry.get("request") != Some(&request));
            assets.push(json!({ "request": request.clone(), "assetPath": resolver_url.clone() }));
            assets.len()
        };
        let errors = visuals
            .entry("errors")
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or_else(save_error)?;
        errors.retain(|entry| entry.get("request") != Some(&request));
        if asset_count + errors.len() > 4 {
            return Err(invalid_transition());
        }
        let updated = serde_json::to_string(&phase2).map_err(|_| save_error())?;
        transaction
            .execute(
                "UPDATE saves SET phase2_json=?1 WHERE save_id=?2",
                params![updated, job.save_id],
            )
            .map_err(|_| save_error())?;
        applied = true;
    }

    if !applied {
        return Err(SafeError::new(
            "provider.invalid-transition",
            "当前设计目标无法采用图片",
        ));
    }
    Ok(())
}

fn validate_request(
    request: &VisualJobRequest,
    target_fingerprint: &str,
    now_ms: i64,
) -> Result<(), SafeError> {
    if now_ms < 0
        || target_fingerprint.is_empty()
        || target_fingerprint.len() > 256
        || request.prompt.is_empty()
        || request.prompt.chars().count() > MAX_PROMPT_CHARS
        || request.reference_asset_ids.len() > MAX_REFERENCES
        || request
            .reference_asset_ids
            .iter()
            .any(|id| id.is_empty() || id.len() > 128)
    {
        return Err(invalid_request());
    }
    Ok(())
}

fn require_revision(job: &VisualJobProjection, expected: i64) -> Result<(), SafeError> {
    if expected == job.job_revision {
        Ok(())
    } else {
        Err(job_stale())
    }
}
fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn current_time_ms() -> Result<i64, SafeError> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| invalid_transition())?
        .as_millis()
        .try_into()
        .map_err(|_| invalid_transition())
}
fn provider_error_code(error: &ProviderError) -> &'static str {
    match error {
        ProviderError::InvalidRequest => "provider.invalid-request",
        ProviderError::Authentication => "provider.authentication-failed",
        ProviderError::SafetyRejected => "provider.safety-rejected",
        ProviderError::ModelUnavailable => "provider.model-unavailable",
        ProviderError::NetworkUnavailable => "network.unavailable",
        ProviderError::NeedsRetryConfirmation => "provider.confirmation-required",
        ProviderError::RateLimited { .. } => "network.rate-limited",
        ProviderError::Transient { .. } => "network.unavailable",
        ProviderError::OriginRedirect
        | ProviderError::MalformedResponse
        | ProviderError::ResponseTooLarge => "provider.malformed-response",
    }
}
fn invalid_request() -> SafeError {
    SafeError::new("provider.invalid-request", "图片请求无效")
}
fn invalid_transition() -> SafeError {
    SafeError::new("provider.invalid-transition", "图片任务状态不允许此操作")
}
fn job_not_found() -> SafeError {
    SafeError::new("provider.job-not-found", "图片任务不存在")
}
fn job_stale() -> SafeError {
    SafeError::new("provider.job-stale", "图片任务已更新，请重新加载")
}
fn stale_save() -> SafeError {
    SafeError::new("save.conflict", "存档已更新，请重新加载")
}
fn save_error() -> SafeError {
    SafeError::new("save.corrupt", "图片任务记录无效")
}
fn control_error() -> SafeError {
    SafeError::new(
        "provider.control-invalid",
        "图片服务计费控制记录无效或不可用",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::Duration;

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "cloud-inn-visual-runtime-{label}-{}",
                Uuid::new_v4()
            ));
            fs::create_dir_all(&path).expect("create test root");
            Self(path)
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    struct FakeTokens(Option<String>);

    impl TokenSource for FakeTokens {
        fn token(&self) -> Result<Option<RuntimeToken>, SafeError> {
            Ok(self.0.clone().map(RuntimeToken))
        }
    }

    struct FakeProvider {
        health_calls: AtomicUsize,
        generation_calls: AtomicUsize,
        outcome: Result<(), ProviderError>,
        primary_error: Option<ProviderError>,
        fallback_error: Option<ProviderError>,
    }

    impl FakeProvider {
        fn successful() -> Self {
            Self {
                health_calls: AtomicUsize::new(0),
                generation_calls: AtomicUsize::new(0),
                outcome: Ok(()),
                primary_error: None,
                fallback_error: None,
            }
        }

        fn with_health_error(error: ProviderError) -> Self {
            Self {
                outcome: Err(error),
                ..Self::successful()
            }
        }

        fn with_primary_error(error: ProviderError) -> Self {
            Self {
                primary_error: Some(error),
                ..Self::successful()
            }
        }

        fn with_fallback_error(error: ProviderError) -> Self {
            Self {
                fallback_error: Some(error),
                ..Self::successful()
            }
        }
    }

    impl ProviderBackend for FakeProvider {
        fn check_health(&self, _token: &str) -> Result<(), ProviderError> {
            self.health_calls.fetch_add(1, Ordering::SeqCst);
            self.outcome.clone()
        }

        fn generate_primary(
            &self,
            _token: &str,
            _request: &GenerateImageRequest,
        ) -> Result<GeneratedImage, ProviderError> {
            self.generation_calls.fetch_add(1, Ordering::SeqCst);
            if let Some(error) = &self.primary_error {
                return Err(error.clone());
            }
            Ok(test_image(PRIMARY_MODEL))
        }

        fn generate_fallback(
            &self,
            _token: &str,
            _request: &GenerateImageRequest,
        ) -> Result<GeneratedImage, ProviderError> {
            self.generation_calls.fetch_add(1, Ordering::SeqCst);
            if let Some(error) = &self.fallback_error {
                return Err(error.clone());
            }
            Ok(test_image(FALLBACK_MODEL))
        }
    }

    struct BlockingProvider {
        entered: Mutex<Option<mpsc::Sender<()>>>,
        release: Mutex<mpsc::Receiver<()>>,
    }

    impl ProviderBackend for BlockingProvider {
        fn check_health(&self, _token: &str) -> Result<(), ProviderError> {
            if let Some(sender) = self.entered.lock().unwrap().take() {
                sender.send(()).unwrap();
            }
            self.release.lock().unwrap().recv().unwrap();
            Ok(())
        }

        fn generate_primary(
            &self,
            _token: &str,
            _request: &GenerateImageRequest,
        ) -> Result<GeneratedImage, ProviderError> {
            Ok(test_image(PRIMARY_MODEL))
        }

        fn generate_fallback(
            &self,
            _token: &str,
            _request: &GenerateImageRequest,
        ) -> Result<GeneratedImage, ProviderError> {
            Ok(test_image(FALLBACK_MODEL))
        }
    }

    fn test_image(model: &'static str) -> GeneratedImage {
        let mut bytes = vec![137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13];
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&1_u32.to_be_bytes());
        bytes.extend_from_slice(&1_u32.to_be_bytes());
        GeneratedImage {
            mime_type: "image/png".to_owned(),
            bytes,
            width: 1,
            height: 1,
            actual_model: model,
        }
    }

    fn setup(label: &str) -> (TestRoot, VisualRuntimeService, String) {
        let root = TestRoot::new(label);
        let repository = SaveRepository::new(root.0.clone());
        repository
            .create_save(Some("测试酒店".to_owned()))
            .expect("create save");
        let saves = fs::read_dir(root.0.join("saves"))
            .expect("list saves")
            .collect::<Result<Vec<_>, _>>()
            .expect("save entries");
        assert_eq!(saves.len(), 1);
        let save_id = saves[0].file_name().to_string_lossy().into_owned();
        let service = VisualRuntimeService::new(root.0.clone());
        (root, service, save_id)
    }

    fn request() -> VisualJobRequest {
        VisualJobRequest {
            target_kind: VisualTargetKind::Master,
            prompt: "A quiet cloud inn".to_owned(),
            resolution: VisualResolution::OneK,
            reference_asset_ids: Vec::new(),
        }
    }

    fn serialized_code(error: &SafeError) -> String {
        serde_json::to_value(error)
            .expect("serialize safe error")
            .get("code")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned()
    }

    #[test]
    fn enqueue_and_list_are_durable_and_never_call_a_provider() {
        let (_root, service, save_id) = setup("enqueue");
        let job = service
            .enqueue_visual_job(&save_id, request(), 0, &"a".repeat(64), 10)
            .expect("enqueue");

        assert_eq!(job.status, GenerationJobStatus::Queued);
        assert_eq!(job.attempt_count, 0);
        assert_eq!(job.job_revision, 0);
        assert_eq!(job.request_fingerprint.len(), 64);
        assert_eq!(service.list_visual_jobs(&save_id).unwrap(), vec![job]);
    }

    #[test]
    fn manual_confirmation_runs_one_mock_attempt_and_publishes_a_verified_asset() {
        let (root, service, save_id) = setup("run-success");
        let queued = service
            .enqueue_visual_job(&save_id, request(), 0, &"a".repeat(64), 10)
            .unwrap();
        let confirmed = service
            .confirm_visual_send(&save_id, &queued.job_id, 0, 11)
            .unwrap();
        assert_eq!(confirmed.job_revision, 1);

        let provider = FakeProvider::successful();
        let ready = service
            .run_one_with(
                &save_id,
                &queued.job_id,
                &FakeTokens(Some("native-only-token".to_owned())),
                &provider,
                12,
            )
            .expect("run one");

        assert_eq!(ready.status, GenerationJobStatus::ReadyForReview);
        assert_eq!(ready.attempt_count, 1);
        assert_eq!(ready.selected_model.as_deref(), Some(PRIMARY_MODEL));
        let asset = ready.asset.expect("asset projection");
        assert_eq!(
            asset.resolver_url,
            format!("cloudinn-asset://{}", asset.asset_id)
        );
        assert!(root.0.join("saves").join(&save_id).join("assets").exists());
        assert_eq!(provider.health_calls.load(Ordering::SeqCst), 1);
        assert_eq!(provider.generation_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn missing_credential_blocks_before_grant_or_provider_io() {
        let (_root, service, save_id) = setup("missing-token");
        let queued = service
            .enqueue_visual_job(&save_id, request(), 0, &"a".repeat(64), 10)
            .unwrap();
        let provider = FakeProvider::successful();

        let blocked = service
            .run_one_with(&save_id, &queued.job_id, &FakeTokens(None), &provider, 11)
            .unwrap();

        assert_eq!(blocked.status, GenerationJobStatus::BlockedNoCredential);
        assert_eq!(blocked.error_code.as_deref(), Some("keychain.missing"));
        assert_eq!(blocked.attempt_count, 0);
        assert_eq!(provider.health_calls.load(Ordering::SeqCst), 0);
        assert_eq!(provider.generation_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn crash_before_send_reuses_the_same_reserved_attempt() {
        let (_root, service, save_id) = setup("reuse-reservation");
        let queued = service
            .enqueue_visual_job(&save_id, request(), 0, &"a".repeat(64), 10)
            .unwrap();
        let confirmed = service
            .confirm_visual_send(&save_id, &queued.job_id, 0, 11)
            .unwrap();
        let reserved = service
            .consume_grant_and_reserve(&confirmed, PRIMARY_MODEL, 12)
            .unwrap();

        let ready = service
            .run_one_with(
                &save_id,
                &queued.job_id,
                &FakeTokens(Some("token".to_owned())),
                &FakeProvider::successful(),
                13,
            )
            .unwrap();

        assert_eq!(ready.status, GenerationJobStatus::ReadyForReview);
        assert_eq!(ready.attempt_count, 1);
        let control = ProviderControlStore::new(service.app_root.clone())
            .open_validated()
            .unwrap();
        let persisted: (String, i64) = control
            .query_row(
                "SELECT attempt_id,sequence FROM provider_attempts",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(persisted, reserved);
    }

    #[test]
    fn expired_active_lease_requires_confirmation_and_preserves_reserved_attempt() {
        let (root, service, save_id) = setup("expired-active-lease");
        let queued = service
            .enqueue_visual_job(&save_id, request(), 0, &"a".repeat(64), 10)
            .unwrap();
        let confirmed = service
            .confirm_visual_send(&save_id, &queued.job_id, 0, 11)
            .unwrap();
        let reserved = service
            .consume_grant_and_reserve(&confirmed, PRIMARY_MODEL, 12)
            .unwrap();
        let (prepared, connection) = service.open_save(&save_id).unwrap();
        let checking = service
            .hold_transition(
                &connection,
                &confirmed,
                GenerationJobStatus::CheckingModel,
                Some(PRIMARY_MODEL.to_owned()),
                100,
            )
            .unwrap();
        drop(connection);
        drop(prepared);

        let before_expiry = service
            .recover_expired_visual_jobs(&save_id, 100 + LEASE_MS - 1)
            .unwrap();
        assert_eq!(before_expiry[0].status, GenerationJobStatus::CheckingModel);
        assert_eq!(before_expiry[0].job_revision, checking.job_revision);

        let recovered = service
            .recover_expired_visual_jobs(&save_id, 100 + LEASE_MS)
            .unwrap();
        assert_eq!(
            recovered[0].status,
            GenerationJobStatus::NeedsRetryConfirmation
        );
        assert!(recovered[0].response_ambiguous);
        assert_eq!(recovered[0].job_revision, checking.job_revision + 1);
        assert_eq!(recovered[0].attempt_count, 1);
        let control = ProviderControlStore::new(root.0.clone())
            .open_validated()
            .unwrap();
        let persisted: (String, String) = control
            .query_row(
                "SELECT attempt_id,state FROM provider_attempts",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(persisted, (reserved.0, "reserved".to_owned()));
        let lease_epoch: i64 = Connection::open(service.save_path(&save_id))
            .unwrap()
            .query_row(
                "SELECT lease_epoch FROM generation_jobs WHERE job_id=?1",
                [&queued.job_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(lease_epoch, 2);
    }

    #[test]
    fn retry_supports_offline_retryable_and_ambiguous_confirmation_states() {
        for (label, status) in [
            ("waiting", GenerationJobStatus::WaitingNetwork),
            ("failed", GenerationJobStatus::FailedRetryable),
            ("credential", GenerationJobStatus::BlockedNoCredential),
        ] {
            let (_root, service, save_id) = setup(label);
            let queued = service
                .enqueue_visual_job(&save_id, request(), 0, &"a".repeat(64), 10)
                .unwrap();
            let (prepared, connection) = service.open_save(&save_id).unwrap();
            connection
                .execute(
                    "UPDATE generation_jobs SET status=?1,error_code='network.unavailable' WHERE job_id=?2",
                    params![status.as_str(), queued.job_id],
                )
                .unwrap();
            drop(connection);
            drop(prepared);
            let retried = service
                .retry_visual_job(&save_id, &queued.job_id, 0, 11)
                .unwrap();
            assert_eq!(retried.status, GenerationJobStatus::Queued);
            assert_eq!(retried.error_code, None);
        }

        let (root, service, save_id) = setup("ambiguous");
        let queued = service
            .enqueue_visual_job(&save_id, request(), 0, &"a".repeat(64), 10)
            .unwrap();
        let (prepared, connection) = service.open_save(&save_id).unwrap();
        connection
            .execute(
                "UPDATE generation_jobs
                 SET status='needs-retry-confirmation',selected_model=?1,
                     error_code='network.timeout',response_ambiguous=1
                 WHERE job_id=?2",
                params![PRIMARY_MODEL, queued.job_id],
            )
            .unwrap();
        drop(connection);
        drop(prepared);
        let confirmed = service
            .retry_visual_job(&save_id, &queued.job_id, 0, 11)
            .unwrap();
        assert_eq!(
            confirmed.status,
            GenerationJobStatus::NeedsRetryConfirmation
        );
        assert!(!confirmed.response_ambiguous);
        let control = ProviderControlStore::new(root.0.clone())
            .open_validated()
            .unwrap();
        let issued: i64 = control
            .query_row(
                "SELECT count(*) FROM provider_send_grants
                 WHERE state='issued' AND source='player-confirmed'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(issued, 1);
    }

    #[test]
    fn rate_limit_retry_delay_survives_restart_sleep_and_clock_rollback() {
        let (root, service, save_id) = setup("durable-retry-delay");
        let queued = service
            .enqueue_visual_job(&save_id, request(), 0, &"a".repeat(64), 10)
            .unwrap();
        let confirmed = service
            .confirm_visual_send(&save_id, &queued.job_id, queued.job_revision, 20)
            .unwrap();
        service
            .recover_expired_visual_jobs(&save_id, 10_000)
            .unwrap();
        let delayed = service
            .run_one_with(
                &save_id,
                &queued.job_id,
                &FakeTokens(Some("token".to_owned())),
                &FakeProvider::with_primary_error(ProviderError::RateLimited {
                    retry_after_seconds: Some(20),
                }),
                1_000,
            )
            .unwrap();
        assert_eq!(delayed.status, GenerationJobStatus::RetryDelay);
        assert_eq!(delayed.next_attempt_at_ms, Some(30_000));
        assert_eq!(delayed.attempt_count, 1);
        assert!(!delayed.response_ambiguous);

        let restarted = VisualRuntimeService::new(root.0.clone());
        let before_due = restarted
            .recover_expired_visual_jobs(&save_id, 29_999)
            .unwrap();
        assert_eq!(before_due[0].status, GenerationJobStatus::RetryDelay);
        // Rolling the wall clock backwards cannot make the delay elapse or
        // erase the previously observed floor.
        let rolled_back = restarted
            .recover_expired_visual_jobs(&save_id, 500)
            .unwrap();
        assert_eq!(rolled_back[0].status, GenerationJobStatus::RetryDelay);
        assert_eq!(rolled_back[0].next_attempt_at_ms, Some(30_000));

        let due = restarted
            .recover_expired_visual_jobs(&save_id, 30_000)
            .unwrap();
        assert_eq!(due[0].status, GenerationJobStatus::FailedRetryable);
        assert_eq!(due[0].next_attempt_at_ms, None);
        assert_eq!(due[0].attempt_count, 1);
        let control = ProviderControlStore::new(root.0.clone())
            .open_validated()
            .unwrap();
        assert_eq!(
            control
                .query_row("SELECT count(*) FROM provider_attempts", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
        assert_eq!(
            control
                .query_row(
                    "SELECT count(*) FROM provider_send_grants WHERE state='issued'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0,
            "becoming due must not authorize another paid call"
        );
        assert!(confirmed.job_revision < due[0].job_revision);
    }

    #[test]
    fn fallback_route_is_preserved_across_delay_and_requires_a_new_exact_grant() {
        let (root, service, save_id) = setup("fallback-retry-route");
        let queued = service
            .enqueue_visual_job(&save_id, request(), 0, &"a".repeat(64), 10)
            .unwrap();
        let (prepared, connection) = service.open_save(&save_id).unwrap();
        connection
            .execute(
                "UPDATE generation_jobs SET status='needs-player-confirmation'
                 WHERE job_id=?1",
                [&queued.job_id],
            )
            .unwrap();
        drop(connection);
        drop(prepared);
        let fallback = service
            .choose_visual_fallback(
                &save_id,
                &queued.job_id,
                0,
                FallbackChoice::CompatibleOneK,
                20,
            )
            .unwrap();
        assert_eq!(fallback.selected_model.as_deref(), Some(FALLBACK_MODEL));

        let delayed = service
            .run_one_with(
                &save_id,
                &queued.job_id,
                &FakeTokens(Some("token".to_owned())),
                &FakeProvider::with_fallback_error(ProviderError::Transient { status: 503 }),
                1_000,
            )
            .unwrap();
        assert_eq!(delayed.status, GenerationJobStatus::RetryDelay);
        assert_eq!(delayed.selected_model.as_deref(), Some(FALLBACK_MODEL));
        assert_eq!(delayed.next_attempt_at_ms, Some(6_000));

        let restarted = VisualRuntimeService::new(root.0.clone());
        let due = restarted
            .recover_expired_visual_jobs(&save_id, 6_000)
            .unwrap()
            .remove(0);
        assert_eq!(due.status, GenerationJobStatus::FailedRetryable);
        assert_eq!(due.selected_model.as_deref(), Some(FALLBACK_MODEL));
        let queued_again = restarted
            .retry_visual_job(&save_id, &queued.job_id, due.job_revision, 6_001)
            .unwrap();
        assert_eq!(queued_again.status, GenerationJobStatus::Queued);
        assert_eq!(queued_again.selected_model.as_deref(), Some(FALLBACK_MODEL));

        // Confirmation is still enabled by default, so retrying cannot create
        // a second paid attempt until the player grants this exact revision.
        let needs_confirmation = restarted
            .run_one_with(
                &save_id,
                &queued.job_id,
                &FakeTokens(Some("token".to_owned())),
                &FakeProvider::successful(),
                6_002,
            )
            .unwrap();
        assert_eq!(
            needs_confirmation.status,
            GenerationJobStatus::NeedsPlayerConfirmation
        );
        assert_eq!(needs_confirmation.attempt_count, 1);
        assert_eq!(
            needs_confirmation.selected_model.as_deref(),
            Some(FALLBACK_MODEL)
        );
        let confirmed = restarted
            .confirm_visual_send(
                &save_id,
                &queued.job_id,
                needs_confirmation.job_revision,
                6_003,
            )
            .unwrap();
        let ready = restarted
            .run_one_with(
                &save_id,
                &queued.job_id,
                &FakeTokens(Some("token".to_owned())),
                &FakeProvider::successful(),
                6_004,
            )
            .unwrap();
        assert_eq!(ready.status, GenerationJobStatus::ReadyForReview);
        assert_eq!(ready.selected_model.as_deref(), Some(FALLBACK_MODEL));
        assert_eq!(ready.attempt_count, 2);
        assert!(confirmed.job_revision < ready.job_revision);
    }

    #[test]
    fn automatic_fallback_requires_opt_in_one_k_and_one_exact_policy_grant() {
        let (root, service, save_id) = setup("automatic-fallback");
        let store = ProviderControlStore::new(root.0.clone());
        let preferences = store.get_preferences(0).unwrap();
        store
            .update_preferences(
                preferences.preferences_revision,
                crate::provider_control::WritableProviderPreferences {
                    daily_request_ceiling: 10,
                    require_send_confirmation: false,
                    allow_automatic_1k_fallback: true,
                },
                1,
            )
            .unwrap();
        let queued = service
            .enqueue_visual_job(&save_id, request(), 0, &"a".repeat(64), 10)
            .unwrap();
        let selected = service
            .run_one_with(
                &save_id,
                &queued.job_id,
                &FakeTokens(Some("token".to_owned())),
                &FakeProvider::with_health_error(ProviderError::ModelUnavailable),
                20,
            )
            .unwrap();
        assert_eq!(
            selected.status,
            GenerationJobStatus::NeedsPlayerConfirmation
        );
        assert_eq!(selected.selected_model.as_deref(), Some(FALLBACK_MODEL));
        assert!(service.automatic_followup_ready(&selected, 20).unwrap());
        let control = store.open_validated().unwrap();
        let issued: (i64, String, i64) = control
            .query_row(
                "SELECT count(*),model,job_revision FROM provider_send_grants
                 WHERE state='issued'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(issued.0, 1);
        assert_eq!(issued.1, FALLBACK_MODEL);
        assert_eq!(issued.2, selected.job_revision);
        drop(control);

        let ready = service
            .run_one_with(
                &save_id,
                &queued.job_id,
                &FakeTokens(Some("token".to_owned())),
                &FakeProvider::successful(),
                21,
            )
            .unwrap();
        assert_eq!(ready.status, GenerationJobStatus::ReadyForReview);
        assert_eq!(ready.selected_model.as_deref(), Some(FALLBACK_MODEL));
        assert_eq!(ready.attempt_count, 2);

        for (label, allow, resolution) in [
            ("not-opted-in", false, VisualResolution::OneK),
            ("incompatible-resolution", true, VisualResolution::TwoK),
        ] {
            let (root, service, save_id) = setup(label);
            let store = ProviderControlStore::new(root.0.clone());
            let preferences = store.get_preferences(0).unwrap();
            store
                .update_preferences(
                    preferences.preferences_revision,
                    crate::provider_control::WritableProviderPreferences {
                        daily_request_ceiling: 10,
                        require_send_confirmation: false,
                        allow_automatic_1k_fallback: allow,
                    },
                    1,
                )
                .unwrap();
            let mut request = request();
            request.resolution = resolution;
            let queued = service
                .enqueue_visual_job(&save_id, request, 0, &"a".repeat(64), 10)
                .unwrap();
            let result = service
                .run_one_with(
                    &save_id,
                    &queued.job_id,
                    &FakeTokens(Some("token".to_owned())),
                    &FakeProvider::with_health_error(ProviderError::ModelUnavailable),
                    20,
                )
                .unwrap();
            assert_eq!(result.selected_model.as_deref(), Some(PRIMARY_MODEL));
            assert!(!service.automatic_followup_ready(&result, 20).unwrap());
        }
    }

    #[test]
    fn retry_backoff_is_bounded() {
        assert_eq!(retry_deadline(100, 1, None).unwrap(), 5_100);
        assert_eq!(retry_deadline(100, 2, None).unwrap(), 30_100);
        assert_eq!(retry_deadline(100, 3, None).unwrap(), 120_100);
        assert_eq!(
            retry_deadline(100, 1, Some(MAX_RETRY_DELAY_MS * 2)).unwrap(),
            100 + MAX_RETRY_DELAY_MS
        );
    }

    #[test]
    fn third_transient_attempt_is_terminal_and_never_schedules_a_fourth() {
        let (_root, service, save_id) = setup("three-attempt-cap");
        let queued = service
            .enqueue_visual_job(&save_id, request(), 0, &"a".repeat(64), 10)
            .unwrap();
        let mut current = queued;
        let mut now_ms = 100;
        for attempt in 1..=3 {
            if current.status == GenerationJobStatus::FailedRetryable {
                current = service
                    .retry_visual_job(&save_id, &current.job_id, current.job_revision, now_ms)
                    .unwrap();
                now_ms += 1;
            }
            if current.status == GenerationJobStatus::Queued {
                current = service
                    .run_one_with(
                        &save_id,
                        &current.job_id,
                        &FakeTokens(Some("token".to_owned())),
                        &FakeProvider::successful(),
                        now_ms,
                    )
                    .unwrap();
                assert_eq!(current.status, GenerationJobStatus::NeedsPlayerConfirmation);
                now_ms += 1;
            }
            current = service
                .confirm_visual_send(&save_id, &current.job_id, current.job_revision, now_ms)
                .unwrap();
            now_ms += 1;
            current = service
                .run_one_with(
                    &save_id,
                    &current.job_id,
                    &FakeTokens(Some("token".to_owned())),
                    &FakeProvider::with_primary_error(ProviderError::Transient { status: 503 }),
                    now_ms,
                )
                .unwrap();
            assert_eq!(current.attempt_count, attempt);
            if attempt < 3 {
                assert_eq!(current.status, GenerationJobStatus::RetryDelay);
                now_ms = current.next_attempt_at_ms.unwrap();
                current = service
                    .recover_expired_visual_jobs(&save_id, now_ms)
                    .unwrap()
                    .remove(0);
                assert_eq!(current.status, GenerationJobStatus::FailedRetryable);
                now_ms += 1;
            }
        }
        assert_eq!(current.status, GenerationJobStatus::FailedTerminal);
        assert_eq!(current.next_attempt_at_ms, None);
        assert_eq!(current.attempt_count, 3);
        let error = service
            .retry_visual_job(&save_id, &current.job_id, current.job_revision, now_ms + 1)
            .unwrap_err();
        assert_eq!(serialized_code(&error), "provider.invalid-transition");
    }

    #[test]
    fn provider_wait_does_not_hold_the_save_lock_or_block_a_game_commit() {
        let (root, service, save_id) = setup("provider-does-not-block-save");
        let queued = service
            .enqueue_visual_job(&save_id, request(), 0, &"a".repeat(64), 10)
            .unwrap();
        service
            .confirm_visual_send(&save_id, &queued.job_id, 0, 11)
            .unwrap();
        let repository = SaveRepository::new(root.0.clone());
        let mut next = repository
            .load_game(&save_id)
            .unwrap()
            .expect("game before concurrent commit");
        next["revision"] = json!(1);

        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let provider = Arc::new(BlockingProvider {
            entered: Mutex::new(Some(entered_tx)),
            release: Mutex::new(release_rx),
        });
        let worker_provider = Arc::clone(&provider);
        let worker_root = root.0.clone();
        let worker_save_id = save_id.clone();
        let worker_job_id = queued.job_id.clone();
        let worker = std::thread::spawn(move || {
            VisualRuntimeService::new(worker_root).run_one_with(
                &worker_save_id,
                &worker_job_id,
                &FakeTokens(Some("token".to_owned())),
                worker_provider.as_ref(),
                12,
            )
        });
        entered_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("provider entered without save lock");

        let (commit_tx, commit_rx) = mpsc::channel();
        let commit_root = root.0.clone();
        std::thread::spawn(move || {
            commit_tx
                .send(SaveRepository::new(commit_root).commit_game(0, next))
                .unwrap();
        });
        commit_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("game commit must not wait for provider")
            .expect("concurrent game commit");
        release_tx.send(()).unwrap();
        worker.join().unwrap().expect("worker completion");
    }

    #[test]
    fn cancellation_expires_authorization_and_prevents_manual_run() {
        let (root, service, save_id) = setup("cancel");
        let queued = service
            .enqueue_visual_job(&save_id, request(), 0, &"a".repeat(64), 10)
            .unwrap();
        let confirmed = service
            .confirm_visual_send(&save_id, &queued.job_id, 0, 11)
            .unwrap();
        let cancelled = service
            .cancel_visual_job(&save_id, &queued.job_id, confirmed.job_revision, 12)
            .unwrap();
        assert_eq!(cancelled.status, GenerationJobStatus::Cancelled);

        let control = ProviderControlStore::new(root.0.clone())
            .open_validated()
            .unwrap();
        let issued: i64 = control
            .query_row(
                "SELECT count(*) FROM provider_send_grants WHERE state='issued'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(issued, 0);
        let error = service
            .run_one_with(
                &save_id,
                &queued.job_id,
                &FakeTokens(Some("token".to_owned())),
                &FakeProvider::successful(),
                13,
            )
            .unwrap_err();
        assert_eq!(serialized_code(&error), "provider.invalid-transition");
    }

    #[test]
    fn adoption_cas_advances_game_and_job_in_one_save_transaction() {
        let (root, service, save_id) = setup("adopt");
        let repository = SaveRepository::new(root.0.clone());
        let mut game = repository
            .load_game(&save_id)
            .unwrap()
            .expect("initial game");
        game["revision"] = json!(1);
        game["roomBlueprint"] = json!({
            "id": "room-type-1",
            "name": "Suite",
            "columns": 8,
            "rows": 12,
            "cells": [],
            "metrics": {
                "areaSquareMeters": 24,
                "buildCostCents": 100,
                "suggestedRateCents": 200,
                "businessFitBps": 8000
            },
            "visual": { "status": "idle" }
        });
        repository.commit_game(0, game).expect("seed blueprint");
        let before = repository
            .load_game(&save_id)
            .unwrap()
            .expect("blueprint game");
        let queued = service
            .enqueue_visual_job(&save_id, request(), 1, &"a".repeat(64), 10)
            .unwrap();
        service
            .confirm_visual_send(&save_id, &queued.job_id, 0, 11)
            .unwrap();
        let ready = service
            .run_one_with(
                &save_id,
                &queued.job_id,
                &FakeTokens(Some("token".to_owned())),
                &FakeProvider::successful(),
                12,
            )
            .unwrap();

        let adopted = service
            .confirm_visual_adoption(
                &save_id,
                &ready.job_id,
                ready.job_revision,
                1,
                &"a".repeat(64),
                13,
            )
            .unwrap();
        assert_eq!(adopted.game_revision, 2);
        assert_eq!(adopted.job.status, GenerationJobStatus::Adopted);
        assert_eq!(&adopted.job.asset, &ready.asset);
        let reopened = repository
            .load_game(&save_id)
            .unwrap()
            .expect("adopted game");
        assert_eq!(reopened["revision"], json!(2));
        assert_eq!(
            reopened["roomBlueprint"]["visual"]["assetPath"],
            json!(adopted.job.asset.as_ref().unwrap().resolver_url)
        );
        assert_eq!(reopened["cashCents"], before["cashCents"]);
        assert_eq!(
            reopened["roomBlueprint"]["cells"],
            before["roomBlueprint"]["cells"]
        );
        assert_eq!(
            reopened["roomBlueprint"]["metrics"],
            before["roomBlueprint"]["metrics"]
        );
        let recovery_points = repository.list_recovery_points(&save_id).unwrap();
        let recovery_points = serde_json::to_value(recovery_points).unwrap();
        let visual_adoptions = recovery_points
            .as_array()
            .unwrap()
            .iter()
            .filter(|point| point["reason"] == json!("visual-adoption"))
            .collect::<Vec<_>>();
        assert_eq!(visual_adoptions.len(), 1);
        assert_eq!(visual_adoptions[0]["kind"], json!("automatic"));
        assert_eq!(visual_adoptions[0]["restoreRevision"], json!(1));
    }
}

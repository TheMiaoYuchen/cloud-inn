use image::{ImageFormat, ImageReader};
use std::fmt;
use std::io::Cursor;
use std::io::Read;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use reqwest::blocking::{Client, Response};
use reqwest::header::{CONTENT_ENCODING, CONTENT_TYPE, RETRY_AFTER};
use reqwest::{StatusCode, Url};
use serde::{Deserialize, Serialize};

pub const API_NEBULA_ORIGIN: &str = "https://img-api.apinebula.ai";
pub const PRIMARY_MODEL: &str = "gemini-3.1-flash-image";
pub const FALLBACK_MODEL: &str = "gemini-2.5-flash-image";

const MODEL_CACHE_TTL: Duration = Duration::from_secs(15 * 60);
const HEALTH_RESPONSE_LIMIT: u64 = 1024 * 1024;
const MAX_PROMPT_CHARS: usize = 12_000;
const MAX_REFERENCE_IMAGES: usize = 4;
const MAX_REFERENCE_BYTES: usize = 32 * 1024 * 1024;
const MAX_CANDIDATES: usize = 8;
const MAX_PARTS: usize = 64;
const MAX_IMAGE_DIMENSION: u32 = 16_384;
const MAX_RETRY_AFTER_SECONDS: u64 = 120;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImageResolution {
    OneK,
    TwoK,
    FourK,
}

impl ImageResolution {
    fn provider_value(self) -> &'static str {
        match self {
            Self::OneK => "1K",
            Self::TwoK => "2K",
            Self::FourK => "4K",
        }
    }

    fn response_limit(self) -> u64 {
        match self {
            Self::OneK => 24 * 1024 * 1024,
            Self::TwoK => 64 * 1024 * 1024,
            Self::FourK => 128 * 1024 * 1024,
        }
    }

    fn decoded_limit(self) -> usize {
        match self {
            Self::OneK => 16 * 1024 * 1024,
            Self::TwoK => 48 * 1024 * 1024,
            Self::FourK => 96 * 1024 * 1024,
        }
    }

    fn pixel_limit(self) -> u64 {
        match self {
            Self::OneK => 4_194_304,
            Self::TwoK => 16_777_216,
            Self::FourK => 67_108_864,
        }
    }

    fn timeout(self) -> Duration {
        match self {
            Self::OneK => Duration::from_secs(90),
            Self::TwoK => Duration::from_secs(180),
            Self::FourK => Duration::from_secs(300),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PrimaryUnavailableReason {
    ModelMissing,
    ClassifiedTransientFailure,
}

pub struct ReferenceImage {
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

impl fmt::Debug for ReferenceImage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReferenceImage")
            .field("mime_type", &self.mime_type)
            .field("byte_length", &self.bytes.len())
            .finish()
    }
}

pub struct GenerateImageRequest {
    pub prompt: String,
    pub references: Vec<ReferenceImage>,
    pub aspect_ratio: Option<String>,
    pub resolution: ImageResolution,
}

impl fmt::Debug for GenerateImageRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GenerateImageRequest")
            .field("prompt_chars", &self.prompt.chars().count())
            .field("reference_count", &self.references.len())
            .field("aspect_ratio", &self.aspect_ratio)
            .field("resolution", &self.resolution)
            .finish()
    }
}

pub struct GeneratedImage {
    pub mime_type: String,
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub actual_model: &'static str,
}

impl fmt::Debug for GeneratedImage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GeneratedImage")
            .field("mime_type", &self.mime_type)
            .field("byte_length", &self.bytes.len())
            .field("width", &self.width)
            .field("height", &self.height)
            .field("actual_model", &self.actual_model)
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderHealth {
    pub primary_available: bool,
    pub fallback_available: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderError {
    InvalidRequest,
    Authentication,
    SafetyRejected,
    ModelUnavailable,
    NetworkUnavailable,
    NeedsRetryConfirmation,
    RateLimited { retry_after_seconds: Option<u64> },
    Transient { status: u16 },
    OriginRedirect,
    ResponseTooLarge,
    MalformedResponse,
}

impl fmt::Display for ProviderError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidRequest => "provider request is invalid",
            Self::Authentication => "provider authentication failed",
            Self::SafetyRejected => "provider rejected the request for safety",
            Self::ModelUnavailable => "provider model is unavailable",
            Self::NetworkUnavailable => "provider network is unavailable",
            Self::NeedsRetryConfirmation => "provider outcome requires retry confirmation",
            Self::RateLimited { .. } => "provider request was rate limited",
            Self::Transient { .. } => "provider is temporarily unavailable",
            Self::OriginRedirect => "provider attempted an origin redirect",
            Self::ResponseTooLarge => "provider response exceeded its limit",
            Self::MalformedResponse => "provider response is malformed",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for ProviderError {}

struct ProviderToken<'a>(&'a str);

impl ProviderToken<'_> {
    fn validate(&self) -> Result<(), ProviderError> {
        let bytes = self.0.as_bytes();
        if bytes.is_empty()
            || bytes.len() > 4096
            || self.0.trim() != self.0
            || self.0.chars().any(char::is_control)
        {
            return Err(ProviderError::Authentication);
        }
        Ok(())
    }
}

struct CachedHealth {
    checked_at: Instant,
    value: ProviderHealth,
}

pub struct ApiNebulaProvider {
    client: Client,
    origin: Url,
    health_cache: Mutex<Option<CachedHealth>>,
}

impl ApiNebulaProvider {
    pub fn new() -> Result<Self, ProviderError> {
        Self::with_origin(API_NEBULA_ORIGIN)
    }

    fn with_origin(origin: &str) -> Result<Self, ProviderError> {
        let origin = Url::parse(origin).map_err(|_| ProviderError::InvalidRequest)?;
        if origin.cannot_be_a_base()
            || origin.path() != "/"
            || origin.query().is_some()
            || origin.fragment().is_some()
        {
            return Err(ProviderError::InvalidRequest);
        }
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| ProviderError::NetworkUnavailable)?;
        Ok(Self {
            client,
            origin,
            health_cache: Mutex::new(None),
        })
    }

    #[cfg(test)]
    pub fn for_test_origin(origin: &str) -> Result<Self, ProviderError> {
        let parsed = Url::parse(origin).map_err(|_| ProviderError::InvalidRequest)?;
        if parsed.scheme() != "http" || parsed.host_str() != Some("127.0.0.1") {
            return Err(ProviderError::InvalidRequest);
        }
        Self::with_origin(origin)
    }

    pub fn check_health(&self, token: &str) -> Result<ProviderHealth, ProviderError> {
        ProviderToken(token).validate()?;
        if let Some(health) = self.cached_health()? {
            return Ok(health);
        }

        let url = self.endpoint("v1/models")?;
        let response = self
            .client
            .get(url)
            .bearer_auth(token)
            .timeout(Duration::from_secs(30))
            .send()
            .map_err(classify_health_transport_error)?;
        let response = require_success(response)?;
        let bytes = read_bounded_json(response, HEALTH_RESPONSE_LIMIT)?;
        let models: ModelListResponse =
            serde_json::from_slice(&bytes).map_err(|_| ProviderError::MalformedResponse)?;
        let mut primary_available = false;
        let mut fallback_available = false;
        for model in models.models.into_iter().chain(models.data) {
            let identifier = model.id.or(model.name).unwrap_or_default();
            let identifier = identifier.strip_prefix("models/").unwrap_or(&identifier);
            primary_available |= identifier == PRIMARY_MODEL;
            fallback_available |= identifier == FALLBACK_MODEL;
        }
        let health = ProviderHealth {
            primary_available,
            fallback_available,
        };
        let mut cache = self
            .health_cache
            .lock()
            .map_err(|_| ProviderError::NetworkUnavailable)?;
        *cache = Some(CachedHealth {
            checked_at: Instant::now(),
            value: health.clone(),
        });
        Ok(health)
    }

    pub fn generate_primary(
        &self,
        token: &str,
        request: &GenerateImageRequest,
    ) -> Result<GeneratedImage, ProviderError> {
        self.generate(token, request, PRIMARY_MODEL)
    }

    pub fn generate_compatible_1k_fallback(
        &self,
        token: &str,
        request: &GenerateImageRequest,
        _reason: PrimaryUnavailableReason,
    ) -> Result<GeneratedImage, ProviderError> {
        if request.resolution != ImageResolution::OneK {
            return Err(ProviderError::InvalidRequest);
        }
        self.generate(token, request, FALLBACK_MODEL)
    }

    fn generate(
        &self,
        token: &str,
        request: &GenerateImageRequest,
        model: &'static str,
    ) -> Result<GeneratedImage, ProviderError> {
        ProviderToken(token).validate()?;
        validate_request(request)?;
        let health = self.check_health(token)?;
        let available = if model == PRIMARY_MODEL {
            health.primary_available
        } else {
            health.fallback_available
        };
        if !available {
            return Err(ProviderError::ModelUnavailable);
        }

        let body = build_request_body(request)?;
        let url = self.endpoint(&format!("v1beta/models/{model}:generateContent"))?;
        let response = self
            .client
            .post(url)
            .bearer_auth(token)
            .json(&body)
            .timeout(request.resolution.timeout())
            .send()
            .map_err(classify_generation_transport_error)?;

        if response.status() == StatusCode::NOT_FOUND {
            self.invalidate_health_cache()?;
            return Err(ProviderError::ModelUnavailable);
        }
        let response = require_success(response)?;
        let bytes = read_bounded_json(response, request.resolution.response_limit())?;
        parse_generated_image(&bytes, request.resolution, model)
    }

    fn endpoint(&self, relative: &str) -> Result<Url, ProviderError> {
        let url = self
            .origin
            .join(relative)
            .map_err(|_| ProviderError::InvalidRequest)?;
        if url.scheme() != self.origin.scheme()
            || url.host_str() != self.origin.host_str()
            || url.port_or_known_default() != self.origin.port_or_known_default()
        {
            return Err(ProviderError::OriginRedirect);
        }
        Ok(url)
    }

    fn cached_health(&self) -> Result<Option<ProviderHealth>, ProviderError> {
        let cache = self
            .health_cache
            .lock()
            .map_err(|_| ProviderError::NetworkUnavailable)?;
        Ok(cache.as_ref().and_then(|cached| {
            (cached.checked_at.elapsed() <= MODEL_CACHE_TTL).then(|| cached.value.clone())
        }))
    }

    fn invalidate_health_cache(&self) -> Result<(), ProviderError> {
        let mut cache = self
            .health_cache
            .lock()
            .map_err(|_| ProviderError::NetworkUnavailable)?;
        *cache = None;
        Ok(())
    }
}

#[derive(Deserialize)]
struct ModelListResponse {
    #[serde(default)]
    models: Vec<ModelRecord>,
    #[serde(default)]
    data: Vec<ModelRecord>,
}

#[derive(Deserialize)]
struct ModelRecord {
    id: Option<String>,
    name: Option<String>,
}

#[derive(Serialize)]
struct GenerateContentBody {
    contents: Vec<RequestContent>,
    #[serde(rename = "generationConfig")]
    generation_config: GenerationConfig,
}

#[derive(Serialize)]
struct RequestContent {
    role: &'static str,
    parts: Vec<RequestPart>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum RequestPart {
    Text {
        text: String,
    },
    Inline {
        #[serde(rename = "inlineData")]
        inline_data: RequestInlineData,
    },
}

#[derive(Serialize)]
struct RequestInlineData {
    #[serde(rename = "mimeType")]
    mime_type: String,
    data: String,
}

#[derive(Serialize)]
struct GenerationConfig {
    #[serde(rename = "responseModalities")]
    response_modalities: [&'static str; 1],
    #[serde(rename = "imageConfig")]
    image_config: ImageConfig,
}

#[derive(Serialize)]
struct ImageConfig {
    #[serde(rename = "imageSize")]
    image_size: &'static str,
    #[serde(rename = "aspectRatio", skip_serializing_if = "Option::is_none")]
    aspect_ratio: Option<String>,
}

fn build_request_body(
    request: &GenerateImageRequest,
) -> Result<GenerateContentBody, ProviderError> {
    let mut parts = Vec::with_capacity(request.references.len() + 1);
    parts.push(RequestPart::Text {
        text: request.prompt.clone(),
    });
    for reference in &request.references {
        parts.push(RequestPart::Inline {
            inline_data: RequestInlineData {
                mime_type: reference.mime_type.clone(),
                data: BASE64_STANDARD.encode(&reference.bytes),
            },
        });
    }
    Ok(GenerateContentBody {
        contents: vec![RequestContent {
            role: "user",
            parts,
        }],
        generation_config: GenerationConfig {
            response_modalities: ["IMAGE"],
            image_config: ImageConfig {
                image_size: request.resolution.provider_value(),
                aspect_ratio: request.aspect_ratio.clone(),
            },
        },
    })
}

fn validate_request(request: &GenerateImageRequest) -> Result<(), ProviderError> {
    if request.prompt.is_empty()
        || request.prompt.chars().count() > MAX_PROMPT_CHARS
        || request.references.len() > MAX_REFERENCE_IMAGES
    {
        return Err(ProviderError::InvalidRequest);
    }
    if let Some(aspect_ratio) = &request.aspect_ratio {
        if aspect_ratio.is_empty()
            || aspect_ratio.len() > 16
            || !aspect_ratio
                .bytes()
                .all(|byte| byte.is_ascii_digit() || byte == b':')
        {
            return Err(ProviderError::InvalidRequest);
        }
    }
    for reference in &request.references {
        if reference.bytes.is_empty()
            || reference.bytes.len() > MAX_REFERENCE_BYTES
            || !matches!(
                reference.mime_type.as_str(),
                "image/png" | "image/jpeg" | "image/webp"
            )
        {
            return Err(ProviderError::InvalidRequest);
        }
    }
    Ok(())
}

fn classify_health_transport_error(_error: reqwest::Error) -> ProviderError {
    ProviderError::NetworkUnavailable
}

fn classify_generation_transport_error(error: reqwest::Error) -> ProviderError {
    if error.is_connect() {
        ProviderError::NetworkUnavailable
    } else {
        ProviderError::NeedsRetryConfirmation
    }
}

fn require_success(response: Response) -> Result<Response, ProviderError> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err(ProviderError::Authentication),
        StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY => {
            Err(ProviderError::InvalidRequest)
        }
        StatusCode::REQUEST_TIMEOUT => Err(ProviderError::NeedsRetryConfirmation),
        StatusCode::TOO_MANY_REQUESTS => Err(ProviderError::RateLimited {
            retry_after_seconds: capped_retry_after(&response),
        }),
        status if status.is_redirection() => Err(ProviderError::OriginRedirect),
        status if status.is_server_error() => Err(ProviderError::Transient {
            status: status.as_u16(),
        }),
        _ => Err(ProviderError::MalformedResponse),
    }
}

fn capped_retry_after(response: &Response) -> Option<u64> {
    response
        .headers()
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .map(|seconds| seconds.min(MAX_RETRY_AFTER_SECONDS))
}

fn read_bounded_json(mut response: Response, limit: u64) -> Result<Vec<u8>, ProviderError> {
    if response
        .headers()
        .get(CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| !value.eq_ignore_ascii_case("identity"))
    {
        return Err(ProviderError::MalformedResponse);
    }
    if !response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.split(';').next() == Some("application/json"))
    {
        return Err(ProviderError::MalformedResponse);
    }
    if response
        .content_length()
        .is_some_and(|length| length > limit)
    {
        return Err(ProviderError::ResponseTooLarge);
    }
    let mut bytes = Vec::new();
    response
        .by_ref()
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ProviderError::NeedsRetryConfirmation)?;
    if bytes.len() as u64 > limit {
        return Err(ProviderError::ResponseTooLarge);
    }
    Ok(bytes)
}

#[derive(Deserialize)]
struct GenerateContentResponse {
    #[serde(default)]
    candidates: Vec<ResponseCandidate>,
}

#[derive(Deserialize)]
struct ResponseCandidate {
    content: Option<ResponseContent>,
    #[serde(rename = "finishReason")]
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct ResponseContent {
    #[serde(default)]
    parts: Vec<ResponsePart>,
}

#[derive(Deserialize)]
struct ResponsePart {
    #[serde(rename = "inlineData")]
    inline_data: Option<ResponseInlineData>,
}

#[derive(Deserialize)]
struct ResponseInlineData {
    #[serde(rename = "mimeType")]
    mime_type: String,
    data: String,
}

fn parse_generated_image(
    bytes: &[u8],
    resolution: ImageResolution,
    model: &'static str,
) -> Result<GeneratedImage, ProviderError> {
    let response: GenerateContentResponse =
        serde_json::from_slice(bytes).map_err(|_| ProviderError::MalformedResponse)?;
    if response.candidates.len() > MAX_CANDIDATES {
        return Err(ProviderError::MalformedResponse);
    }
    if response.candidates.iter().any(|candidate| {
        candidate
            .finish_reason
            .as_deref()
            .is_some_and(|reason| matches!(reason, "SAFETY" | "BLOCKLIST" | "PROHIBITED_CONTENT"))
    }) {
        return Err(ProviderError::SafetyRejected);
    }

    let mut found: Option<ResponseInlineData> = None;
    let mut part_count = 0_usize;
    for candidate in response.candidates {
        if let Some(content) = candidate.content {
            part_count = part_count
                .checked_add(content.parts.len())
                .ok_or(ProviderError::MalformedResponse)?;
            if part_count > MAX_PARTS {
                return Err(ProviderError::MalformedResponse);
            }
            for part in content.parts {
                if let Some(inline_data) = part.inline_data {
                    if found.is_some() {
                        return Err(ProviderError::MalformedResponse);
                    }
                    found = Some(inline_data);
                }
            }
        }
    }
    let inline = found.ok_or(ProviderError::MalformedResponse)?;
    if !matches!(
        inline.mime_type.as_str(),
        "image/png" | "image/jpeg" | "image/webp"
    ) {
        return Err(ProviderError::MalformedResponse);
    }

    let decoded_limit = resolution.decoded_limit();
    let base64_limit = decoded_limit
        .checked_add(2)
        .and_then(|value| value.checked_div(3))
        .and_then(|value| value.checked_mul(4))
        .ok_or(ProviderError::ResponseTooLarge)?;
    if inline.data.len() > base64_limit {
        return Err(ProviderError::ResponseTooLarge);
    }
    let decoded = BASE64_STANDARD
        .decode(inline.data.as_bytes())
        .map_err(|_| ProviderError::MalformedResponse)?;
    if decoded.len() > decoded_limit {
        return Err(ProviderError::ResponseTooLarge);
    }
    let (width, height) = validate_encoded_image(&decoded, &inline.mime_type)
        .map_err(|_| ProviderError::MalformedResponse)?;
    if u64::from(width) * u64::from(height) > resolution.pixel_limit() {
        return Err(ProviderError::MalformedResponse);
    }

    Ok(GeneratedImage {
        mime_type: inline.mime_type,
        bytes: decoded,
        width,
        height,
        actual_model: model,
    })
}

fn validate_encoded_image(bytes: &[u8], mime_type: &str) -> Result<(u32, u32), ProviderError> {
    let format = match mime_type {
        "image/png" => ImageFormat::Png,
        "image/jpeg" => ImageFormat::Jpeg,
        "image/webp" => ImageFormat::WebP,
        _ => return Err(ProviderError::MalformedResponse),
    };
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(768 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|_| ProviderError::MalformedResponse)?;
    Ok((decoded.width(), decoded.height()))
}

#[allow(dead_code)]
fn image_metadata(bytes: &[u8]) -> Result<(&'static str, u32, u32), ProviderError> {
    let (mime, width, height) = if bytes.len() >= 24
        && &bytes[..8] == b"\x89PNG\r\n\x1a\n"
        && bytes[8..12] == [0, 0, 0, 13]
        && &bytes[12..16] == b"IHDR"
    {
        (
            "image/png",
            u32::from_be_bytes(bytes[16..20].try_into().unwrap()),
            u32::from_be_bytes(bytes[20..24].try_into().unwrap()),
        )
    } else if bytes.len() >= 30 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        webp_metadata(bytes)?
    } else if bytes.len() >= 4 && bytes[..2] == [0xff, 0xd8] {
        jpeg_metadata(bytes)?
    } else {
        return Err(ProviderError::MalformedResponse);
    };
    if width == 0 || height == 0 || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION {
        return Err(ProviderError::MalformedResponse);
    }
    Ok((mime, width, height))
}

#[allow(dead_code)]
fn jpeg_metadata(bytes: &[u8]) -> Result<(&'static str, u32, u32), ProviderError> {
    let mut cursor = 2_usize;
    while cursor + 4 <= bytes.len() {
        if bytes[cursor] != 0xff {
            return Err(ProviderError::MalformedResponse);
        }
        let marker = bytes[cursor + 1];
        cursor += 2;
        if matches!(marker, 0xd8 | 0xd9) {
            continue;
        }
        let segment_length = u16::from_be_bytes([bytes[cursor], bytes[cursor + 1]]) as usize;
        if segment_length < 2 || cursor + segment_length > bytes.len() {
            return Err(ProviderError::MalformedResponse);
        }
        if matches!(
            marker,
            0xc0 | 0xc1
                | 0xc2
                | 0xc3
                | 0xc5
                | 0xc6
                | 0xc7
                | 0xc9
                | 0xca
                | 0xcb
                | 0xcd
                | 0xce
                | 0xcf
        ) {
            if segment_length < 7 {
                return Err(ProviderError::MalformedResponse);
            }
            let height = u16::from_be_bytes([bytes[cursor + 3], bytes[cursor + 4]]);
            let width = u16::from_be_bytes([bytes[cursor + 5], bytes[cursor + 6]]);
            return Ok(("image/jpeg", u32::from(width), u32::from(height)));
        }
        cursor += segment_length;
    }
    Err(ProviderError::MalformedResponse)
}

#[allow(dead_code)]
fn webp_metadata(bytes: &[u8]) -> Result<(&'static str, u32, u32), ProviderError> {
    let declared_length = u64::from(u32::from_le_bytes(
        bytes[4..8]
            .try_into()
            .map_err(|_| ProviderError::MalformedResponse)?,
    )) + 8;
    if declared_length != bytes.len() as u64 {
        return Err(ProviderError::MalformedResponse);
    }
    match &bytes[12..16] {
        b"VP8X" if bytes.len() >= 30 => {
            let width = 1 + u32::from_le_bytes([bytes[24], bytes[25], bytes[26], 0]);
            let height = 1 + u32::from_le_bytes([bytes[27], bytes[28], bytes[29], 0]);
            Ok(("image/webp", width, height))
        }
        b"VP8 " if bytes.len() >= 30 && bytes[23..26] == [0x9d, 0x01, 0x2a] => Ok((
            "image/webp",
            u32::from(u16::from_le_bytes([bytes[26], bytes[27]]) & 0x3fff),
            u32::from(u16::from_le_bytes([bytes[28], bytes[29]]) & 0x3fff),
        )),
        b"VP8L" if bytes.len() >= 25 && bytes[20] == 0x2f => {
            let packed = u32::from_le_bytes([bytes[21], bytes[22], bytes[23], bytes[24]]);
            Ok((
                "image/webp",
                (packed & 0x3fff) + 1,
                ((packed >> 14) & 0x3fff) + 1,
            ))
        }
        _ => Err(ProviderError::MalformedResponse),
    }
}

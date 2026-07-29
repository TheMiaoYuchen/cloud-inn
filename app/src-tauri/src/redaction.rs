use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::fmt;
use std::panic::PanicHookInfo;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::LazyLock;

const REDACTED: &str = "[REDACTED]";
const MAX_ERROR_DETAIL_CHARS: usize = 1_024;
const MAX_PANIC_CHARS: usize = 1_024;

static PANIC_HOOK_INSTALLED: AtomicBool = AtomicBool::new(false);
static PRIVATE_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----")
        .expect("private-key redaction regex")
});
static AUTHORIZATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?im)(authorization\s*:\s*)[^\r\n]+").expect("authorization redaction regex")
});
static BEARER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{12,}").expect("bearer redaction regex")
});
static CREDENTIAL_ASSIGNMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)\b(api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|private[_-]?key|client[_-]?secret|password|secret|credentials?)\b(\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)"#,
    )
    .expect("credential redaction regex")
});
static SENSITIVE_FIELD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?is)(["']?(?:prompt|response[_-]?body|provider[_-]?response|inline[_-]?data|body)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,}]+)"#,
    )
    .expect("sensitive-field redaction regex")
});
static DATA_URI: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)data:[a-z0-9.+-]+/[a-z0-9.+-]+(?:;[a-z0-9.+-]+=[^,;\s]+)*;base64,[A-Za-z0-9+/=_-]+",
    )
    .expect("data-uri redaction regex")
});
static LONG_BASE64: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:[A-Za-z0-9+/_-]{128,}={0,2})").expect("base64 redaction regex")
});

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeError {
    code: &'static str,
    message: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

impl SafeError {
    pub fn new(code: &'static str, message: &'static str) -> Self {
        Self {
            code,
            message,
            detail: None,
        }
    }

    pub fn with_detail(mut self, detail: &str) -> Self {
        self.detail = Some(redact_bounded(detail, MAX_ERROR_DETAIL_CHARS));
        self
    }
}

impl fmt::Debug for SafeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SafeError")
            .field("code", &self.code)
            .field("message", &self.message)
            .field("detail", &self.detail)
            .finish()
    }
}

impl fmt::Display for SafeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} ({})", self.message, self.code)
    }
}

impl std::error::Error for SafeError {}

pub fn redact(input: &str) -> String {
    if let Ok(mut value) = serde_json::from_str::<Value>(input) {
        redact_json_value(&mut value);
        return serde_json::to_string(&value).unwrap_or_else(|_| REDACTED.to_string());
    }
    redact_text_patterns(input)
}

pub fn redact_bounded(input: &str, maximum_chars: usize) -> String {
    let redacted = redact(input);
    if redacted.chars().count() <= maximum_chars {
        return redacted;
    }
    let mut bounded = redacted.chars().take(maximum_chars).collect::<String>();
    bounded.push('…');
    bounded
}

pub fn redact_error_string(error: String) -> String {
    redact_bounded(&error, MAX_ERROR_DETAIL_CHARS)
}

pub fn install_panic_hook() {
    if PANIC_HOOK_INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::panic::set_hook(Box::new(|info| {
        eprintln!("{}", format_panic(info));
    }));
}

fn format_panic(info: &PanicHookInfo<'_>) -> String {
    let payload = if let Some(message) = info.payload().downcast_ref::<&str>() {
        *message
    } else if let Some(message) = info.payload().downcast_ref::<String>() {
        message.as_str()
    } else {
        "non-text panic payload"
    };
    let location = info.location().map_or_else(
        || "unknown".to_string(),
        |location| {
            let file = Path::new(location.file())
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("unknown");
            format!("{file}:{}", location.line())
        },
    );
    format!(
        "Cloud Inn internal error at {location}: {}",
        redact_bounded(payload, MAX_PANIC_CHARS)
    )
}

fn redact_json_value(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                if sensitive_json_key(key) {
                    *child = Value::String(REDACTED.to_string());
                } else {
                    redact_json_value(child);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                redact_json_value(item);
            }
        }
        Value::String(text) => {
            *text = redact_text_patterns(text);
        }
        _ => {}
    }
}

fn sensitive_json_key(key: &str) -> bool {
    let compact = key
        .chars()
        .filter(|character| !matches!(character, '_' | '-'))
        .flat_map(char::to_lowercase)
        .collect::<String>();
    matches!(
        compact.as_str(),
        "authorization"
            | "apikey"
            | "apitoken"
            | "token"
            | "accesstoken"
            | "refreshtoken"
            | "authtoken"
            | "privatekey"
            | "clientsecret"
            | "password"
            | "secret"
            | "credential"
            | "credentials"
            | "prompt"
            | "response"
            | "responsebody"
            | "providerresponse"
            | "inlinedata"
            | "body"
    )
}

fn redact_text_patterns(input: &str) -> String {
    let mut output = PRIVATE_KEY
        .replace_all(input, "[REDACTED PRIVATE KEY]")
        .into_owned();
    output = AUTHORIZATION
        .replace_all(&output, "${1}[REDACTED]")
        .into_owned();
    output = BEARER
        .replace_all(&output, "Bearer [REDACTED]")
        .into_owned();
    output = CREDENTIAL_ASSIGNMENT
        .replace_all(&output, "${1}${2}[REDACTED]")
        .into_owned();
    output = SENSITIVE_FIELD
        .replace_all(&output, "${1}[REDACTED]")
        .into_owned();
    output = DATA_URI.replace_all(&output, REDACTED).into_owned();
    LONG_BASE64.replace_all(&output, REDACTED).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SENTINEL: &str = "sentinel-secret-abcdefghijklmnopqrstuvwxyz";

    #[test]
    fn redacts_headers_credentials_private_keys_and_payloads() {
        let private_key = "-----BEGIN PRIVATE KEY-----\nsecret material\n-----END PRIVATE KEY-----";
        let base64 = "A".repeat(128);
        let input = format!(
            "Authorization: Bearer {SENTINEL}\napiKey={SENTINEL}\nBearer {SENTINEL}\n\
             data:image/png;base64,{SENTINEL}\n{private_key}\n{base64}"
        );
        let output = redact(&input);
        assert!(!output.contains(SENTINEL), "{output}");
        assert!(!output.contains("secret material"), "{output}");
        assert!(!output.contains(&base64), "{output}");
    }

    #[test]
    fn redacts_basic_authorization_generic_tokens_and_base64url() {
        let base64url = format!("{}_-", "A".repeat(128));
        let input = format!(
            "Authorization: Basic {SENTINEL}\ntoken={SENTINEL}\napiToken={SENTINEL}\n{base64url}"
        );
        let output = redact(&input);
        assert!(!output.contains(SENTINEL), "{output}");
        assert!(!output.contains(&base64url), "{output}");

        for key in ["token", "apiToken", "api_token"] {
            let json = serde_json::json!({ key: SENTINEL }).to_string();
            let output = redact(&json);
            assert!(!output.contains(SENTINEL), "{output}");
        }
    }

    #[test]
    fn redacts_nested_json_prompt_response_and_credentials() {
        let input = serde_json::json!({
            "request": {"prompt": SENTINEL},
            "providerResponse": {"body": SENTINEL},
            "nested": [{"access_token": SENTINEL}],
            "safe": "hotel-state",
        })
        .to_string();
        let output = redact(&input);
        assert!(!output.contains(SENTINEL), "{output}");
        assert!(output.contains("hotel-state"), "{output}");
    }

    #[test]
    fn safe_error_never_echoes_secret_and_bounds_detail() {
        let detail = format!("Authorization: Bearer {SENTINEL} {}", "x".repeat(2_000));
        let error = SafeError::new("keychain.unavailable", "钥匙串暂时不可用").with_detail(&detail);
        for rendered in [
            serde_json::to_string(&error).unwrap(),
            format!("{error:?}"),
            error.to_string(),
        ] {
            assert!(!rendered.contains(SENTINEL), "{rendered}");
            assert!(rendered.chars().count() < 1_300, "{rendered}");
        }
    }

    #[test]
    fn text_redaction_preserves_non_sensitive_context() {
        let output = redact("provider failed while saving hotel-state");
        assert_eq!(output, "provider failed while saving hotel-state");
    }

    #[test]
    fn panic_format_redacts_payload_and_full_source_path() {
        let result = std::panic::catch_unwind(|| {
            panic!("Authorization: Bearer {SENTINEL}");
        });
        let payload = result.unwrap_err();
        let message = if let Some(message) = payload.downcast_ref::<String>() {
            redact_bounded(message, MAX_PANIC_CHARS)
        } else {
            String::new()
        };
        assert!(!message.contains(SENTINEL), "{message}");
    }
}

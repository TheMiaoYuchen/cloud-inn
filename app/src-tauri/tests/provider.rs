#[path = "../src/provider.rs"]
mod provider;

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use provider::{
    ApiNebulaProvider, GenerateImageRequest, ImageResolution, PrimaryUnavailableReason,
    ProviderError, ReferenceImage, API_NEBULA_ORIGIN, FALLBACK_MODEL, PRIMARY_MODEL,
};

const MODELS: &str = include_str!("fixtures/provider/models.json");
const GENERATED_PNG: &str = include_str!("fixtures/provider/generated_png.json");
const SAFETY: &str = include_str!("fixtures/provider/safety.json");

struct MockResponse {
    status: u16,
    headers: Vec<(&'static str, &'static str)>,
    body: &'static str,
}

impl MockResponse {
    fn json(status: u16, body: &'static str) -> Self {
        Self {
            status,
            headers: vec![("Content-Type", "application/json")],
            body,
        }
    }
}

struct MockServer {
    origin: String,
    paths: Arc<Mutex<Vec<String>>>,
    handle: Option<JoinHandle<()>>,
}

impl MockServer {
    fn start(responses: Vec<MockResponse>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let paths = Arc::new(Mutex::new(Vec::new()));
        let worker_paths = Arc::clone(&paths);
        let handle = thread::spawn(move || {
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let path = read_request(&mut stream);
                worker_paths.lock().unwrap().push(path);
                write_response(&mut stream, response);
            }
        });
        Self {
            origin: format!("http://{address}/"),
            paths,
            handle: Some(handle),
        }
    }

    fn finish(mut self) -> Vec<String> {
        self.handle.take().unwrap().join().unwrap();
        Arc::try_unwrap(self.paths).unwrap().into_inner().unwrap()
    }
}

fn read_request(stream: &mut TcpStream) -> String {
    let mut received = Vec::new();
    let mut buffer = [0_u8; 4096];
    let header_end = loop {
        let count = stream.read(&mut buffer).unwrap();
        assert_ne!(count, 0);
        received.extend_from_slice(&buffer[..count]);
        if let Some(index) = received.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let headers = String::from_utf8_lossy(&received[..header_end]);
    let request_line = headers.lines().next().unwrap();
    let path = request_line.split_whitespace().nth(1).unwrap().to_owned();
    let content_length = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    let already_read = received.len() - header_end;
    if already_read < content_length {
        let mut remaining = vec![0_u8; content_length - already_read];
        stream.read_exact(&mut remaining).unwrap();
    }
    path
}

fn write_response(stream: &mut TcpStream, response: MockResponse) {
    let reason = match response.status {
        200 => "OK",
        302 => "Found",
        404 => "Not Found",
        401 => "Unauthorized",
        408 => "Request Timeout",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        _ => "Error",
    };
    let mut headers = String::new();
    for (name, value) in response.headers {
        headers.push_str(&format!("{name}: {value}\r\n"));
    }
    let head = format!(
        "HTTP/1.1 {} {}\r\n{}Content-Length: {}\r\nConnection: close\r\n\r\n",
        response.status,
        reason,
        headers,
        response.body.len()
    );
    stream.write_all(head.as_bytes()).unwrap();
    stream.write_all(response.body.as_bytes()).unwrap();
    stream.flush().unwrap();
}

fn request(resolution: ImageResolution) -> GenerateImageRequest {
    GenerateImageRequest {
        prompt: "quiet cloud hotel room".to_owned(),
        references: Vec::new(),
        aspect_ratio: Some("16:9".to_owned()),
        resolution,
    }
}

#[test]
fn production_constructor_is_pinned_to_the_api_nebula_https_origin() {
    assert_eq!(API_NEBULA_ORIGIN, "https://img-api.apinebula.ai");
    assert!(ApiNebulaProvider::new().is_ok());
}

#[test]
fn health_is_cached_and_primary_image_is_bounded_and_parsed() {
    let server = MockServer::start(vec![
        MockResponse::json(200, MODELS),
        MockResponse::json(200, GENERATED_PNG),
    ]);
    let adapter = ApiNebulaProvider::for_test_origin(&server.origin).unwrap();

    let health = adapter.check_health("test-token").unwrap();
    assert!(health.primary_available);
    assert!(health.fallback_available);
    let output = adapter
        .generate_primary("test-token", &request(ImageResolution::OneK))
        .unwrap();
    assert_eq!(output.actual_model, PRIMARY_MODEL);
    assert_eq!(output.mime_type, "image/png");
    assert_eq!((output.width, output.height), (1, 1));
    assert!(!output.bytes.is_empty());

    assert_eq!(
        server.finish(),
        vec![
            "/v1/models".to_owned(),
            format!("/v1beta/models/{PRIMARY_MODEL}:generateContent")
        ]
    );
}

#[test]
fn fallback_is_explicit_and_refuses_2k_or_4k_downgrades_without_io() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let unused_origin = format!("http://{}/", listener.local_addr().unwrap());
    drop(listener);
    let adapter = ApiNebulaProvider::for_test_origin(&unused_origin).unwrap();
    for resolution in [ImageResolution::TwoK, ImageResolution::FourK] {
        let result = adapter.generate_compatible_1k_fallback(
            "test-token",
            &request(resolution),
            PrimaryUnavailableReason::ClassifiedTransientFailure,
        );
        assert!(matches!(result, Err(ProviderError::InvalidRequest)));
    }
}

#[test]
fn explicit_1k_fallback_records_the_actual_model() {
    let server = MockServer::start(vec![
        MockResponse::json(200, MODELS),
        MockResponse::json(200, GENERATED_PNG),
    ]);
    let adapter = ApiNebulaProvider::for_test_origin(&server.origin).unwrap();
    let output = adapter
        .generate_compatible_1k_fallback(
            "test-token",
            &request(ImageResolution::OneK),
            PrimaryUnavailableReason::ModelMissing,
        )
        .unwrap();
    assert_eq!(output.actual_model, FALLBACK_MODEL);
    let paths = server.finish();
    assert_eq!(
        paths[1],
        format!("/v1beta/models/{FALLBACK_MODEL}:generateContent")
    );
}

#[test]
fn model_not_found_invalidates_the_health_cache() {
    let server = MockServer::start(vec![
        MockResponse::json(200, MODELS),
        MockResponse::json(404, "{}"),
        MockResponse::json(200, MODELS),
    ]);
    let adapter = ApiNebulaProvider::for_test_origin(&server.origin).unwrap();
    assert!(matches!(
        adapter.generate_primary("test-token", &request(ImageResolution::OneK)),
        Err(ProviderError::ModelUnavailable)
    ));
    adapter.check_health("test-token").unwrap();
    assert_eq!(server.finish().len(), 3);
}

#[test]
fn redirects_and_classified_statuses_are_not_followed_or_retried() {
    let cases = [
        (
            MockResponse {
                status: 302,
                headers: vec![("Location", "https://example.invalid/stolen")],
                body: "",
            },
            ProviderError::OriginRedirect,
        ),
        (
            MockResponse::json(408, "{}"),
            ProviderError::NeedsRetryConfirmation,
        ),
        (
            MockResponse {
                status: 429,
                headers: vec![
                    ("Content-Type", "application/json"),
                    ("Retry-After", "9999"),
                ],
                body: "{}",
            },
            ProviderError::RateLimited {
                retry_after_seconds: Some(120),
            },
        ),
        (
            MockResponse::json(500, "{}"),
            ProviderError::Transient { status: 500 },
        ),
    ];
    for (response, expected) in cases {
        let server = MockServer::start(vec![MockResponse::json(200, MODELS), response]);
        let adapter = ApiNebulaProvider::for_test_origin(&server.origin).unwrap();
        let error = adapter
            .generate_primary("test-token", &request(ImageResolution::OneK))
            .unwrap_err();
        assert_eq!(error, expected);
        assert_eq!(server.finish().len(), 2);
    }
}

#[test]
fn safety_and_malformed_image_responses_are_terminal() {
    let malformed = r#"{"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"bm90LWFuLWltYWdl"}}]}}]}"#;
    for (body, expected) in [
        (SAFETY, ProviderError::SafetyRejected),
        (malformed, ProviderError::MalformedResponse),
    ] {
        let server = MockServer::start(vec![
            MockResponse::json(200, MODELS),
            MockResponse::json(200, body),
        ]);
        let adapter = ApiNebulaProvider::for_test_origin(&server.origin).unwrap();
        let error = adapter
            .generate_primary("test-token", &request(ImageResolution::OneK))
            .unwrap_err();
        assert_eq!(error, expected);
        server.finish();
    }
}

#[test]
fn sensitive_prompt_reference_and_generated_bytes_are_omitted_from_debug() {
    let input = GenerateImageRequest {
        prompt: "PROMPT-SENTINEL".to_owned(),
        references: vec![ReferenceImage {
            mime_type: "image/png".to_owned(),
            bytes: b"REFERENCE-SENTINEL".to_vec(),
        }],
        aspect_ratio: None,
        resolution: ImageResolution::OneK,
    };
    let rendered = format!("{input:?} {:?}", input.references[0]);
    assert!(!rendered.contains("PROMPT-SENTINEL"));
    assert!(!rendered.contains("REFERENCE-SENTINEL"));
}

#[test]
fn invalid_request_is_rejected_before_network_io() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let unused_origin = format!("http://{}/", listener.local_addr().unwrap());
    drop(listener);
    let adapter = ApiNebulaProvider::for_test_origin(&unused_origin).unwrap();
    let mut invalid = request(ImageResolution::OneK);
    invalid.prompt = "x".repeat(12_001);
    assert!(matches!(
        adapter.generate_primary("test-token", &invalid),
        Err(ProviderError::InvalidRequest)
    ));
}

#[test]
fn authentication_and_network_failures_have_distinct_safe_classifications() {
    let server = MockServer::start(vec![MockResponse::json(401, "{}")]);
    let adapter = ApiNebulaProvider::for_test_origin(&server.origin).unwrap();
    assert!(matches!(
        adapter.check_health("test-token"),
        Err(ProviderError::Authentication)
    ));
    server.finish();

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let unused_origin = format!("http://{}/", listener.local_addr().unwrap());
    drop(listener);
    let adapter = ApiNebulaProvider::for_test_origin(&unused_origin).unwrap();
    assert!(matches!(
        adapter.check_health("test-token"),
        Err(ProviderError::NetworkUnavailable)
    ));
}

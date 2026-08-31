//! Local HTTP API for Chrome extension / external clients.
//! Shares AppState.worker mutex so UI and HTTP never load models twice or run synth in parallel.

use crate::settings::{normalize_http_bind_address, AppSettings};
use crate::speakers::{self, SpeakerInfo};
use crate::split_text::normalize_max_chars_from_settings;
use crate::synth::{self, UtteranceSynthOpts};
use crate::voicevox_compat;
use crate::{
    export_wav_adjusted_inner, export_wavs_concatenated_inner, probe_wav_duration, studio_cache_dir,
    AppState, ExportAudioFormat, WavExportSeg,
};
use axum::body::Body;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::{header, HeaderValue, Method, Request, StatusCode};
use axum::middleware::{from_fn_with_state, Next};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tower_http::cors::{AllowOrigin, CorsLayer};

const APP_NAME: &str = "Irodori Studio";
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const PORT_TRIES: u16 = 20;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpServerStatus {
    pub running: bool,
    pub bind_address: String,
    pub port: Option<u16>,
    pub preferred_port: u16,
}

#[derive(Clone)]
struct HttpRuntimeConfig {
    token: String,
    cors_origins: Vec<String>,
    allow_chrome_extensions: bool,
}

#[derive(Clone)]
struct HttpState {
    app: AppHandle,
    config: Arc<RwLock<HttpRuntimeConfig>>,
    jobs: Arc<RwLock<HashMap<String, Arc<Job>>>>,
}

struct Job {
    id: String,
    cancel: AtomicBool,
    inner: Mutex<JobInner>,
}

struct JobInner {
    status: String,
    format: String,
    lines: Vec<JobLine>,
    error: Option<String>,
    split: bool,
    speed: f64,
    volume: f64,
    max_chars: usize,
    silence_ms: u32,
}

struct JobLine {
    text: String,
    speaker: String,
    status: String,
    wav_path: Option<PathBuf>,
    duration_secs: Option<f64>,
    error: Option<String>,
}

pub struct HttpServerHandle {
    shutdown: Option<oneshot::Sender<()>>,
    config: Arc<RwLock<HttpRuntimeConfig>>,
    jobs: Arc<RwLock<HashMap<String, Arc<Job>>>>,
    status: Arc<RwLock<HttpServerStatus>>,
}

impl Default for HttpServerHandle {
    fn default() -> Self {
        Self {
            shutdown: None,
            config: Arc::new(RwLock::new(HttpRuntimeConfig {
                token: String::new(),
                cors_origins: Vec::new(),
                allow_chrome_extensions: true,
            })),
            jobs: Arc::new(RwLock::new(HashMap::new())),
            status: Arc::new(RwLock::new(HttpServerStatus {
                running: false,
                bind_address: "127.0.0.1".into(),
                port: None,
                preferred_port: 18790,
            })),
        }
    }
}

impl HttpServerHandle {
    pub fn status(&self) -> HttpServerStatus {
        self.status.read().clone()
    }

    pub fn update_auth_config(&self, settings: &AppSettings) {
        let mut cfg = self.config.write();
        cfg.token = settings.http_token.clone();
        cfg.cors_origins = settings.http_cors_origins.clone();
        cfg.allow_chrome_extensions = settings.http_allow_chrome_extensions;
    }

    pub fn stop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        let mut st = self.status.write();
        st.running = false;
        st.port = None;
    }

    pub fn apply_settings(&mut self, app: &AppHandle, settings: &AppSettings) {
        self.update_auth_config(settings);
        let want_bind = normalize_http_bind_address(&settings.http_bind_address);
        let want_port = settings.http_port;
        let enabled = settings.http_server_enabled;

        let cur = self.status.read().clone();
        let needs_restart = enabled
            && (!cur.running
                || cur.bind_address != want_bind
                || cur.preferred_port != want_port);

        if !enabled {
            self.stop();
            let mut st = self.status.write();
            st.bind_address = want_bind;
            st.preferred_port = want_port;
            return;
        }

        if needs_restart {
            self.stop();
            if let Err(e) = self.start(app, settings) {
                eprintln!("[irodori-studio] HTTP server start failed: {e}");
            }
        }
    }

    pub fn start(&mut self, app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
        self.stop();
        self.update_auth_config(settings);

        let bind = normalize_http_bind_address(&settings.http_bind_address);
        let preferred = settings.http_port;
        {
            let mut st = self.status.write();
            st.bind_address = bind.clone();
            st.preferred_port = preferred;
            st.running = false;
            st.port = None;
        }

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let config = self.config.clone();
        let jobs = self.jobs.clone();
        let status = self.status.clone();
        let app_handle = app.clone();
        let rt_status = status.clone();
        let bind_for_task = bind.clone();

        tauri::async_runtime::spawn(async move {
            let listener = match bind_with_fallback(&bind_for_task, preferred).await {
                Ok((listener, port)) => {
                    {
                        let mut st = rt_status.write();
                        st.running = true;
                        st.port = Some(port);
                        st.bind_address = bind_for_task.clone();
                        st.preferred_port = preferred;
                    }
                    eprintln!(
                        "[irodori-studio] HTTP API listening on http://{bind_for_task}:{port}"
                    );
                    listener
                }
                Err(e) => {
                    eprintln!("[irodori-studio] HTTP bind failed: {e}");
                    let mut st = rt_status.write();
                    st.running = false;
                    st.port = None;
                    return;
                }
            };

            let state = HttpState {
                app: app_handle,
                config,
                jobs,
            };
            let app_router = build_router(state);

            let serve = axum::serve(
                listener,
                app_router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            });

            if let Err(e) = serve.await {
                eprintln!("[irodori-studio] HTTP server error: {e}");
            }
            let mut st = rt_status.write();
            st.running = false;
            st.port = None;
        });

        self.shutdown = Some(shutdown_tx);
        Ok(())
    }
}

async fn bind_with_fallback(bind: &str, preferred: u16) -> Result<(TcpListener, u16), String> {
    let mut last_err = String::new();
    for i in 0..PORT_TRIES {
        let port = preferred.saturating_add(i);
        let addr_str = format!("{bind}:{port}");
        let addr: SocketAddr = addr_str
            .parse()
            .map_err(|e| format!("無効なバインドアドレス '{addr_str}': {e}"))?;
        match TcpListener::bind(addr).await {
            Ok(l) => return Ok((l, port)),
            Err(e) => last_err = format!("{addr_str}: {e}"),
        }
    }
    Err(format!(
        "ポート {preferred}〜{} をバインドできませんでした（最後のエラー: {last_err}）",
        preferred.saturating_add(PORT_TRIES - 1)
    ))
}

fn build_router(state: HttpState) -> Router {
    let cors = build_cors_layer(state.config.clone());
    let auth_state = state.clone();
    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/speakers", get(list_speakers_http))
        .route("/v1/synthesize", post(synthesize_http))
        .route("/v1/jobs", post(create_job))
        .route("/v1/jobs/{id}", get(get_job))
        .route("/v1/jobs/{id}/lines/{n}", get(get_job_line))
        .route("/v1/jobs/{id}/cancel", post(cancel_job))
        .route("/v1/jobs/{id}/concat", post(concat_job))
        .route("/v1/concat", post(concat_http))
        .route("/v1/concat-files", post(concat_files))
        .route("/version", get(vv_version))
        .route("/engine_manifest", get(vv_engine_manifest))
        .route("/speakers", get(vv_speakers))
        .route("/speaker_info", get(vv_speaker_info))
        .route("/audio_query", post(vv_audio_query))
        .route("/synthesis", post(vv_synthesis))
        .route("/initialize_speaker", post(vv_initialize_speaker))
        .route("/is_initialized_speaker", get(vv_is_initialized_speaker))
        .layer(DefaultBodyLimit::max(512 * 1024 * 1024))
        .layer(from_fn_with_state(auth_state, auth_middleware))
        .layer(cors)
        .with_state(state)
}

fn build_cors_layer(config: Arc<RwLock<HttpRuntimeConfig>>) -> CorsLayer {
    CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(move |origin, _| {
            let cfg = config.read();
            let Ok(origin_str) = origin.to_str() else {
                return false;
            };
            if cfg.allow_chrome_extensions && origin_str.starts_with("chrome-extension://") {
                return true;
            }
            cfg.cors_origins.iter().any(|o| o == origin_str)
        }))
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS, Method::HEAD])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::ACCEPT,
        ])
}

async fn auth_middleware(
    State(state): State<HttpState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    if req.method() == Method::OPTIONS {
        return Ok(next.run(req).await);
    }
    let path = req.uri().path().to_string();
    if voicevox_compat::is_voicevox_compat_path(&path) && is_loopback_peer(peer) {
        return Ok(next.run(req).await);
    }
    let expected = state.config.read().token.clone();
    if expected.is_empty() {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    let auth = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let Some(token) = auth.strip_prefix("Bearer ") else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    if token != expected {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(next.run(req).await)
}

fn is_loopback_peer(peer: SocketAddr) -> bool {
    match peer.ip() {
        std::net::IpAddr::V4(v4) => v4.is_loopback(),
        std::net::IpAddr::V6(v6) => v6.is_loopback(),
    }
}

async fn vv_version() -> Json<Value> {
    voicevox_compat::version().await
}

async fn vv_engine_manifest() -> Json<Value> {
    voicevox_compat::engine_manifest().await
}

async fn vv_speakers(
    State(state): State<HttpState>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let speakers = voicevox_compat::list_speakers_vv(&state.app).await?;
    Ok(Json(json!(speakers.0)))
}

async fn vv_speaker_info(
    State(state): State<HttpState>,
    query: Query<voicevox_compat::SpeakerInfoQuery>,
) -> Result<Json<Value>, (StatusCode, String)> {
    voicevox_compat::speaker_info_vv(&state.app, query).await
}

async fn vv_audio_query(
    State(state): State<HttpState>,
    query: Query<voicevox_compat::AudioQueryParams>,
) -> Result<Json<voicevox_compat::AudioQuery>, (StatusCode, String)> {
    voicevox_compat::audio_query_vv(&state.app, query).await
}

async fn vv_synthesis(
    State(state): State<HttpState>,
    query: Query<voicevox_compat::SynthesisParams>,
    body: Json<voicevox_compat::AudioQuery>,
) -> Result<Response, (StatusCode, String)> {
    let bytes = voicevox_compat::synthesis_vv(&state.app, query, body).await?;
    Ok(audio_response(bytes, "audio/wav"))
}

async fn vv_initialize_speaker(
    State(state): State<HttpState>,
    query: Query<voicevox_compat::InitSpeakerParams>,
) -> Result<Json<Value>, (StatusCode, String)> {
    voicevox_compat::initialize_speaker_vv(&state.app, query).await
}

async fn vv_is_initialized_speaker(
    State(state): State<HttpState>,
    query: Query<voicevox_compat::InitSpeakerParams>,
) -> Result<Json<Value>, (StatusCode, String)> {
    voicevox_compat::is_initialized_speaker_vv(&state.app, query).await
}

fn with_app_state<F, R>(app: &AppHandle, f: F) -> R
where
    F: FnOnce(&AppState) -> R,
{
    let state = app.state::<AppState>();
    f(&state)
}

async fn health(State(state): State<HttpState>) -> Json<Value> {
    // Never block a tokio worker on the OPT mutex (synth can hold it for minutes).
    let (running, loaded, busy) = with_app_state(&state.app, |s| {
        match s.worker.try_lock() {
            Some(w) => (w.is_running(), w.is_loaded(), false),
            None => (true, true, true),
        }
    });
    Json(json!({
        "ok": true,
        "name": APP_NAME,
        "version": APP_VERSION,
        "features": {
            "synthesize": true,
            "jobs": true,
            "concat": true,
            "concatFiles": true,
            "speed": true,
            "split": true,
            "voicevoxCompat": true,
            "formats": {
                "chunk": ["wav", "flac"],
                "concat": ["wav", "mp3", "m4b"]
            }
        },
        "worker": { "running": running, "loaded": loaded, "busy": busy }
    }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SpeakerDto {
    id: String,
    name: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    style_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    gender: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    age_range: Option<String>,
}

async fn list_speakers_http(
    State(state): State<HttpState>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let (settings, speakers) = with_app_state(&state.app, |s| {
        let settings = s.settings.lock().clone();
        let list = speakers::scan_speakers(settings.outputs_root())?;
        Ok::<_, String>((settings, list))
    })
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let map = voicevox_compat::ensure_speaker_maps(settings.outputs_root(), &speakers)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let list: Vec<SpeakerDto> = speakers
        .into_iter()
        .map(|sp| SpeakerDto {
            id: sp.embed_path.clone(),
            name: sp.name,
            kind: sp.kind,
            style_id: map.by_embed_path.get(&sp.embed_path).copied(),
            tags: sp.tags,
            gender: sp.gender,
            age_range: sp.age_range,
        })
        .collect();
    Ok(Json(json!({ "speakers": list })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SynthesizeBody {
    text: String,
    speaker: String,
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    split: Option<bool>,
    #[serde(default)]
    max_chars: Option<u32>,
    #[serde(default)]
    speed: Option<f64>,
    #[serde(default)]
    volume: Option<f64>,
    #[serde(default)]
    silence_ms: Option<u32>,
}

fn normalize_chunk_format(s: Option<&str>) -> Result<&'static str, String> {
    match s.unwrap_or("wav").trim().to_ascii_lowercase().as_str() {
        "" | "wav" => Ok("wav"),
        "flac" => Ok("flac"),
        other => Err(format!(
            "単発・チャンク形式は wav / flac のみです（指定: {other}）"
        )),
    }
}

fn normalize_concat_format(s: Option<&str>) -> Result<&'static str, String> {
    match s.unwrap_or("wav").trim().to_ascii_lowercase().as_str() {
        "" | "wav" => Ok("wav"),
        "mp3" => Ok("mp3"),
        "m4b" | "m4a" => Ok("m4b"),
        other => Err(format!(
            "連結形式は wav / mp3 / m4b のみです（指定: {other}）"
        )),
    }
}

fn http_jobs_dir(job_id: &str) -> PathBuf {
    studio_cache_dir().join("http_jobs").join(job_id)
}

fn content_type_for(format: &str) -> &'static str {
    match format {
        "flac" => "audio/flac",
        "mp3" => "audio/mpeg",
        "m4b" | "m4a" => "audio/mp4",
        _ => "audio/wav",
    }
}

fn convert_wav_to_format(
    settings: &AppSettings,
    wav_path: &str,
    format: &str,
) -> Result<(Vec<u8>, &'static str), String> {
    if format == "wav" {
        let bytes = std::fs::read(wav_path).map_err(|e| e.to_string())?;
        return Ok((bytes, "audio/wav"));
    }

    let ext = if format == "m4b" { "m4b" } else { format };
    let tmp = studio_cache_dir()
        .join("http_export")
        .join(format!("{}.{}", uuid::Uuid::new_v4(), ext));
    if let Some(parent) = tmp.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let dest = tmp.display().to_string();
    let fmt = match format {
        "flac" => ExportAudioFormat::Flac,
        "mp3" => ExportAudioFormat::Mp3,
        "m4b" => ExportAudioFormat::M4b,
        _ => ExportAudioFormat::Wav,
    };
    export_wav_adjusted_inner(settings, wav_path.to_string(), dest, 1.0, 1.0, &Default::default(), fmt, None)?;
    let bytes = std::fs::read(&tmp).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&tmp);
    Ok((bytes, content_type_for(format)))
}

pub(crate) fn audio_response(bytes: Vec<u8>, content_type: &str) -> Response {
    let mut res = Response::new(Body::from(bytes));
    *res.status_mut() = StatusCode::OK;
    if let Ok(v) = HeaderValue::from_str(content_type) {
        res.headers_mut().insert(header::CONTENT_TYPE, v);
    }
    res
}

fn resolve_speaker_list(app: &AppHandle) -> Result<(AppSettings, Vec<SpeakerInfo>), String> {
    with_app_state(app, |s| {
        let settings = s.settings.lock().clone();
        let list = speakers::scan_speakers(settings.outputs_root())?;
        Ok((settings, list))
    })
}

async fn synthesize_http(
    State(state): State<HttpState>,
    Json(body): Json<SynthesizeBody>,
) -> Result<Response, (StatusCode, String)> {
    let text = body.text.trim().to_string();
    if text.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "text が空です".into()));
    }
    let format = normalize_chunk_format(body.format.as_deref())
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    let (settings, speakers) =
        resolve_speaker_list(&state.app).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let speaker = synth::find_speaker(&speakers, &body.speaker)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?
        .clone();

    let split = body.split.unwrap_or(true);
    let max_chars = body
        .max_chars
        .map(normalize_max_chars_from_settings)
        .unwrap_or_else(|| normalize_max_chars_from_settings(settings.http_max_chars));
    let silence_ms = body.silence_ms.unwrap_or(settings.chunk_silence_ms);
    let opts = UtteranceSynthOpts {
        split,
        max_chars,
        speed: body.speed.unwrap_or(1.0),
        volume: body.volume.unwrap_or(1.0),
        silence_ms,
    };

    let job_dir = http_jobs_dir("_oneshot");
    std::fs::create_dir_all(&job_dir)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let wav_path = job_dir.join(format!("{}.wav", uuid::Uuid::new_v4()));
    let wav_path_for_read = wav_path.clone();

    let app = state.app.clone();
    let settings_clone = settings.clone();
    tokio::task::spawn_blocking(move || {
        with_app_state(&app, |s| {
            synth::synthesize_utterance_to_path(
                &settings_clone,
                &s.worker,
                &text,
                &speaker,
                &wav_path,
                opts,
            )
        })
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let settings = with_app_state(&state.app, |s| s.settings.lock().clone());
    let wav_str = wav_path_for_read.display().to_string();
    let (bytes, ct) = convert_wav_to_format(&settings, &wav_str, format)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let _ = std::fs::remove_file(&wav_path_for_read);
    Ok(audio_response(bytes, ct))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JobLineIn {
    text: String,
    speaker: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateJobBody {
    lines: Vec<JobLineIn>,
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    split: Option<bool>,
    #[serde(default)]
    max_chars: Option<u32>,
    #[serde(default)]
    speed: Option<f64>,
    #[serde(default)]
    volume: Option<f64>,
    #[serde(default)]
    silence_ms: Option<u32>,
}

async fn create_job(
    State(state): State<HttpState>,
    Json(body): Json<CreateJobBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    if body.lines.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "lines が空です".into()));
    }
    let format = normalize_chunk_format(body.format.as_deref())
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?
        .to_string();

    let settings = with_app_state(&state.app, |s| s.settings.lock().clone());
    let split = body.split.unwrap_or(false);
    let max_chars = body
        .max_chars
        .map(normalize_max_chars_from_settings)
        .unwrap_or_else(|| normalize_max_chars_from_settings(settings.http_max_chars));
    let speed = body.speed.unwrap_or(1.0);
    let volume = body.volume.unwrap_or(1.0);
    let silence_ms = body.silence_ms.unwrap_or(settings.chunk_silence_ms);

    let job_id = uuid::Uuid::new_v4().to_string();
    let dir = http_jobs_dir(&job_id);
    std::fs::create_dir_all(&dir)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let lines: Vec<JobLine> = body
        .lines
        .into_iter()
        .map(|l| JobLine {
            text: l.text,
            speaker: l.speaker,
            status: "pending".into(),
            wav_path: None,
            duration_secs: None,
            error: None,
        })
        .collect();

    let job = Arc::new(Job {
        id: job_id.clone(),
        cancel: AtomicBool::new(false),
        inner: Mutex::new(JobInner {
            status: "queued".into(),
            format,
            lines,
            error: None,
            split,
            speed,
            volume,
            max_chars,
            silence_ms,
        }),
    });
    state.jobs.write().insert(job_id.clone(), job.clone());

    let app = state.app.clone();
    tauri::async_runtime::spawn(async move {
        run_job(app, job).await;
    });

    Ok(Json(json!({ "jobId": job_id })))
}

async fn run_job(app: AppHandle, job: Arc<Job>) {
    {
        job.inner.lock().status = "running".into();
    }

    let line_count = job.inner.lock().lines.len();
    for i in 0..line_count {
        if job.cancel.load(Ordering::SeqCst) {
            let mut inner = job.inner.lock();
            for line in inner.lines.iter_mut().skip(i) {
                if line.status == "pending" || line.status == "running" {
                    line.status = "cancelled".into();
                }
            }
            inner.status = "cancelled".into();
            return;
        }

        let (text, speaker_id, opts) = {
            let mut inner = job.inner.lock();
            inner.lines[i].status = "running".into();
            let opts = UtteranceSynthOpts {
                split: inner.split,
                max_chars: inner.max_chars,
                speed: inner.speed,
                volume: inner.volume,
                silence_ms: inner.silence_ms,
            };
            (
                inner.lines[i].text.clone(),
                inner.lines[i].speaker.clone(),
                opts,
            )
        };

        let wav_path = http_jobs_dir(&job.id).join(format!("{i:04}.wav"));

        let result = {
            let app = app.clone();
            let wav_path = wav_path.clone();
            tokio::task::spawn_blocking(move || {
                with_app_state(&app, |s| {
                    let settings = s.settings.lock().clone();
                    let speakers = speakers::scan_speakers(settings.outputs_root())?;
                    let speaker = synth::find_speaker(&speakers, &speaker_id)?.clone();
                    synth::synthesize_utterance_to_path(
                        &settings,
                        &s.worker,
                        &text,
                        &speaker,
                        &wav_path,
                        opts,
                    )
                })
            })
            .await
        };

        match result {
            Ok(Ok(())) => {
                let duration = with_app_state(&app, |s| {
                    let settings = s.settings.lock().clone();
                    probe_wav_duration(&settings, &wav_path.display().to_string()).ok()
                });
                let mut inner = job.inner.lock();
                if let Some(line) = inner.lines.get_mut(i) {
                    line.status = "done".into();
                    line.wav_path = Some(wav_path);
                    line.duration_secs = duration;
                }
            }
            Ok(Err(e)) => {
                let mut inner = job.inner.lock();
                if let Some(line) = inner.lines.get_mut(i) {
                    line.status = "failed".into();
                    line.error = Some(e.clone());
                }
                inner.status = "failed".into();
                inner.error = Some(e);
                return;
            }
            Err(e) => {
                let msg = e.to_string();
                let mut inner = job.inner.lock();
                if let Some(line) = inner.lines.get_mut(i) {
                    line.status = "failed".into();
                    line.error = Some(msg.clone());
                }
                inner.status = "failed".into();
                inner.error = Some(msg);
                return;
            }
        }
    }

    let mut inner = job.inner.lock();
    if inner.status == "running" {
        inner.status = "completed".into();
    }
}

async fn get_job(
    State(state): State<HttpState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let job = state
        .jobs
        .read()
        .get(&id)
        .cloned()
        .ok_or_else(|| (StatusCode::NOT_FOUND, "ジョブが見つかりません".into()))?;
    let inner = job.inner.lock();
    let lines: Vec<Value> = inner
        .lines
        .iter()
        .enumerate()
        .map(|(i, l)| {
            json!({
                "index": i,
                "status": l.status,
                "durationSecs": l.duration_secs,
                "error": l.error,
                "ready": l.status == "done",
            })
        })
        .collect();
    Ok(Json(json!({
        "jobId": job.id,
        "status": inner.status,
        "format": inner.format,
        "error": inner.error,
        "total": inner.lines.len(),
        "completed": inner.lines.iter().filter(|l| l.status == "done").count(),
        "lines": lines,
    })))
}

async fn get_job_line(
    State(state): State<HttpState>,
    Path((id, n)): Path<(String, usize)>,
) -> Result<Response, (StatusCode, String)> {
    let job = state
        .jobs
        .read()
        .get(&id)
        .cloned()
        .ok_or_else(|| (StatusCode::NOT_FOUND, "ジョブが見つかりません".into()))?;
    let (wav_path, format) = {
        let inner = job.inner.lock();
        let line = inner
            .lines
            .get(n)
            .ok_or_else(|| (StatusCode::NOT_FOUND, "行が見つかりません".into()))?;
        if line.status != "done" {
            return Err((
                StatusCode::CONFLICT,
                format!("行 {n} はまだ完了していません（status={}）", line.status),
            ));
        }
        let path = line
            .wav_path
            .clone()
            .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, "音声パスがありません".into()))?;
        (path, inner.format.clone())
    };

    let settings = with_app_state(&state.app, |s| s.settings.lock().clone());
    let wav_str = wav_path.display().to_string();
    let (bytes, ct) = convert_wav_to_format(&settings, &wav_str, &format)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(audio_response(bytes, ct))
}

async fn cancel_job(
    State(state): State<HttpState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let job = state
        .jobs
        .read()
        .get(&id)
        .cloned()
        .ok_or_else(|| (StatusCode::NOT_FOUND, "ジョブが見つかりません".into()))?;
    job.cancel.store(true, Ordering::SeqCst);
    {
        let mut inner = job.inner.lock();
        if inner.status == "queued" || inner.status == "running" {
            // Mark pending lines; running line finishes then loop sees cancel.
            for line in inner.lines.iter_mut() {
                if line.status == "pending" {
                    line.status = "cancelled".into();
                }
            }
            if inner.status == "queued" {
                inner.status = "cancelled".into();
            }
        }
    }
    Ok(Json(json!({ "ok": true, "jobId": id })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JobConcatBody {
    #[serde(default)]
    silence_ms: Option<u32>,
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    speed: Option<f64>,
    #[serde(default)]
    volume: Option<f64>,
}

/// Concatenate already-synthesized job line WAVs (no re-synthesis).
async fn concat_job(
    State(state): State<HttpState>,
    Path(id): Path<String>,
    Json(body): Json<JobConcatBody>,
) -> Result<Response, (StatusCode, String)> {
    let format = normalize_concat_format(body.format.as_deref())
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let silence_ms = body.silence_ms.unwrap_or_else(|| {
        with_app_state(&state.app, |s| s.settings.lock().chunk_silence_ms)
    });
    let silence_secs = silence_ms as f64 / 1000.0;
    let speed = body.speed.unwrap_or(1.0);
    let volume = body.volume.unwrap_or(1.0);

    let job = state
        .jobs
        .read()
        .get(&id)
        .cloned()
        .ok_or_else(|| (StatusCode::NOT_FOUND, "ジョブが見つかりません".into()))?;

    let seg_paths: Vec<PathBuf> = {
        let inner = job.inner.lock();
        let paths: Vec<PathBuf> = inner
            .lines
            .iter()
            .filter(|l| l.status == "done")
            .filter_map(|l| l.wav_path.clone())
            .collect();
        if paths.is_empty() {
            return Err((
                StatusCode::CONFLICT,
                "完了した音声がまだありません".into(),
            ));
        }
        paths
    };

    let dest = http_jobs_dir(&id).join(format!(
        "export.{}",
        if format == "m4b" { "m4b" } else { format }
    ));
    let dest_cleanup = dest.clone();
    let app = state.app.clone();
    let format_owned = format.to_string();
    let bytes = tokio::task::spawn_blocking(move || {
        concat_paths_to_bytes(&app, seg_paths, silence_secs, dest, &format_owned, speed, volume)
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))??;
    let _ = std::fs::remove_file(&dest_cleanup);
    Ok(audio_response(bytes, content_type_for(format)))
}

fn concat_paths_to_bytes(
    app: &tauri::AppHandle,
    seg_paths: Vec<PathBuf>,
    silence_secs: f64,
    dest: PathBuf,
    format: &str,
    speed: f64,
    volume: f64,
) -> Result<Vec<u8>, (StatusCode, String)> {
    let settings = with_app_state(app, |s| s.settings.lock().clone());
    let segments: Vec<WavExportSeg> = seg_paths
        .iter()
        .map(|p| WavExportSeg {
            src: p.display().to_string(),
            volume,
            speed,
            audio_fx: Default::default(),
        })
        .collect();
    export_wavs_concatenated_inner(
        &settings,
        segments,
        silence_secs,
        dest.display().to_string(),
        Some(format.to_string()),
        None,
    )
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    std::fs::read(&dest).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

/// Concatenate uploaded WAV blobs (Reader page cache → save). Field order: files in sequence.
async fn concat_files(
    State(state): State<HttpState>,
    mut multipart: Multipart,
) -> Result<Response, (StatusCode, String)> {
    let mut silence_ms: Option<u32> = None;
    let mut format: Option<String> = None;
    let concat_id = uuid::Uuid::new_v4().to_string();
    let dir = http_jobs_dir(&format!("_concat_{concat_id}"));
    std::fs::create_dir_all(&dir)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut i: u32 = 0;
    let mut seg_paths: Vec<PathBuf> = Vec::new();
    while let Some(field) = multipart.next_field().await.map_err(|e| {
        let _ = std::fs::remove_dir_all(&dir);
        (StatusCode::BAD_REQUEST, e.to_string())
    })? {
        let name = field.name().unwrap_or("").to_string();
        if name == "silenceMs" || name == "silence_ms" {
            let t = field
                .text()
                .await
                .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
            silence_ms = t.trim().parse().ok();
        } else if name == "format" {
            format = Some(
                field
                    .text()
                    .await
                    .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?,
            );
        } else if name == "files" || name == "file" {
            let data = field.bytes().await.map_err(|e| {
                let _ = std::fs::remove_dir_all(&dir);
                (StatusCode::BAD_REQUEST, e.to_string())
            })?;
            if data.is_empty() {
                continue;
            }
            let path = dir.join(format!("{i:04}.wav"));
            if let Err(e) = std::fs::write(&path, &data) {
                let _ = std::fs::remove_dir_all(&dir);
                return Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string()));
            }
            seg_paths.push(path);
            i += 1;
        }
    }

    if seg_paths.is_empty() {
        let _ = std::fs::remove_dir_all(&dir);
        return Err((StatusCode::BAD_REQUEST, "音声ファイルがありません".into()));
    }

    let format = match normalize_concat_format(format.as_deref()) {
        Ok(f) => f,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            return Err((StatusCode::BAD_REQUEST, e));
        }
    };
    let silence_ms = silence_ms.unwrap_or_else(|| {
        with_app_state(&state.app, |s| s.settings.lock().chunk_silence_ms)
    });
    let silence_secs = silence_ms as f64 / 1000.0;
    let dest = dir.join(format!(
        "concat.{}",
        if format == "m4b" { "m4b" } else { format }
    ));
    let app = state.app.clone();
    let format_owned = format.to_string();
    let bytes = match tokio::task::spawn_blocking(move || {
        concat_paths_to_bytes(&app, seg_paths, silence_secs, dest, &format_owned, 1.0, 1.0)
    })
    .await
    {
        Ok(Ok(b)) => b,
        Ok(Err(e)) => {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(e);
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            return Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string()));
        }
    };
    let _ = std::fs::remove_dir_all(&dir);
    Ok(audio_response(bytes, content_type_for(format)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConcatBody {
    lines: Vec<JobLineIn>,
    #[serde(default)]
    silence_ms: Option<u32>,
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    split: Option<bool>,
    #[serde(default)]
    max_chars: Option<u32>,
    #[serde(default)]
    speed: Option<f64>,
    #[serde(default)]
    volume: Option<f64>,
}

async fn concat_http(
    State(state): State<HttpState>,
    Json(body): Json<ConcatBody>,
) -> Result<Response, (StatusCode, String)> {
    if body.lines.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "lines が空です".into()));
    }
    let format = normalize_concat_format(body.format.as_deref())
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let silence_ms = body.silence_ms.unwrap_or_else(|| {
        with_app_state(&state.app, |s| s.settings.lock().chunk_silence_ms)
    });
    let silence_secs = silence_ms as f64 / 1000.0;
    let settings = with_app_state(&state.app, |s| s.settings.lock().clone());
    let split = body.split.unwrap_or(true);
    let max_chars = body
        .max_chars
        .map(normalize_max_chars_from_settings)
        .unwrap_or_else(|| normalize_max_chars_from_settings(settings.http_max_chars));
    let speed = body.speed.unwrap_or(1.0);
    let volume = body.volume.unwrap_or(1.0);
    let synth_opts = UtteranceSynthOpts {
        split,
        max_chars,
        speed: 1.0,
        volume: 1.0,
        silence_ms,
    };

    let concat_id = uuid::Uuid::new_v4().to_string();
    let dir = http_jobs_dir(&format!("_concat_{concat_id}"));
    std::fs::create_dir_all(&dir)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut seg_paths: Vec<PathBuf> = Vec::new();
    for (i, line) in body.lines.iter().enumerate() {
        let text = line.text.trim();
        if text.is_empty() {
            continue;
        }
        let wav_path = dir.join(format!("{i:04}.wav"));
        let wav_path_job = wav_path.clone();
        let speaker_id = line.speaker.clone();
        let text = text.to_string();
        let app = state.app.clone();
        let opts = synth_opts.clone();
        tokio::task::spawn_blocking(move || {
            with_app_state(&app, |s| {
                let settings = s.settings.lock().clone();
                let speakers = speakers::scan_speakers(settings.outputs_root())?;
                let speaker = synth::find_speaker(&speakers, &speaker_id)?.clone();
                synth::synthesize_utterance_to_path(
                    &settings,
                    &s.worker,
                    &text,
                    &speaker,
                    &wav_path_job,
                    opts,
                )
            })
        })
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
        seg_paths.push(wav_path);
    }

    if seg_paths.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "有効な text がありません".into()));
    }

    let settings = with_app_state(&state.app, |s| s.settings.lock().clone());
    let dest = dir.join(format!("concat.{}", if format == "m4b" { "m4b" } else { format }));
    let segments: Vec<WavExportSeg> = seg_paths
        .iter()
        .map(|p| WavExportSeg {
            src: p.display().to_string(),
            volume,
            speed,
            audio_fx: Default::default(),
        })
        .collect();

    export_wavs_concatenated_inner(
        &settings,
        segments,
        silence_secs,
        dest.display().to_string(),
        Some(format.to_string()),
        None,
    )
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let bytes = std::fs::read(&dest).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let _ = std::fs::remove_dir_all(&dir);
    Ok(audio_response(bytes, content_type_for(format)))
}

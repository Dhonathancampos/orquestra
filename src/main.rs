#![cfg_attr(all(windows, feature = "gui", not(debug_assertions)), windows_subsystem = "windows")]
mod clear;
mod config;
mod gui;
mod update;
mod mcp;
mod term;
mod transcript;

use axum::{
    body::Body,
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, Path, Request, State},
    http::{header, HeaderMap, StatusCode, Uri},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf, sync::{Arc, Mutex}};
use term::{SpawnReq, Term};
use tokio::sync::broadcast;

#[derive(RustEmbed)]
#[folder = "web/dist"]
struct Assets;

pub struct App {
    pub terms: Mutex<HashMap<String, Arc<Term>>>,
    pub events: broadcast::Sender<String>,
    pub port: u16,
    pub data_dir: PathBuf,
}
pub type S = Arc<App>;

#[derive(Deserialize, Default)]
pub struct NewTerm {
    pub name: Option<String>,
    pub kind: Option<String>,
    pub provider: Option<String>,
    pub bypass: Option<bool>,
    pub parent: Option<String>,
    pub cwd: Option<String>,
    pub command: Option<String>,
    /// Marcar a pasta escolhida (fora do workspace) como confiável no Claude Code.
    pub trust: Option<bool>,
    /// Tema/assunto do chat (agrupa chats relacionados na tela).
    pub theme: Option<String>,
}

fn orchestrator_of(app: &S) -> Option<Arc<Term>> {
    app.terms.lock().unwrap().values().find(|t| t.kind == "orchestrator").cloned()
}

/// Monta a linha de comando a rodar no shell para (provider, kind).
fn build_command(app: &S, prov: &Value, kind: &str, id: &str, bypass: bool, session: &str) -> anyhow::Result<String> {
    // O Claude Code grava o transcript estruturado em <sessão>.jsonl: fixar o id deixa o app achar o arquivo certo.
    let sess = if prov["id"] == "claude" && !session.is_empty() { format!(" --session-id {session}") } else { String::new() };
    if kind != "orchestrator" {
        let mut c = prov["command"].as_str().unwrap_or("").to_string();
        if bypass {
            let flag = prov["bypass_flag"].as_str().filter(|f| !f.is_empty())
                .ok_or_else(|| anyhow::anyhow!("a IA \"{}\" não tem `bypass_flag` em providers.json", prov["name"].as_str().unwrap_or("?")))?;
            c = format!("{c} {flag}");
        }
        if !c.trim().is_empty() { c.push_str(&sess); }
        return Ok(c);
    }
    let tpl = prov["orchestrator_command"].as_str().filter(|c| !c.is_empty())
        .ok_or_else(|| anyhow::anyhow!("a IA \"{}\" não tem `orchestrator_command` em providers.json, então não pode ser orquestradora", prov["name"].as_str().unwrap_or("?")))?;
    let dir = &app.data_dir;
    std::fs::create_dir_all(dir)?;
    let cfg = dir.join(format!("mcp-{id}.json"));
    let url = format!("http://127.0.0.1:{}/mcp/{}", app.port, id);
    std::fs::write(&cfg, serde_json::to_string(&json!({"mcpServers":{"orq":{"type":"http","url":url}}}))?)?;
    let prompt = dir.join("orchestrator-prompt.md");
    std::fs::write(&prompt, include_str!("orchestrator-prompt.md"))?;
    Ok(format!("{}{sess}", tpl.replace("{mcp_config}", &format!("\"{}\"", cfg.display()))
        .replace("{prompt_file}", &format!("\"{}\"", prompt.display()))
        .replace("{mcp_url}", &url)))
}

pub fn create_term(app: &S, n: NewTerm) -> anyhow::Result<Arc<Term>> {
    let cfg = config::load();
    let kind_req = n.kind.unwrap_or_default();
    let provider = n.provider.filter(|p| !p.is_empty())
        .unwrap_or_else(|| if kind_req == "shell" { "shell".into() } else { cfg["default_provider"].as_str().unwrap_or("claude").to_string() });
    let prov = config::provider(&provider).ok_or_else(|| anyhow::anyhow!("IA desconhecida: {provider}"))?;
    let kind = if kind_req == "orchestrator" { "orchestrator".to_string() } else if provider == "shell" { "shell".into() } else { "agent".into() };

    let parent = if kind == "orchestrator" {
        if orchestrator_of(app).is_some() { anyhow::bail!("já existe um orquestrador"); }
        None
    } else {
        Some(orchestrator_of(app).ok_or_else(|| anyhow::anyhow!("crie o orquestrador primeiro: nenhum chat pode existir sem ele"))?.id.clone())
    };

    let id = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
    let bypass = n.bypass.unwrap_or(false) && kind == "agent";
    if bypass && cfg["orchestrator_can_bypass"] != true {
        anyhow::bail!("bypass de permissões está desativado: ligue \"orchestrator_can_bypass\" em ⚙ IAs (providers.json) para permitir");
    }
    let ws = config::workspace_dir();
    if cfg["auto_trust_workspace"] != false {
        if let Err(e) = config::ensure_trusted(&ws) { eprintln!("aviso: não consegui marcar {} como confiável: {e}", ws.display()); }
    }
    let custom = n.cwd.filter(|c| !c.trim().is_empty()).map(|c| config::expand(c.trim()));
    let cwd = match custom {
        Some(c) => {
            let p = std::path::Path::new(&c);
            if !p.is_dir() { anyhow::bail!("a pasta \"{c}\" não existe ou não é um diretório"); }
            let canon = std::fs::canonicalize(p).unwrap_or(p.to_path_buf());
            let canon = canon.to_string_lossy().trim_start_matches("\\\\?\\").to_string();
            if n.trust == Some(true) {
                if let Err(e) = config::ensure_trusted(std::path::Path::new(&canon)) { eprintln!("aviso: não consegui confiar em {canon}: {e}"); }
            }
            canon
        }
        None => ws.to_string_lossy().to_string(),
    };
    if kind != "orchestrator" || cwd != ws.to_string_lossy() { config::touch_recent(&cwd); }
    let session = uuid::Uuid::new_v4().to_string();
    let command = build_command(app, &prov, &kind, &id, bypass, &session)?;
    let mut name = n.name.unwrap_or_default();
    if name.is_empty() {
        name = match kind.as_str() { "orchestrator" => "Orquestrador".into(), "agent" => format!("{} {id}", prov["name"].as_str().unwrap_or("agente")), _ => format!("shell {id}") };
    }
    let t = Term::spawn(SpawnReq { id: id.clone(), name, kind, provider, bypass, parent, cwd, session, theme: clean_theme(n.theme.as_deref()), command, env: vec![] }, app.events.clone())?;
    app.terms.lock().unwrap().insert(id, t.clone());
    let _ = app.events.send(json!({"e":"created","term":t.info()}).to_string());
    Ok(t)
}

/// Troca a IA de um terminal: novo processo, mesmo id/nome/posição. A conversa anterior se perde.
pub fn switch_provider(app: &S, id: &str, provider: &str) -> anyhow::Result<Arc<Term>> {
    let old = get_term(app, id).ok_or_else(|| anyhow::anyhow!("terminal não encontrado"))?;
    let prov = config::provider(provider).ok_or_else(|| anyhow::anyhow!("IA desconhecida: {provider}"))?;
    if old.kind == "orchestrator" && provider == "shell" { anyhow::bail!("o orquestrador precisa ser uma IA"); }
    let kind = if old.kind == "orchestrator" { "orchestrator".to_string() } else if provider == "shell" { "shell".into() } else { "agent".into() };
    let bypass = old.bypass && kind == "agent" && config::load()["orchestrator_can_bypass"] == true && prov["bypass_flag"].as_str().is_some_and(|f| !f.is_empty());
    let session = uuid::Uuid::new_v4().to_string();
    let command = build_command(app, &prov, &kind, id, bypass, &session)?;
    let name = old.name.lock().unwrap().clone();
    let t = Term::spawn(SpawnReq { id: id.into(), name, kind, provider: provider.into(), bypass, parent: old.parent.clone(), cwd: old.cwd.clone(), session, theme: old.theme.lock().unwrap().clone(), command, env: vec![] }, app.events.clone())?;
    old.replaced.store(true, std::sync::atomic::Ordering::Relaxed);
    app.terms.lock().unwrap().insert(id.into(), t.clone());
    old.kill();
    let _ = app.events.send(json!({"e":"restarted","term":t.info()}).to_string());
    Ok(t)
}

pub fn get_term(app: &S, id: &str) -> Option<Arc<Term>> {
    app.terms.lock().unwrap().get(id).cloned()
}

pub fn remove_term(app: &S, id: &str) -> bool {
    let t = app.terms.lock().unwrap().remove(id);
    match t {
        Some(t) => {
            t.kill();
            let _ = app.events.send(json!({"e":"removed","id":id}).to_string());
            if t.kind == "orchestrator" {
                let kids: Vec<String> = app.terms.lock().unwrap().keys().cloned().collect();
                for k in kids { remove_term(app, &k); }
            }
            true
        }
        None => false,
    }
}

async fn list(State(app): State<S>) -> Json<Value> {
    let mut v: Vec<Value> = app.terms.lock().unwrap().values().map(|t| t.info()).collect();
    v.sort_by_key(|x| x["created"].as_u64());
    Json(Value::Array(v))
}

async fn create(State(app): State<S>, Json(n): Json<NewTerm>) -> Response {
    match create_term(&app, n) {
        Ok(t) => Json(t.info()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn delete(State(app): State<S>, Path(id): Path<String>) -> StatusCode {
    if remove_term(&app, &id) { StatusCode::NO_CONTENT } else { StatusCode::NOT_FOUND }
}

pub fn clean_theme(t: Option<&str>) -> String {
    t.unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" ").chars().take(40).collect()
}
/// Define o tema e avisa a interface.
pub fn set_theme(app: &S, t: &Term, theme: &str) {
    *t.theme.lock().unwrap() = clean_theme(Some(theme));
    let _ = app.events.send(json!({"e":"updated","term":t.info()}).to_string());
}

#[derive(Deserialize)]
struct Rename { name: Option<String>, theme: Option<String> }
async fn rename(State(app): State<S>, Path(id): Path<String>, Json(r): Json<Rename>) -> StatusCode {
    match get_term(&app, &id) {
        Some(t) => {
            if let Some(n) = r.name { *t.name.lock().unwrap() = n; }
            if let Some(th) = r.theme { set_theme(&app, &t, &th); }
            StatusCode::NO_CONTENT
        }
        None => StatusCode::NOT_FOUND,
    }
}

async fn version() -> Json<Value> { Json(json!({"app":"orquestra","version":update::VERSION,"platform":update::platform_tag()})) }

#[derive(Deserialize)]
struct UpdQ { force: Option<bool> }
async fn update_check(axum::extract::Query(q): axum::extract::Query<UpdQ>) -> Json<Value> { Json(update::check(q.force.unwrap_or(false)).await) }

#[derive(Deserialize)]
struct OpenReq { url: String }
/// Abre no navegador padrão — só páginas do repositório do próprio app (evita virar um "abridor" genérico).
async fn open_url(Json(r): Json<OpenReq>) -> StatusCode {
    let ok = r.url.starts_with(&format!("https://github.com/{}/", update::REPO));
    if ok && webbrowser::open(&r.url).is_ok() { StatusCode::NO_CONTENT } else { StatusCode::BAD_REQUEST }
}

async fn providers_get() -> Json<Value> { Json(config::load()) }

async fn providers_put(body: String) -> Response {
    match config::save(&body) { Ok(_) => StatusCode::NO_CONTENT.into_response(), Err(e) => (StatusCode::BAD_REQUEST, e).into_response() }
}

/// Limpeza inteligente roda em segundo plano (leva de segundos a minutos); o progresso vai pelos eventos.
async fn clear(State(app): State<S>, Path(id): Path<String>) -> StatusCode {
    match get_term(&app, &id) {
        Some(t) => { tokio::spawn(async move { let _ = clear::smart_clear(&app, &t).await; }); StatusCode::ACCEPTED }
        None => StatusCode::NOT_FOUND,
    }
}

#[derive(Deserialize)]
struct SwitchReq { provider: String }
async fn switch(State(app): State<S>, Path(id): Path<String>, Json(r): Json<SwitchReq>) -> Response {
    match switch_provider(&app, &id, &r.provider) { Ok(t) => Json(t.info()).into_response(), Err(e) => (StatusCode::BAD_REQUEST, e.to_string()).into_response() }
}

#[derive(Deserialize)]
struct MemQ { q: String, cwd: Option<String> }
async fn memory(axum::extract::Query(q): axum::extract::Query<MemQ>) -> Json<Value> {
    let cwd = q.cwd.filter(|c| !c.is_empty()).unwrap_or_else(|| config::workspace_dir().to_string_lossy().to_string());
    Json(Value::Array(config::recall(&q.q, &cwd, 8).await))
}

async fn dirs_get() -> Json<Value> {
    let mut v = config::load_dirs();
    v["workspace"] = json!(config::workspace_dir().to_string_lossy());
    Json(v)
}
#[derive(Deserialize)]
struct DirReq { path: String, favorite: Option<bool>, forget: Option<bool> }
async fn dirs_post(Json(r): Json<DirReq>) -> Json<Value> {
    let path = config::expand(r.path.trim());
    if let Some(f) = r.favorite { config::set_favorite(&path, f); }
    if r.forget == Some(true) { config::forget_recent(&path); }
    dirs_get().await
}

async fn screen_get(State(app): State<S>, Path(id): Path<String>, axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>) -> Response {
    match get_term(&app, &id) {
        Some(t) => {
            let text = if q.contains_key("full") { t.screen_full() } else { t.screen() };
            Json(json!({"text": text, "state": t.state()})).into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
/// Eventos estruturados do chat (transcript do Claude Code). `sid` + `from` = cursor devolvido na chamada anterior.
async fn transcript_get(State(app): State<S>, Path(id): Path<String>, axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>) -> Response {
    let Some(t) = get_term(&app, &id) else { return StatusCode::NOT_FOUND.into_response() };
    if *t.provider.lock().unwrap() != "claude" {
        return Json(json!({"supported": false, "events": [], "sid": "", "next": 0, "reset": false})).into_response();
    }
    let claimed: Vec<String> = app.terms.lock().unwrap().values().filter(|o| o.id != t.id).map(|o| o.session.clone()).collect();
    let (cwd, session, created) = (t.cwd.clone(), t.session.clone(), t.created);
    let (sid_in, from_in) = (q.get("sid").cloned().unwrap_or_default(), q.get("from").and_then(|v| v.parse::<u64>().ok()).unwrap_or(0));
    let res = tokio::task::spawn_blocking(move || {
        let Some(path) = transcript::find_file(&cwd, &session, &claimed, created) else { return json!({"supported": true, "events": [], "sid": "", "next": 0, "reset": false}) };
        let sid = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        let reset = sid != sid_in;
        let (events, next) = transcript::read(&path, if reset { 0 } else { from_in });
        json!({"supported": true, "events": events, "sid": sid, "next": next, "reset": reset})
    }).await;
    match res { Ok(v) => Json(v).into_response(), Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response() }
}
#[derive(Deserialize)]
struct InputReq { text: String, enter: Option<bool> }
async fn input_post(State(app): State<S>, Path(id): Path<String>, Json(r): Json<InputReq>) -> StatusCode {
    match get_term(&app, &id) {
        Some(t) => { t.send_line(&r.text, r.enter.unwrap_or(true)).await; StatusCode::NO_CONTENT }
        None => StatusCode::NOT_FOUND,
    }
}

async fn ws_term(State(app): State<S>, Path(id): Path<String>, ws: WebSocketUpgrade) -> Response {
    let Some(t) = get_term(&app, &id) else { return StatusCode::NOT_FOUND.into_response() };
    ws.on_upgrade(move |sock| term_socket(sock, t))
}

async fn term_socket(mut sock: WebSocket, t: Arc<Term>) {
    // O cliente manda o tamanho primeiro; só então enviamos o estado da tela
    // (já no tamanho certo) e assinamos a saída, sem perder nem duplicar bytes.
    let mut rx: Option<broadcast::Receiver<Vec<u8>>> = None;
    loop {
        tokio::select! {
            out = async { match rx.as_mut() { Some(r) => r.recv().await, None => std::future::pending().await } } => match out {
                Ok(b) => { if sock.send(Message::Binary(b.into())).await.is_err() { break; } }
                // Perdeu bytes (cliente lento): reenvia a tela inteira para não ficar desincronizado/"travado".
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let snap = {
                        let g = t.inner.lock().unwrap();
                        rx = Some(t.tx.subscribe());
                        format!("\x1bc{}", g.parser.screen().state_formatted()).into_bytes()
                    };
                    if sock.send(Message::Binary(snap.into())).await.is_err() { break; }
                }
                Err(_) => break,
            },
            msg = sock.recv() => match msg {
                Some(Ok(Message::Binary(b))) => t.write(&b),
                Some(Ok(Message::Text(s))) => {
                    if let Ok(v) = serde_json::from_str::<Value>(&s) {
                        if v["t"] == "resize" {
                            t.resize(v["cols"].as_u64().unwrap_or(0) as u16, v["rows"].as_u64().unwrap_or(0) as u16);
                            if rx.is_none() {
                                let snap = {
                                    let g = t.inner.lock().unwrap();
                                    rx = Some(t.tx.subscribe());
                                    format!("\x1bc{}", g.parser.screen().state_formatted()).into_bytes()
                                };
                                if sock.send(Message::Binary(snap.into())).await.is_err() { break; }
                            }
                        }
                    }
                }
                Some(Ok(_)) => {}
                _ => break,
            },
        }
    }
}

async fn ws_events(State(app): State<S>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |mut sock| async move {
        let mut rx = app.events.subscribe();
        // Estado de atividade a cada 1s para as bolinhas de status.
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(1000));
        loop {
            tokio::select! {
                e = rx.recv() => match e {
                    Ok(s) => { if sock.send(Message::Text(s.into())).await.is_err() { break; } }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                },
                _ = tick.tick() => {
                    let st: Vec<Value> = app.terms.lock().unwrap().values().map(|t| json!({"id":t.id,"state":t.state(),"idle_ms":t.idle_ms()})).collect();
                    if sock.send(Message::Text(json!({"e":"states","states":st}).to_string().into())).await.is_err() { break; }
                }
                m = sock.recv() => { if !matches!(m, Some(Ok(_))) { break; } }
            }
        }
    })
}

/// Bloqueia DNS-rebinding/CSRF: só aceita Host local e Origin igual ao Host.
async fn guard(State(app): State<S>, req: Request, next: Next) -> Response {
    let h: &HeaderMap = req.headers();
    let host = h.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("");
    let ok_host = [format!("127.0.0.1:{}", app.port), format!("localhost:{}", app.port)].iter().any(|a| a == host);
    let ok_origin = match h.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        None => true,
        Some(o) => o.strip_prefix("http://") == Some(host),
    };
    if !(ok_host && ok_origin) {
        return StatusCode::FORBIDDEN.into_response();
    }
    next.run(req).await
}

async fn static_files(uri: Uri) -> Response {
    let p = uri.path().trim_start_matches('/');
    let p = if p.is_empty() { "index.html" } else { p };
    match Assets::get(p).or_else(|| Assets::get("index.html")) {
        Some(f) => {
            let mime = mime_guess::from_path(p).first_or_octet_stream();
            Response::builder().header(header::CONTENT_TYPE, mime.as_ref()).body(Body::from(f.data.into_owned())).unwrap()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn serve(port: u16, ready: std::sync::mpsc::Sender<Result<(), String>>) {
    let (events, _) = broadcast::channel(256);
    let app: S = Arc::new(App { terms: Mutex::new(HashMap::new()), events, port, data_dir: config::data_dir() });
    let router = Router::new()
        .route("/api/terms", get(list).post(create))
        .route("/api/terms/{id}", axum::routing::delete(delete).patch(rename))
        .route("/api/version", get(version))
        .route("/api/update", get(update_check))
        .route("/api/open", post(open_url))
        .route("/api/providers", get(providers_get).put(providers_put))
        .route("/api/terms/{id}/clear", post(clear))
        .route("/api/terms/{id}/provider", post(switch))
        .route("/api/memory", get(memory))
        .route("/api/terms/{id}/screen", get(screen_get))
        .route("/api/terms/{id}/transcript", get(transcript_get))
        .route("/api/terms/{id}/input", post(input_post))
        .route("/api/dirs", get(dirs_get).post(dirs_post))
        .route("/ws/term/{id}", get(ws_term))
        .route("/ws/events", get(ws_events))
        .route("/mcp/{orch}", post(mcp::handle))
        .fallback(static_files)
        .layer(middleware::from_fn_with_state(app.clone(), guard))
        .with_state(app);
    let addr = format!("127.0.0.1:{port}");
    match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => { let _ = ready.send(Ok(())); axum::serve(l, router).await.unwrap(); }
        Err(e) => { let _ = ready.send(Err(format!("não consegui abrir {addr}: {e} (use ORQUESTRA_PORT para outra porta)"))); }
    }
}

/// Já existe um Orquestra nessa porta? (então só abrimos outra janela para ele)
fn already_running(port: u16) -> Option<bool> {
    let addr: std::net::SocketAddr = format!("127.0.0.1:{port}").parse().ok()?;
    std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(300)).ok()?;
    let r: Result<Value, _> = ureq::get(&format!("http://127.0.0.1:{port}/api/version")).timeout(std::time::Duration::from_secs(2)).call().map_err(|e| e.to_string()).and_then(|r| r.into_json().map_err(|e| e.to_string()));
    Some(matches!(r, Ok(v) if v["app"] == "orquestra"))
}

fn main() {
    let port: u16 = std::env::var("ORQUESTRA_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(7777);
    let url = format!("http://127.0.0.1:{port}/");
    match already_running(port) {
        Some(true) => { println!("Orquestra já está rodando em {url}; abrindo outra janela."); if !gui::run(&url) { let _ = webbrowser::open(&url); } return; }
        Some(false) => { eprintln!("a porta {port} está ocupada por outro programa (use ORQUESTRA_PORT)"); std::process::exit(1); }
        None => {}
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap().block_on(serve(port, tx))
    });
    match rx.recv() {
        Ok(Ok(())) => {}
        Ok(Err(e)) => { eprintln!("{e}"); std::process::exit(1); }
        Err(_) => std::process::exit(1),
    }
    println!("🎛  Orquestra {} em {url}", update::VERSION);
    if !gui::run(&url) {
        if std::env::var_os("ORQUESTRA_NO_BROWSER").is_none() { let _ = webbrowser::open(&url); }
        let _ = server.join();
    }
}

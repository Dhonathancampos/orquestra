//! Leitura do transcript estruturado do Claude Code (`~/.claude/projects/<pasta>/<sessão>.jsonl`).
//! Só os tipos que a visão de chat usa são repassados (nada de prompts de sistema, hooks ou dados de conta).
use serde_json::{json, Value};
use std::{
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

const MAX_LINE: usize = 16 * 1024 * 1024;
const MAX_TEXT: usize = 20_000;

fn claude_root() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(d).join("projects"));
    }
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

/// O Claude Code nomeia a pasta do projeto trocando todo caractere não alfanumérico por `-`.
pub fn project_dir(cwd: &str) -> Option<PathBuf> {
    let enc: String = cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    claude_root().map(|r| r.join(enc))
}

fn mtime_ms(p: &Path) -> u64 {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Acha o transcript do chat. Começa pela sessão que o app pediu (`--session-id`); se o Claude abriu outra
/// depois (ex.: `/clear`), segue a mais nova que nenhum outro chat reivindicou e que foi escrita após a criação.
pub fn find_file(cwd: &str, session: &str, claimed: &[String], created_ms: u64) -> Option<PathBuf> {
    let dir = project_dir(cwd)?;
    let own = dir.join(format!("{session}.jsonl"));
    let mut best = own.exists().then(|| (mtime_ms(&own), own));
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("jsonl") { continue; }
            let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            if stem == session || claimed.iter().any(|c| c == stem) { continue; }
            let m = mtime_ms(&p);
            if m >= created_ms && best.as_ref().map_or(true, |(bm, _)| m > *bm) { best = Some((m, p)); }
        }
    }
    best.map(|(_, p)| p)
}

fn cut(s: &str) -> String {
    if s.len() <= MAX_TEXT { return s.to_string(); }
    let mut n = MAX_TEXT;
    while !s.is_char_boundary(n) { n -= 1; }
    format!("{}\n… (+{} caracteres)", &s[..n], s.len() - n)
}

/// Limita strings gigantes dentro do `input` das ferramentas (ex.: Write com arquivo inteiro).
fn trim_value(v: &Value) -> Value {
    match v {
        Value::String(s) => Value::String(cut(s)),
        Value::Array(a) => Value::Array(a.iter().map(trim_value).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), trim_value(x))).collect()),
        o => o.clone(),
    }
}

fn blocks_text(c: &Value) -> String {
    match c {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().filter_map(|b| match b["type"].as_str() {
            Some("text") => b["text"].as_str().map(String::from),
            _ => None,
        }).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

/// Converte uma linha do JSONL em eventos para a UI (0 ou mais).
fn convert(d: &Value, out: &mut Vec<Value>) {
    let ts = d["timestamp"].as_str().unwrap_or("");
    let uuid = d["uuid"].as_str().unwrap_or("");
    match d["type"].as_str() {
        Some("ai-title") => if let Some(t) = d["aiTitle"].as_str() { out.push(json!({"k":"title","text":t})); },
        Some("cost-state") => out.push(json!({"k":"cost","usd":d["totalCostUSD"],"ms":d["totalDuration"]})),
        Some("user") | Some("assistant") => {
            if d["isSidechain"] == true || d["isMeta"] == true { return; }
            let role = d["type"].as_str().unwrap();
            let msg = &d["message"];
            if role == "assistant" {
                if let Some(m) = msg["model"].as_str() { out.push(json!({"k":"model","text":m})); }
            }
            match &msg["content"] {
                Value::String(s) if role == "user" => {
                    let t = s.trim();
                    if !t.is_empty() && !t.starts_with("<system-reminder>") && !t.starts_with("<local-command") {
                        out.push(json!({"k":"user","text":cut(t),"ts":ts,"id":uuid}));
                    }
                }
                Value::Array(bs) => for b in bs {
                    match b["type"].as_str() {
                        Some("text") => {
                            let t = b["text"].as_str().unwrap_or("").trim();
                            if t.is_empty() { continue; }
                            if role == "user" {
                                if !t.starts_with("<system-reminder>") && !t.starts_with("Base directory for this skill") {
                                    out.push(json!({"k":"user","text":cut(t),"ts":ts,"id":uuid}));
                                }
                            } else {
                                out.push(json!({"k":"text","text":cut(t),"ts":ts,"id":uuid}));
                            }
                        }
                        Some("thinking") => {
                            let t = b["thinking"].as_str().unwrap_or("").trim();
                            if !t.is_empty() { out.push(json!({"k":"thinking","text":cut(t),"ts":ts})); }
                        }
                        Some("tool_use") => out.push(json!({"k":"tool","id":b["id"],"name":b["name"],"input":trim_value(&b["input"]),"ts":ts})),
                        Some("tool_result") => out.push(json!({
                            "k":"result","id":b["tool_use_id"],"err":b["is_error"] == true,
                            "text":cut(&blocks_text(&b["content"])),
                        })),
                        _ => {}
                    }
                },
                _ => {}
            }
        }
        _ => {}
    }
}

/// Lê eventos novos a partir de `from` (bytes). Devolve (eventos, novo offset): só avança até a última linha completa.
pub fn read(path: &Path, from: u64) -> (Vec<Value>, u64) {
    let mut f = match std::fs::File::open(path) { Ok(f) => f, Err(_) => return (vec![], from) };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let from = if from > len { 0 } else { from };
    if f.seek(SeekFrom::Start(from)).is_err() { return (vec![], from); }
    let mut buf = Vec::new();
    if f.take(64 * 1024 * 1024).read_to_end(&mut buf).is_err() { return (vec![], from); }
    let end = buf.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    let mut out = Vec::new();
    for line in buf[..end].split(|&b| b == b'\n') {
        if line.is_empty() || line.len() > MAX_LINE { continue; }
        if let Ok(v) = serde_json::from_slice::<Value>(line) { convert(&v, &mut out); }
    }
    (out, from + end as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_project_dir() {
        let p = project_dir("/home/jhon/orquestra-workspace").unwrap();
        assert!(p.ends_with("-home-jhon-orquestra-workspace"));
    }

    #[test]
    fn converts_events_and_skips_noise() {
        let lines = [
            r#"{"type":"attachment","attachment":{"type":"hook_success"}}"#,
            r#"{"type":"user","uuid":"u1","message":{"role":"user","content":"oi"}}"#,
            r#"{"type":"assistant","uuid":"a1","message":{"model":"m","content":[{"type":"thinking","thinking":""},{"type":"text","text":"olá"},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"a\nb"}]}}"#,
            r#"{"type":"user","isSidechain":true,"message":{"role":"user","content":"x"}}"#,
            r#"{"type":"ai-title","aiTitle":"Titulo"}"#,
        ];
        let mut out = vec![];
        for l in lines { convert(&serde_json::from_str(l).unwrap(), &mut out); }
        let kinds: Vec<&str> = out.iter().map(|e| e["k"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["user", "model", "text", "tool", "result", "title"]);
        assert_eq!(out[4]["text"], "a\nb");
    }

    #[test]
    fn read_stops_at_last_complete_line() {
        let p = std::env::temp_dir().join(format!("orq-tr-{}.jsonl", std::process::id()));
        std::fs::write(&p, "{\"type\":\"ai-title\",\"aiTitle\":\"A\"}\n{\"type\":\"ai-ti").unwrap();
        let (ev, next) = read(&p, 0);
        assert_eq!(ev.len(), 1);
        assert_eq!(next, 34);
        let _ = std::fs::remove_file(&p);
    }

    /// Fumaça com um transcript real: ORQ_TR_FILE=/caminho/x.jsonl cargo test real_file -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_file() {
        let p = std::env::var("ORQ_TR_FILE").expect("defina ORQ_TR_FILE");
        let (ev, next) = read(Path::new(&p), 0);
        let mut c = std::collections::BTreeMap::new();
        for e in &ev { *c.entry(e["k"].as_str().unwrap().to_string()).or_insert(0) += 1; }
        println!("eventos={} next={next} por tipo={c:?}", ev.len());
        assert!(!ev.is_empty());
    }
}

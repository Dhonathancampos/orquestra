//! Versão atual + checagem do último release no GitHub (cache de 1h).
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const REPO: &str = "Dhonathancampos/orquestra";
static CACHE: Mutex<Option<(Instant, Value)>> = Mutex::new(None);

fn parse(v: &str) -> Option<(u64, u64, u64)> {
    let v = v.trim().trim_start_matches('v');
    let core = v.split(['-', '+']).next()?;
    let mut it = core.split('.').map(|n| n.parse::<u64>().ok());
    Some((it.next()??, it.next().unwrap_or(Some(0))?, it.next().unwrap_or(Some(0))?))
}

pub fn is_newer(latest: &str, current: &str) -> bool {
    matches!((parse(latest), parse(current)), (Some(a), Some(b)) if a > b)
}

/// Sufixo dos arquivos de release: linux-x86_64, windows-x86_64, macos-aarch64…
pub fn platform_tag() -> String {
    let os = match std::env::consts::OS { "macos" => "macos", "windows" => "windows", _ => "linux" };
    format!("{os}-{}", std::env::consts::ARCH)
}

fn fetch() -> Result<Value, String> {
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let resp = ureq::get(&url)
        .set("User-Agent", &format!("orquestra/{VERSION}"))
        .set("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(6))
        .call();
    let rel: Value = match resp {
        Ok(r) => r.into_json().map_err(|e| e.to_string())?,
        Err(ureq::Error::Status(404, _)) => return Ok(json!({"current":VERSION,"update_available":false,"note":"ainda não há releases publicados"})),
        Err(e) => return Err(e.to_string()),
    };
    let tag = rel["tag_name"].as_str().unwrap_or("").to_string();
    let plat = platform_tag();
    let asset = rel["assets"].as_array().and_then(|a| a.iter().find(|x| x["name"].as_str().is_some_and(|n| n.contains(&plat))))
        .and_then(|x| x["browser_download_url"].as_str()).map(String::from);
    let notes: String = rel["body"].as_str().unwrap_or("").chars().take(600).collect();
    Ok(json!({
        "current": VERSION, "latest": tag.trim_start_matches('v'), "update_available": is_newer(&tag, VERSION),
        "url": rel["html_url"], "asset_url": asset, "notes": notes,
    }))
}

pub async fn check(force: bool) -> Value {
    if std::env::var_os("ORQUESTRA_NO_UPDATE_CHECK").is_some() || crate::config::load()["check_updates"] == false {
        return json!({"current":VERSION,"update_available":false,"disabled":true});
    }
    if !force {
        if let Some((t, v)) = CACHE.lock().unwrap().as_ref() {
            if t.elapsed() < Duration::from_secs(3600) { return v.clone(); }
        }
    }
    let r = tokio::task::spawn_blocking(fetch).await.map_err(|e| e.to_string()).and_then(|r| r);
    let v = match r { Ok(v) => v, Err(e) => json!({"current":VERSION,"update_available":false,"error":e}) };
    if v["error"].is_null() { *CACHE.lock().unwrap() = Some((Instant::now(), v.clone())); }
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn semver() {
        assert!(is_newer("v0.2.0", "0.1.9"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(!is_newer("v0.1.0", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.2.0"));
        assert!(is_newer("0.10.0", "0.9.0"));
        assert!(!is_newer("lixo", "0.1.0"));
    }
}

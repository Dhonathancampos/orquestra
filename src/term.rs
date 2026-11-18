use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::broadcast;

/// Shell interativo por plataforma. Sobrescreva com ORQUESTRA_SHELL.
fn default_shell() -> (String, Vec<&'static str>) {
    if let Ok(s) = std::env::var("ORQUESTRA_SHELL") { return (s, vec![]); }
    #[cfg(windows)]
    {
        let has_pwsh = std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|d| d.join("pwsh.exe").is_file()));
        (if has_pwsh { "pwsh.exe" } else { "powershell.exe" }.to_string(), vec!["-NoLogo"])
    }
    #[cfg(not(windows))]
    {
        (std::env::var("SHELL").unwrap_or_else(|_| if cfg!(target_os = "macos") { "/bin/zsh".into() } else { "/bin/bash".into() }), vec!["-l", "-i"])
    }
}

fn nz(n: u16) -> std::num::NonZeroU16 {
    std::num::NonZeroU16::new(n.max(1)).unwrap()
}

/// Sem saída por este tempo = "ocioso". Pausas curtas de IAs pensando não devem virar "parou".
pub const IDLE_AFTER_MS: u64 = 2500;
const SCROLL_CAP: usize = 400 * 1024;

/// Ajusta um ponto de corte para não cair no meio de um caractere UTF-8 (bytes de continuação 10xxxxxx).
pub fn utf8_cut(buf: &[u8], mut cut: usize) -> usize {
    while cut < buf.len() && (buf[cut] & 0xC0) == 0x80 { cut += 1; }
    cut
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

pub struct Inner {
    pub scroll: Vec<u8>,
    pub parser: vt100::Parser,
}

pub struct Term {
    pub id: String,
    pub name: Mutex<String>,
    pub theme: Mutex<String>,
    pub kind: String,
    pub provider: Mutex<String>,
    pub bypass: bool,
    pub parent: Option<String>,
    pub cwd: String,
    pub session: String,
    pub created: u64,
    pub replaced: AtomicBool,
    pub clearing: AtomicBool,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    pub inner: Mutex<Inner>,
    pub tx: broadcast::Sender<Vec<u8>>,
    pub last_output: AtomicU64,
    pub exited: AtomicBool,
}

pub struct SpawnReq {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub provider: String,
    pub bypass: bool,
    pub parent: Option<String>,
    pub cwd: String,
    pub session: String,
    pub theme: String,
    pub command: String,
    pub env: Vec<(String, String)>,
}

impl Term {
    pub fn spawn(req: SpawnReq, events: broadcast::Sender<String>) -> anyhow::Result<Arc<Term>> {
        let pair = native_pty_system().openpty(PtySize { rows: 30, cols: 100, pixel_width: 0, pixel_height: 0 })?;
        let (shell, args) = default_shell();
        let mut cmd = CommandBuilder::new(shell);
        for a in args { cmd.arg(a); }
        cmd.cwd(&req.cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // Garante locale UTF-8 no filho (apps abertos pelo menu/atalho podem não herdar LANG): evita acentos corrompidos.
        let utf8 = |k: &str| std::env::var(k).map(|v| { let v = v.to_lowercase(); v.contains("utf-8") || v.contains("utf8") }).unwrap_or(false);
        if !(utf8("LC_ALL") || (std::env::var("LC_ALL").is_err() && utf8("LANG"))) {
            cmd.env("LANG", "C.UTF-8");
            cmd.env("LC_ALL", "C.UTF-8");
        }
        cmd.env("ORQUESTRA_TERM_ID", &req.id);
        for (k, v) in &req.env {
            cmd.env(k, v);
        }
        let child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader()?;
        let mut writer = pair.master.take_writer()?;
        if !req.command.trim().is_empty() {
            writer.write_all(format!("{}\r", req.command).as_bytes())?;
        }
        let (tx, _) = broadcast::channel(1024);
        let t = Arc::new(Term {
            id: req.id,
            name: Mutex::new(req.name),
            theme: Mutex::new(req.theme),
            kind: req.kind,
            provider: Mutex::new(req.provider),
            bypass: req.bypass,
            parent: req.parent,
            cwd: req.cwd,
            session: req.session,
            created: now_ms(),
            replaced: AtomicBool::new(false),
            clearing: AtomicBool::new(false),
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            child: Mutex::new(child),
            inner: Mutex::new(Inner { scroll: Vec::new(), parser: vt100::Parser::new(nz(30), nz(100), 3000) }),
            tx,
            last_output: AtomicU64::new(now_ms()),
            exited: AtomicBool::new(false),
        });
        let t2 = t.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 16384];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut g = t2.inner.lock().unwrap();
                        g.parser.process(&buf[..n]);
                        g.scroll.extend_from_slice(&buf[..n]);
                        if g.scroll.len() > SCROLL_CAP {
                            let cut = utf8_cut(&g.scroll, g.scroll.len() - SCROLL_CAP);
                            g.scroll.drain(..cut);
                        }
                        let _ = t2.tx.send(buf[..n].to_vec());
                        drop(g);
                        t2.last_output.store(now_ms(), Ordering::Relaxed);
                    }
                }
            }
            t2.exited.store(true, Ordering::Relaxed);
            if !t2.replaced.load(Ordering::Relaxed) {
                let _ = events.send(json!({"e":"exit","id":t2.id}).to_string());
            }
        });
        Ok(t)
    }

    pub fn write(&self, data: &[u8]) {
        let mut w = self.writer.lock().unwrap();
        let _ = w.write_all(data);
        let _ = w.flush();
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        if cols == 0 || rows == 0 {
            return;
        }
        let _ = self.master.lock().unwrap().resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
        self.inner.lock().unwrap().parser.set_size(nz(rows), nz(cols));
    }

    pub fn kill(&self) {
        let _ = self.child.lock().unwrap().kill();
    }

    pub fn idle_ms(&self) -> u64 {
        now_ms().saturating_sub(self.last_output.load(Ordering::Relaxed))
    }

    pub fn state(&self) -> &'static str {
        if self.exited.load(Ordering::Relaxed) {
            "exited"
        } else if self.idle_ms() < IDLE_AFTER_MS {
            "working"
        } else {
            "idle"
        }
    }

    pub fn screen(&self) -> String {
        let g = self.inner.lock().unwrap();
        let s = g.parser.screen().contents();
        s.lines().map(|l| l.trim_end()).collect::<Vec<_>>().join("\n").trim_end().to_string()
    }

    /// Histórico (scrollback) + tela atual, uma linha por linha do terminal. Usado pela visão de chat.
    pub fn screen_full(&self) -> String {
        let mut g = self.inner.lock().unwrap();
        let rows = g.parser.screen().size().0.get() as usize;
        let cols = g.parser.screen().size().1.get();
        let total = g.parser.screen().scrollback_len();
        let mut out: Vec<String> = Vec::new();
        // percorre do topo do histórico até a tela viva em janelas de `rows` linhas
        let mut off = total;
        loop {
            g.parser.screen_mut().set_scrollback(off);
            let win: Vec<String> = g.parser.screen().rows(0, cols).collect();
            if off == 0 { out.extend(win); break; }
            // a janela em `off` cobre as linhas [total-off, total-off+rows); só as primeiras
            // min(rows, off) são novas em relação à próxima janela
            out.extend(win.into_iter().take(rows.min(off)));
            off = off.saturating_sub(rows);
        }
        g.parser.screen_mut().set_scrollback(0);
        let mut v: Vec<String> = out.iter().map(|l| l.trim_end().to_string()).collect();
        while v.last().is_some_and(|l| l.is_empty()) { v.pop(); }
        v.join("\n")
    }

    pub fn tail_text(&self, lines: usize) -> String {
        let g = self.inner.lock().unwrap();
        let start = g.scroll.len().saturating_sub(64 * 1024);
        let plain = strip_ansi_escapes::strip(&g.scroll[start..]);
        let text = String::from_utf8_lossy(&plain).replace('\r', "");
        let all: Vec<&str> = text.lines().collect();
        all[all.len().saturating_sub(lines)..].join("\n")
    }

    pub fn info(&self) -> Value {
        json!({
            "id": self.id, "name": *self.name.lock().unwrap(), "kind": self.kind,
            "provider": *self.provider.lock().unwrap(), "bypass": self.bypass,
            "parent": self.parent, "cwd": self.cwd, "theme": *self.theme.lock().unwrap(), "state": self.state(),
            "idle_ms": self.idle_ms(), "created": self.created,
        })
    }

    /// Envia texto + Enter (Enter separado, senão TUIs tratam como colagem).
    pub async fn send_line(self: &Arc<Self>, text: &str, enter: bool) {
        if text.contains('\n') {
            // bracketed paste só se o app filho ativou o modo (?2004); senão manda cru, normalizando quebras
            let bp = self.inner.lock().unwrap().parser.screen().bracketed_paste();
            if bp { self.write(format!("\x1b[200~{}\x1b[201~", text).as_bytes()); }
            else { self.write(text.replace("\r\n", "\n").replace('\n', "\r").as_bytes()); }
        } else {
            self.write(text.as_bytes());
        }
        if enter {
            tokio::time::sleep(Duration::from_millis(250)).await;
            self.write(b"\r");
        }
    }

    pub async fn wait_idle(&self, quiet_ms: u64, timeout_ms: u64) -> bool {
        let start = now_ms();
        loop {
            if self.exited.load(Ordering::Relaxed) || self.idle_ms() >= quiet_ms {
                return true;
            }
            if now_ms() - start > timeout_ms {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corte_nao_parte_caractere_utf8() {
        let b = "aáçãõ你z".as_bytes().to_vec();
        for cut in 0..b.len() {
            let c = utf8_cut(&b, cut);
            assert!(std::str::from_utf8(&b[c..]).is_ok(), "corte {cut} -> {c} gerou UTF-8 inválido");
        }
    }

    #[test]
    fn ocioso_so_apos_o_limite() {
        assert!(IDLE_AFTER_MS >= 2500, "pausas curtas não podem virar 'parou'");
    }
}

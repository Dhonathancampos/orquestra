//! Janela nativa (feature `gui`). Sem a feature, ou se a janela não abrir, o chamador cai no navegador.

#[cfg(feature = "gui")]
pub fn run(url: &str) -> bool {
    if std::env::var_os("ORQUESTRA_BROWSER").is_some() { return false; }
    use tao::{dpi::LogicalSize, event::{Event, WindowEvent}, event_loop::{ControlFlow, EventLoopBuilder}, window::WindowBuilder};
    use wry::WebViewBuilder;

    let built = std::panic::catch_unwind(|| EventLoopBuilder::new().build());
    let Ok(event_loop) = built else { eprintln!("não consegui iniciar a janela nativa; abrindo no navegador"); return false };
    let Ok(window) = WindowBuilder::new().with_title("Orquestra").with_inner_size(LogicalSize::new(1500.0, 920.0)).build(&event_loop) else { return false };

    let builder = WebViewBuilder::new().with_url(url);
    #[cfg(any(target_os = "linux", target_os = "dragonfly", target_os = "freebsd", target_os = "netbsd", target_os = "openbsd"))]
    let webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        builder.build_gtk(window.default_vbox().expect("janela sem vbox"))
    };
    #[cfg(not(any(target_os = "linux", target_os = "dragonfly", target_os = "freebsd", target_os = "netbsd", target_os = "openbsd")))]
    let webview = builder.build(&window);
    let Ok(webview) = webview else { eprintln!("WebView indisponível; abrindo no navegador"); return false };

    event_loop.run(move |event, _, flow| {
        let _keep = (&window, &webview);
        *flow = ControlFlow::Wait;
        if let Event::WindowEvent { event: WindowEvent::CloseRequested, .. } = event {
            std::process::exit(0); // encerra o servidor e todos os terminais
        }
    })
}

#[cfg(not(feature = "gui"))]
pub fn run(_url: &str) -> bool { false }

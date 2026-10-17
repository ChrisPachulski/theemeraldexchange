//! SSRF containment for ffmpeg's network inputs (ffmpegEgress.ts). ffmpeg
//! follows any redirect the provider answers with and its protocol whitelist
//! cannot say "public addresses only", so it dials through this loopback
//! proxy (`-http_proxy`): each hop, redirects included, is a new proxy request,
//! allowed only for the operator's provider host (trusted) or a host that is
//! public and resolves public. Plain http arrives as absolute-URI requests,
//! https as CONNECT tunnels. When either socket closes the other does too, so
//! no provider socket outlives the ffmpeg that opened it.

use std::net::SocketAddr;

use reqwest::Url;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::xtream::guard;

/// Protocols an ffmpeg network input needs when it dials through the proxy.
pub const FFMPEG_PROXIED_PROTOCOLS: &str = "http,https,tcp,tls,crypto,httpproxy";
/// A request head larger than this is refused.
const MAX_HEAD: usize = 16 * 1024;

#[derive(Clone)]
pub struct Egress {
    addr: Option<SocketAddr>,
}

impl Egress {
    /// Bind 127.0.0.1:0 and serve (needs a tokio runtime). `trusted` is
    /// XTREAM_HOST. A failed bind is logged and leaves the proxy absent.
    pub fn start(trusted: &str) -> Egress {
        let trusted = Url::parse(trusted).ok().map(|u| authority(&u));
        let bound = std::net::TcpListener::bind("127.0.0.1:0")
            .and_then(|l| l.set_nonblocking(true).map(|_| l))
            .and_then(TcpListener::from_std);
        match bound {
            Ok(listener) => {
                let addr = listener.local_addr().ok();
                tokio::spawn(async move {
                    while let Ok((sock, _)) = listener.accept().await {
                        tokio::spawn(handle(sock, trusted.clone()));
                    }
                });
                Egress { addr }
            }
            Err(e) => {
                tracing::error!("ffmpeg egress proxy failed to listen: {e}");
                Egress { addr: None }
            }
        }
    }

    /// `-http_proxy` args routing an ffmpeg input through the proxy, or None
    /// when it is not listening (callers treat that like a busy upstream).
    pub fn proxy_args(&self) -> Option<[String; 2]> {
        self.addr
            .map(|a| ["-http_proxy".to_string(), format!("http://{a}")])
    }
}

/// `URL.host`: hostname plus a non-default port.
fn authority(u: &Url) -> String {
    match (u.host_str(), u.port()) {
        (Some(h), Some(p)) => format!("{h}:{p}"),
        (Some(h), None) => h.to_string(),
        _ => String::new(),
    }
}

async fn allowed(url: &Url, trusted: Option<&str>) -> bool {
    trusted.is_some_and(|t| authority(url) == t) || guard(url).await.is_ok()
}

async fn handle(mut client: TcpStream, trusted: Option<String>) {
    let Some((head, rest)) = read_head(&mut client).await else {
        let _ = client.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n").await;
        return;
    };
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let (method, target) = (first.next().unwrap_or(""), first.next().unwrap_or(""));
    let connect = method.eq_ignore_ascii_case("CONNECT");
    let url = if connect {
        Url::parse(&format!("https://{target}"))
    } else {
        Url::parse(target)
    };
    let Ok(url) = url else {
        let _ = client.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n").await;
        return;
    };
    if (!connect && url.scheme() != "http") || !allowed(&url, trusted.as_deref()).await {
        tracing::warn!(host = authority(&url), "blocked ffmpeg egress");
        let _ = client.write_all(b"HTTP/1.1 403 Forbidden\r\n\r\n").await;
        return;
    }
    let host = url.host_str().unwrap_or("").trim_matches(['[', ']']);
    let port = url.port_or_known_default().unwrap_or(80);
    let Ok(mut upstream) = TcpStream::connect((host, port)).await else {
        let _ = client.write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n").await;
        return;
    };
    let ok = if connect {
        client
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await
    } else {
        // Origin-form request line, proxy-only headers dropped, and one
        // request per tunnel so a redirect hop comes back here to be checked.
        let query = url.query().map(|q| format!("?{q}")).unwrap_or_default();
        let mut out = format!("{method} {}{query} HTTP/1.1\r\n", url.path());
        for line in lines.filter(|l| !l.is_empty()) {
            let name = line
                .split(':')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            if !matches!(
                name.as_str(),
                "proxy-connection" | "proxy-authorization" | "connection"
            ) {
                out.push_str(line);
                out.push_str("\r\n");
            }
        }
        out.push_str("Connection: close\r\n\r\n");
        upstream.write_all(out.as_bytes()).await
    };
    if ok.is_err() || upstream.write_all(&rest).await.is_err() {
        return;
    }
    // Either direction ending drops both sockets.
    let (mut cr, mut cw) = client.split();
    let (mut ur, mut uw) = upstream.split();
    tokio::select! {
        _ = tokio::io::copy(&mut cr, &mut uw) => {}
        _ = tokio::io::copy(&mut ur, &mut cw) => {}
    }
}

/// The request head (up to the blank line) and any bytes read past it.
async fn read_head(sock: &mut TcpStream) -> Option<(String, Vec<u8>)> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 2048];
    loop {
        let n = sock.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8(buf[..end].to_vec()).ok()?;
            return Some((head, buf[end + 4..].to_vec()));
        }
        if buf.len() > MAX_HEAD {
            return None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    async fn serve(body: &'static str, hits: Arc<AtomicUsize>) -> String {
        let app = axum::Router::new().fallback(move || {
            hits.fetch_add(1, Ordering::SeqCst);
            async move { body }
        });
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        format!("127.0.0.1:{}", addr.port())
    }

    async fn raw(proxy: &str, req: String) -> String {
        let mut s = TcpStream::connect(proxy).await.unwrap();
        s.write_all(req.as_bytes()).await.unwrap();
        let mut out = Vec::new();
        let _ = s.read_to_end(&mut out).await;
        String::from_utf8_lossy(&out).into_owned()
    }

    #[tokio::test]
    async fn passes_the_provider_refuses_internal_hosts_on_both_paths() {
        let internal_hits = Arc::new(AtomicUsize::new(0));
        let provider = serve("stream", Arc::new(AtomicUsize::new(0))).await;
        let internal = serve("secret", internal_hits.clone()).await;
        let egress = Egress::start(&format!("http://{provider}"));
        let [flag, url] = egress.proxy_args().unwrap();
        assert_eq!(flag, "-http_proxy");
        let proxy = url.trim_start_matches("http://").to_string();

        let ok = raw(
            &proxy,
            format!("GET http://{provider}/live/u/p/1.ts HTTP/1.1\r\nHost: {provider}\r\n\r\n"),
        )
        .await;
        assert!(ok.starts_with("HTTP/1.1 200"), "{ok}");
        assert!(ok.ends_with("stream"), "{ok}");

        let refused = raw(
            &proxy,
            format!("GET http://{internal}/internal HTTP/1.1\r\nHost: {internal}\r\n\r\n"),
        )
        .await;
        assert!(refused.starts_with("HTTP/1.1 403"), "{refused}");

        for target in [internal.as_str(), "recommender:8000"] {
            let r = raw(
                &proxy,
                format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n"),
            )
            .await;
            assert_eq!(r.split("\r\n").next(), Some("HTTP/1.1 403 Forbidden"));
        }
        assert_eq!(internal_hits.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_connect_tunnel_closes_the_client_when_the_upstream_closes() {
        let provider = serve("stream", Arc::new(AtomicUsize::new(0))).await;
        let egress = Egress::start(&format!("http://{provider}"));
        let proxy = egress.proxy_args().unwrap()[1]
            .trim_start_matches("http://")
            .to_string();
        let reply = raw(
            &proxy,
            format!(
                "CONNECT {provider} HTTP/1.1\r\nHost: {provider}\r\n\r\n\
                 GET / HTTP/1.1\r\nHost: {provider}\r\nConnection: close\r\n\r\n"
            ),
        )
        .await;
        assert!(
            reply.starts_with("HTTP/1.1 200 Connection Established"),
            "{reply}"
        );
        assert!(reply.ends_with("stream"), "read_to_end returned: {reply}");
    }
}

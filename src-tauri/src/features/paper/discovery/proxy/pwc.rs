//! Sandboxed paperswithcode.co proxy for the 广场 Papers with Code panel.
//!
//! The site answers `X-Frame-Options: SAMEORIGIN`, so a plain iframe is refused.
//! Serving it under our own scheme drops that header and makes the frame
//! same-origin, which is what lets the bridge report navigations and keep
//! clicks in place.
//!
//! The site is a client-rendered React SPA with relative `/api/v1` calls, so
//! routing has to be observed through `pushState` / `replaceState`; a card or
//! nav click never becomes a real navigation. Request plumbing lives in
//! [`super`].

use super::SiteProxy;

const ORIGIN: &str = "https://paperswithcode.co";
const USER_AGENT: &str = "agentero/0.6 (+https://github.com/poco-ai/agentero)";

/// Reports in-site navigation, keeps clicks in the frame, and hands every
/// third-party link (GitHub, Hugging Face, arXiv, …) to the system browser.
///
/// Only stable APIs are touched: `history.pushState` / `replaceState`,
/// `popstate`, `window.open`, and the DOM click target. The site's CSS-module
/// class names are content-hashed per release and are never matched.
const NAV_BRIDGE: &str = r##"<script>
(function () {
  try {
    // Only the panel's own frame talks to the app; a nested same-origin frame
    // has a readable parent and stays uninstrumented.
    try {
      if (parent !== window && parent.location.href) return;
    } catch (e) {}
    var post = function (message) {
      message.source = "agentero-plaza";
      parent.postMessage(message, "*");
    };
    var last = null;
    var send = function () {
      var path = location.pathname + location.search;
      if (path === last) return;
      last = path;
      post({ path: path });
    };
    var wrap = function (kind) {
      var original = history[kind];
      if (typeof original !== "function") return;
      history[kind] = function () {
        var result = original.apply(this, arguments);
        send();
        return result;
      };
    };
    wrap("pushState");
    wrap("replaceState");
    window.addEventListener("popstate", send);

    var external = function (url) {
      post({ external: url });
    };
    var resolve = function (href) {
      try {
        return new URL(href, location.href);
      } catch (e) {
        return null;
      }
    };

    // Same-origin links are the site's router's job; anything else leaves.
    document.addEventListener(
      "click",
      function (event) {
        var target = event.target;
        if (!target || !target.closest) return;
        var anchor = target.closest("a[href]");
        if (!anchor) return;
        var href = anchor.getAttribute("href");
        if (!href || href.charAt(0) === "#" || href.indexOf("javascript:") === 0) return;
        var url = resolve(href);
        if (!url) return;
        if (url.origin === location.origin) {
          // The site renders `/api/...` files (JSON, Markdown) in place; those
          // belong in the system browser like any other non-page response.
          if (anchor.hasAttribute("download")) {
            event.preventDefault();
            external(url.href);
          }
          return;
        }
        event.preventDefault();
        external(url.href);
      },
      true
    );

    // The site opens GitHub and Hugging Face links through helper windows.
    var open = window.open;
    window.open = function (url) {
      if (url) {
        var resolved = resolve(url);
        if (resolved) external(resolved.href);
        return null;
      }
      return open.apply(this, arguments);
    };

    send();
    // The router may resolve the initial route after hydration.
    setTimeout(send, 120);
  } catch (e) {}
})();
</script>"##;

fn rewrite(html: &str) -> String {
    // The site is the only origin the proxy may reach; absolute self links
    // would otherwise look cross-origin to the bridge and leave the frame.
    let html = html.replace("https://paperswithcode.co/", "/");
    let html = html
        .replace("target=\"_blank\"", "target=\"_self\"")
        .replace("target='_blank'", "target='_self'");
    match html.find("</head>") {
        Some(index) => {
            let mut out = String::with_capacity(html.len() + NAV_BRIDGE.len());
            out.push_str(&html[..index]);
            out.push_str(NAV_BRIDGE);
            out.push_str(&html[index..]);
            out
        }
        None => format!("{NAV_BRIDGE}{html}"),
    }
}

static SITE: SiteProxy = SiteProxy {
    label: "Papers with Code",
    origin: ORIGIN,
    user_agent: USER_AGENT,
    rewrite,
};

pub fn handle(request: tauri::http::Request<Vec<u8>>, responder: tauri::UriSchemeResponder) {
    super::handle(&SITE, request, responder);
}

#[cfg(test)]
mod tests {
    use super::rewrite;

    #[test]
    fn injects_bridge_and_keeps_self_links_local() {
        let html = r#"<html><head><link rel="canonical" href="https://paperswithcode.co/conferences"></head><body><a href="https://paperswithcode.co/paper/1" target="_blank">x</a></body></html>"#;
        let out = rewrite(html);
        assert!(out.contains("agentero-plaza"));
        assert!(out.contains(r#"href="/paper/1""#));
        assert!(out.contains(r#"target="_self""#));
        assert!(!out.contains("https://paperswithcode.co/paper/1"));
        // Exactly one bridge, before the document body.
        assert_eq!(out.matches("agentero-plaza").count(), 1);
        assert!(out.find("agentero-plaza").unwrap() < out.find("</head>").unwrap());
    }

    #[test]
    fn prepends_bridge_when_head_is_missing() {
        let out = rewrite("<div>fragment</div>");
        assert!(out.starts_with("<script>"));
    }
}

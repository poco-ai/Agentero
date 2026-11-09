//! Sandboxed paperswithcode.co proxy for the 广场 Papers with Code panel.
//!
//! The site answers `X-Frame-Options: SAMEORIGIN`, so a plain iframe is refused.
//! Serving it under our own scheme drops that header and makes the frame
//! same-origin, which is what lets the bridge report navigations, keep clicks in
//! place, and add an `[入库]` action to every paper row.
//!
//! The site is a client-rendered React SPA with relative `/api/v1` calls, so
//! routing has to be observed through `pushState` / `replaceState`; a card or
//! nav click never becomes a real navigation. Request plumbing lives in
//! [`super`].

use super::SiteProxy;

const ORIGIN: &str = "https://paperswithcode.co";
const USER_AGENT: &str = "agentero/0.6 (+https://github.com/poco-ai/agentero)";

/// Reports in-site navigation, keeps clicks in the frame, hands every
/// third-party link (GitHub, Hugging Face, arXiv, …) to the system browser, and
/// decorates paper cards with an import action.
///
/// Only stable hooks are used: `article.paper-card`, `h3.paper-title`,
/// `.paper-resources`, `.action-row`, `a[href^="/paper/"]`, plus the router's
/// `pushState`. The site's CSS-module class names are content-hashed per release
/// and are never matched.
const NAV_BRIDGE: &str = r##"<style>
.agentero-import {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  margin-left: 8px;
  padding: 2px 9px;
  border: 1px solid color-mix(in oklab, currentColor 26%, transparent);
  border-radius: 999px;
  background: color-mix(in oklab, currentColor 7%, transparent);
  color: inherit;
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  vertical-align: middle;
}
.agentero-import:hover { background: color-mix(in oklab, currentColor 15%, transparent); }
.agentero-import[data-state="pending"],
.agentero-import[data-state="done"] { cursor: default; opacity: 0.55; }
</style>
<script>
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
        scheduleDecorating();
        return result;
      };
    };
    wrap("pushState");
    wrap("replaceState");
    window.addEventListener("popstate", function () {
      send();
      scheduleDecorating();
    });

    var resolve = function (href) {
      try {
        return new URL(href, location.href);
      } catch (e) {
        return null;
      }
    };
    var external = function (url) {
      post({ external: url });
    };

    // Same-origin links are the site's router's job; anything else leaves.
    document.addEventListener(
      "click",
      function (event) {
        var target = event.target;
        if (!target || !target.closest) return;

        var action = target.closest(".agentero-import");
        if (action) {
          event.preventDefault();
          event.stopPropagation();
          if (action.dataset.state === "pending" || action.dataset.state === "done") {
            return;
          }
          action.dataset.state = "pending";
          setLabel(action, LABELS.pending);
          post({
            importPaper: {
              id: action.dataset.paperId,
              url: "https://paperswithcode.co/paper/" + encodeURIComponent(action.dataset.paperId),
              title: action.dataset.paperTitle || null
            }
          });
          return;
        }

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

    // ---- [入库] ----------------------------------------------------------
    var LABELS = { idle: "入库", pending: "入库中", done: "已入库" };
    var ID = /^\/paper\/([^/?#]+)/;
    var idFromPath = function (path) {
      var match = ID.exec(path || "");
      if (!match) return null;
      try {
        return decodeURIComponent(match[1]);
      } catch (e) {
        return null;
      }
    };
    var setLabel = function (el, text) {
      var label = el.querySelector(".agentero-import-label");
      if (label) label.textContent = text;
    };
    // A reload rebuilds every button as idle, so remember what the library
    // already has and ask the host again after each load.
    var knownImported = {};
    var askedImported = {};
    var markDone = function (el) {
      el.dataset.state = "done";
      setLabel(el, LABELS.done);
    };
    var applyKnown = function () {
      var buttons = document.querySelectorAll(".agentero-import");
      for (var i = 0; i < buttons.length; i++) {
        if (knownImported[buttons[i].dataset.paperId]) markDone(buttons[i]);
      }
    };
    var requestKnown = function () {
      var ids = [];
      var seen = {};
      var buttons = document.querySelectorAll(".agentero-import");
      for (var i = 0; i < buttons.length && ids.length < 200; i++) {
        var id = buttons[i].dataset.paperId;
        if (!id || knownImported[id] || askedImported[id] || seen[id]) continue;
        seen[id] = true;
        askedImported[id] = true;
        ids.push(id);
      }
      if (ids.length) post({ queryImported: ids });
    };
    var button = function (id, title) {
      var el = document.createElement("button");
      el.type = "button";
      el.className = "agentero-import";
      el.title = "导入到我的论文库";
      el.dataset.paperId = id;
      if (title) el.dataset.paperTitle = title;
      el.innerHTML = '<span class="agentero-import-label">' + LABELS.idle + "</span>";
      return el;
    };
    var decorate = function () {
      var cards = document.querySelectorAll("article.paper-card");
      for (var i = 0; i < cards.length; i++) {
        var card = cards[i];
        var title = card.querySelector("h3.paper-title");
        if (!title || title.querySelector(".agentero-import")) continue;
        var link = title.querySelector('a[href^="/paper/"]');
        if (!link) continue;
        var id = idFromPath(link.getAttribute("href"));
        if (!id) continue;
        var text = (link.textContent || "").trim();
        title.appendChild(button(id, text));
      }

      // Detail page: the hero's action row is a stable hook.
      var row = document.querySelector(".action-row");
      if (row && !row.querySelector(".agentero-import")) {
        var detailId = idFromPath(location.pathname);
        if (detailId) {
          var heading = document.querySelector("h1, .detail-title");
          row.appendChild(button(detailId, heading ? heading.textContent.trim() : null));
        }
      }

      applyKnown();
      requestKnown();
    };
    var scheduled = false;
    var scheduleDecorating = function () {
      if (scheduled) return;
      scheduled = true;
      setTimeout(function () {
        scheduled = false;
        try {
          decorate();
        } catch (e) {}
      }, 180);
    };
    // Cards arrive after hydration and on every route change / pagination.
    var observer = new MutationObserver(scheduleDecorating);
    observer.observe(document.documentElement, { childList: true, subtree: true });

    window.addEventListener("message", function (event) {
      var data = event.data;
      if (!data || data.source !== "agentero-plaza-host") return;
      if (Array.isArray(data.importedIds)) {
        for (var n = 0; n < data.importedIds.length; n++) {
          if (typeof data.importedIds[n] === "string") {
            knownImported[data.importedIds[n]] = true;
          }
        }
        applyKnown();
      }
      if (typeof data.importedId !== "string") return;
      // Ids contain dots, so id-based DOM lookups are out.
      var buttons = document.querySelectorAll(".agentero-import");
      for (var i = 0; i < buttons.length; i++) {
        var el = buttons[i];
        if (el.dataset.paperId !== data.importedId) continue;
        if (data.ok) {
          knownImported[data.importedId] = true;
          markDone(el);
        } else {
          delete el.dataset.state;
          setLabel(el, LABELS.idle);
        }
      }
    });

    decorate();
    send();
    setTimeout(send, 120);
  } catch (e) {}
})();
</script>"##;

fn rewrite(html: &str) -> String {
    let html = crate::features::web::proxy::inject_selection_bridge(html);
    let html = html.as_str();
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
        let html = r#"<html><head><link rel="canonical" href="https://paperswithcode.co/conferences"></head><body><article class="paper-card"><h3 class="paper-title"><a href="/paper/2512.14692">x</a></h3></article></body></html>"#;
        let out = rewrite(html);
        assert!(out.contains("agentero-plaza"));
        assert!(out.contains(r#"href="/paper/2512.14692""#));
        assert!(!out.contains("https://paperswithcode.co/paper/2512.14692"));
        // Exactly one bridge, before the document body.
        assert_eq!(
            out.matches(r#"message.source = "agentero-plaza";"#).count(),
            1
        );
        assert!(out.find("agentero-plaza").unwrap() < out.find("</head>").unwrap());
    }

    #[test]
    fn ships_the_import_affordance() {
        let out = rewrite("<html><head></head><body></body></html>");
        assert!(out.contains("agentero-import"));
        assert!(out.contains("importPaper"));
        assert!(out.contains("queryImported"));
        assert!(out.contains("importedIds"));
        // Settled from the app so a row can show 已入库 / stay retryable.
        assert!(out.contains("agentero-plaza-host"));
        // Card and detail hooks are the only selectors the bridge relies on.
        assert!(out.contains("article.paper-card"));
        assert!(out.contains("h3.paper-title"));
        assert!(out.contains(".action-row"));
    }

    #[test]
    fn observes_spa_routing() {
        let out = rewrite("<html><head></head><body></body></html>");
        assert!(out.contains("pushState"));
        assert!(out.contains("replaceState"));
        assert!(out.contains("popstate"));
    }

    #[test]
    fn prepends_bridge_when_head_is_missing() {
        let out = rewrite("<div>fragment</div>");
        assert!(out.starts_with("<style>"));
    }
}

//! Sandboxed papers.cool proxy for the 广场 Cool Papers panel.
//!
//! The site marks nearly every link `target="_blank"`, which inside a plain
//! cross-origin iframe either spawns a separate window or silently does nothing,
//! and leaves no way to go back. Serving it through our own scheme makes the
//! frame same-origin, so we can retarget links to navigate in place and report
//! each navigation to the panel for a real history stack.
//!
//! Request plumbing lives in [`crate::features::site_proxy`]; only the site's own
//! HTML rewrite and injected bridge are here.

use crate::features::site_proxy::SiteProxy;

/// Reports navigations to the panel (for Back / Forward), hands off links that
/// leave our origin, and adds an `[入库]` action to every paper row.
const NAV_BRIDGE: &str = r##"<style>
.title-import { color: #0a7a5a; cursor: pointer; }
.title-import[data-state="pending"] { color: #999; cursor: default; }
.title-import[data-state="done"] { color: #888; cursor: default; }
</style>
<script>
(function () {
  try {
    // Only the panel's own frame talks to the app. A nested frame (the pdf.js
    // viewer) has a same-origin, readable parent — leave those uninstrumented.
    try {
      if (parent !== window && parent.location.href) return;
    } catch (e) {}
    var post = function (message) {
      message.source = "agentero-plaza";
      parent.postMessage(message, "*");
    };
    var send = function () {
      post({ path: location.pathname + location.search });
    };
    send();
    window.addEventListener("pageshow", send);
    var isFeed = function (url) {
      return /\/feed\/?$/.test(url.pathname);
    };
    // Same-origin URLs must be reopened upstream: the system browser cannot
    // resolve our private scheme.
    var handoff = function (url) {
      if (url.origin === location.origin) {
        post({ externalPath: url.pathname + url.search });
      } else {
        post({ external: url.href });
      }
    };
    document.addEventListener(
      "click",
      function (event) {
        var anchor = event.target && event.target.closest
          ? event.target.closest("a[href]")
          : null;
        if (!anchor) return;
        var raw = anchor.getAttribute("href");
        if (!raw || raw.charAt(0) === "#") return;
        if (raw.toLowerCase().indexOf("javascript:") === 0) return;
        var url;
        try {
          url = new URL(anchor.href, location.href);
        } catch (e) {
          return;
        }
        // Site pages navigate in place; feeds and third-party sites do not.
        if (url.origin === location.origin && !isFeed(url)) return;
        event.preventDefault();
        handoff(url);
      },
      true
    );

    // Every scripted navigation in cool.js goes through window.open — search,
    // related papers, sort, feed, export, arXiv calendar — and most pass
    // "_blank". Without allow-popups those calls are silently dropped, so route
    // them here instead. Installed from <head>, before cool.js loads.
    window.open = function (url) {
      var resolved;
      try {
        resolved = new URL(url, location.href);
      } catch (e) {
        return null;
      }
      if (resolved.origin !== location.origin || isFeed(resolved)) {
        handoff(resolved);
        return null;
      }
      location.assign(resolved.href);
      return null;
    };

    // ---- [入库] ----------------------------------------------------------
    // The `#N` index anchor is the upstream landing page on every branch
    // (arxiv.org / OJS / OpenReview / ACL Anthology), which is what the
    // importer resolves. No href on our own anchor, so the interceptor
    // above ignores it.
    var upstreamUrl = function (panel) {
      var index = panel.querySelector(".index");
      var anchor = index && index.closest ? index.closest("a[href]") : null;
      if (!anchor) anchor = panel.querySelector("h2.title a[href]");
      return anchor ? anchor.href : null;
    };
    var setState = function (button, state, label) {
      button.dataset.state = state;
      button.textContent = label;
    };
    var decorate = function (panel) {
      if (!panel || panel.querySelector(".title-import")) return;
      var title = panel.querySelector("h2.title");
      if (!title) return;
      var url = upstreamUrl(panel);
      if (!url) return;
      var button = document.createElement("a");
      button.className = "title-import notranslate";
      button.textContent = "[入库]";
      button.title = "导入到我的论文库";
      button.dataset.paperId = panel.id;
      button.dataset.url = url;
      title.appendChild(document.createTextNode(" "));
      title.appendChild(button);
    };
    var decorateAll = function (root) {
      var panels = (root || document).querySelectorAll(".panel.paper");
      for (var i = 0; i < panels.length; i++) decorate(panels[i]);
    };
    // Injected into <head>, so the body does not exist yet: sweeping now would
    // find no rows and `.papers` would be null (observer never attaches).
    var start = function () {
      decorateAll(document);
      // Infinite scroll appends more rows.
      var papers = document.querySelector(".papers");
      if (papers && window.MutationObserver) {
        new MutationObserver(function (records) {
          for (var i = 0; i < records.length; i++) {
            var added = records[i].addedNodes;
            for (var j = 0; j < added.length; j++) {
              var node = added[j];
              if (node.nodeType !== 1) continue;
              if (node.classList && node.classList.contains("paper")) decorate(node);
              else decorateAll(node);
            }
          }
        }).observe(papers, { childList: true });
      }
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start);
    } else {
      start();
    }

    document.addEventListener("click", function (event) {
      var button = event.target && event.target.closest
        ? event.target.closest(".title-import")
        : null;
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      if (button.dataset.state) return;
      var titleLink = document.getElementById("title-" + button.dataset.paperId);
      setState(button, "pending", "[入库中]");
      post({
        importPaper: {
          id: button.dataset.paperId,
          branch: document.body.id || "",
          url: button.dataset.url,
          title: titleLink ? titleLink.textContent.trim() : null
        }
      });
    });

    window.addEventListener("message", function (event) {
      var data = event.data;
      if (!data || data.source !== "agentero-plaza-host") return;
      if (typeof data.importedId !== "string") return;
      var panel = document.getElementById(data.importedId);
      var button = panel ? panel.querySelector(".title-import") : null;
      if (!button) return;
      if (data.ok) {
        button.dataset.state = "done";
        button.textContent = "[已入库]";
      } else {
        delete button.dataset.state;
        button.textContent = "[入库]";
      }
    });
  } catch (e) {}
})();
</script>"##;

/// Keep every click inside the frame and keep internal links on this scheme.
fn rewrite_html(html: &str) -> String {
    let retargeted = html
        .replace("target=\"_blank\"", "target=\"_self\"")
        .replace("target='_blank'", "target='_self'")
        // Absolute self-links would leave the proxy scheme behind.
        .replace(&format!("{}/", super::ORIGIN), "/");
    match retargeted.find("</head>") {
        Some(_) => retargeted.replacen("</head>", &format!("{NAV_BRIDGE}</head>"), 1),
        None => format!("{NAV_BRIDGE}{retargeted}"),
    }
}

static SITE: SiteProxy = SiteProxy {
    label: "Cool Papers",
    origin: super::ORIGIN,
    user_agent: super::USER_AGENT,
    rewrite: rewrite_html,
};

pub fn handle(request: tauri::http::Request<Vec<u8>>, responder: tauri::UriSchemeResponder) {
    crate::features::site_proxy::handle(&SITE, request, responder);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retargets_blank_links_so_they_open_in_frame() {
        let out = rewrite_html("<a href=\"/arxiv/cs.AI\" target=\"_blank\">x</a>");
        assert!(out.contains("target=\"_self\""));
        // The bridge's own source mentions _blank, so check the attribute form.
        assert!(!out.contains("target=\"_blank\""));
        assert!(!out.contains("target='_blank'"));
    }

    #[test]
    fn rewrites_absolute_self_links_to_stay_on_the_proxy() {
        let out = rewrite_html("<a href=\"https://papers.cool/arxiv/2608.13558\">x</a>");
        assert!(out.contains("href=\"/arxiv/2608.13558\""));
        assert!(!out.contains("https://papers.cool/"));
    }

    #[test]
    fn leaves_third_party_links_alone() {
        let out = rewrite_html("<a href=\"https://arxiv.org/abs/1706.03762\">x</a>");
        assert!(out.contains("https://arxiv.org/abs/1706.03762"));
    }

    #[test]
    fn injects_nav_bridge_before_head_close() {
        let out = rewrite_html("<html><head><title>t</title></head><body></body></html>");
        assert!(out.contains("agentero-plaza"));
        let script = out.find("agentero-plaza").expect("bridge present");
        let head_end = out.find("</head>").expect("head close present");
        assert!(script < head_end);
    }

    #[test]
    fn injects_nav_bridge_even_without_a_head() {
        let out = rewrite_html("<p>fragment</p>");
        assert!(out.contains("agentero-plaza"));
        assert!(out.contains("<p>fragment</p>"));
    }

    #[test]
    fn ships_the_import_affordance() {
        let out = rewrite_html("<!DOCTYPE html><html><head></head><body></body></html>");
        assert!(out.contains("title-import"));
        assert!(out.contains("importPaper"));
        // Settled from the app so a row can show 已入库 / stay retryable.
        assert!(out.contains("agentero-plaza-host"));
    }

    /// The bridge lands in `<head>`, where the body does not exist yet: decorating
    /// rows there finds nothing and leaves the scroll observer unattached.
    #[test]
    fn defers_row_decoration_until_the_dom_exists() {
        assert!(NAV_BRIDGE.contains("DOMContentLoaded"));
        assert!(NAV_BRIDGE.contains("document.readyState"));
    }

    /// Search, related papers, sort, export and the arXiv calendar all navigate
    /// through `window.open`, which the sandbox drops without `allow-popups`.
    #[test]
    fn routes_scripted_navigation_through_a_patched_window_open() {
        assert!(NAV_BRIDGE.contains("window.open = function"));
        assert!(NAV_BRIDGE.contains("location.assign"));
        // Feeds and same-origin handoffs reopen upstream, not on our scheme.
        assert!(NAV_BRIDGE.contains("isFeed"));
        assert!(NAV_BRIDGE.contains("externalPath"));
    }
}

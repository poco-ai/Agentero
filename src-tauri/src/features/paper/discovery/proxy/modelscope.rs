//! Sandboxed modelscope.cn proxy for the 广场 ModelScope 论文 panel.
//!
//! The site answers `X-Frame-Options: SAMEORIGIN`, so a plain iframe is refused
//! outright; serving it under our own scheme both drops that header and makes the
//! frame same-origin, which is what lets the bridge report navigations and keep
//! clicks in place.
//!
//! Unlike papers.cool this is a client-rendered umi SPA, which forces two things
//! the server-rendered sources do not need: the shell's protocol-relative CDN
//! assets must be made absolute, and routing has to be observed through
//! `pushState` because a card click never becomes a real navigation.
//!
//! Request plumbing lives in [`crate::features::paper::discovery::proxy`].

use crate::features::paper::discovery::proxy::SiteProxy;

const ORIGIN: &str = "https://modelscope.cn";
const USER_AGENT: &str = "agentero/0.6 (+https://github.com/poco-ai/agentero)";

/// Hides the site chrome, reports navigations, hands off everything that leaves
/// the paper feed, and adds an `[入库]` action to every paper.
///
/// Selectors here are limited to stable hooks (`header.antd5-layout-header`,
/// `a[href^="/papers/"]`, the arXiv landing link, `.ms-page-container`). The
/// site's Emotion classes (`acss-*`) are content-hashed per release and must
/// never be matched on.
///
/// The site pins its paper pages at a 1280px desktop width, so the panel browses
/// it as a narrow desktop window: the frame keeps that layout and its own
/// document is the horizontal scrollport, which is what lets a trackpad pan the
/// page. Clamping the pages to the panel instead would leave no overflow to pan.
const NAV_BRIDGE: &str = r##"<style>
/* The panel is a paper feed, not a browser: the global nav only offers ways out. */
header.antd5-layout-header { display: none !important; }
/* ModelScope shows an onboarding tour that locks body scrolling and dims the feed.
   The panel is for browsing papers; suppress the tour entirely. */
.antd5-tour,
.antd5-tour-mask,
.antd5-tour-target-placeholder { display: none !important; }
/* The tour injects `html body { overflow-y: hidden }` via a runtime style tag. */
html body { overflow-y: visible !important; }
/* The site smooth-scrolls its layout root while centring a page action; the
   bridge re-pins that root, and a running smooth animation would win. */
.ms-page-container { scroll-behavior: auto !important; }
.agentero-import {
  cursor: pointer;
  user-select: none;
}
.agentero-import[data-state] { cursor: default; opacity: 0.55; }
.agentero-import-logo {
  width: 14px;
  height: 14px;
  flex: none;
  margin-right: 3px;
}
.agentero-import-titlerow {
  display: flex;
  /* The title is a fixed two-line-tall box holding one line at the top, so
     centring against it would sit the button well below the text. */
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}
/* The title keeps its own width clamp and ellipsis; the button never shrinks. */
.agentero-import-titlerow > :first-child { flex: 0 1 auto; min-width: 0; }
.agentero-import-card {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* Replaced with the title's own line-height, which centres it on the text. */
  height: 20px;
  padding: 0 8px;
  border: 1px solid rgba(128, 128, 128, 0.35);
  border-radius: 6px;
  background: rgba(128, 128, 128, 0.12);
  color: inherit;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
}
.agentero-import-card:hover { background: rgba(128, 128, 128, 0.22); }
</style>
<script>
(function () {
  try {
    // Only the panel's own frame talks to the app; a nested same-origin frame has
    // a readable parent and stays uninstrumented.
    try {
      if (parent !== window && parent.location.href) return;
    } catch (e) {}
    var post = function (message) {
      message.source = "agentero-plaza";
      parent.postMessage(message, "*");
    };
    // Only the paper feed browses in place. Everything else — the site's other
    // sections, and the separately hosted login flow — belongs outside, where the
    // user has their real session.
    var allowed = function (url) {
      return url.origin === location.origin && /^\/papers(\/|$)/.test(url.pathname);
    };
    var send = function () {
      post({ path: location.pathname + location.search });
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
    send();
    window.addEventListener("pageshow", send);
    window.addEventListener("popstate", send);

    // umi routes through pushState, so clicking a card fires no navigation event
    // at all. Installed from <head>, before umi captures its history reference.
    ["pushState", "replaceState"].forEach(function (name) {
      var original = history[name];
      history[name] = function (state, title, url) {
        if (url != null) {
          var target = null;
          try {
            target = new URL(url, location.href);
          } catch (e) {}
          if (target && !allowed(target)) {
            handoff(target);
            return;
          }
        }
        var result = original.apply(history, arguments);
        send();
        return result;
      };
    });

    // ---- [入库] ----------------------------------------------------------
    // `/papers/<arxivId>` is the entire identity needed: the importer resolves the
    // arXiv landing page, which additionally yields arxiv_id and the LaTeX source.
    // A single segment only — the detail page's own tabs are `/papers/<id>/summary`
    // and `/papers/<id>/feedback`, which would otherwise import as paper ids.
    var ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
    var paperId = function (pathname) {
      var match = /^\/papers\/(.+)$/.exec(pathname);
      if (!match) return null;
      var id = match[1].replace(/\/+$/, "");
      return ID.test(id) ? id : null;
    };
    var LABELS = { idle: "入库", pending: "入库中", done: "已入库" };
    // The Agentero mark reduced to its copper spectacles: the full illustrated
    // face is unreadable mush at the 14px the site's button icons use.
    var LOGO =
      '<svg class="agentero-import-logo" viewBox="0 0 16 16" aria-hidden="true">' +
      '<g fill="none" stroke="#B96442" stroke-width="1.35" stroke-linecap="round">' +
      '<circle cx="4.3" cy="8.4" r="4.1"/>' +
      '<circle cx="11.7" cy="8.4" r="4.1"/>' +
      '<path d="M7.6 7.2c.3-.35.8-.35 1.1 0"/>' +
      "</g></svg>";
    var setLabel = function (el, text) {
      var label = el.querySelector(".agentero-import-label");
      if (label) label.textContent = text;
    };
    var button = function (id, variant, borrowedClass) {
      var el = document.createElement(variant === "action" ? "div" : "span");
      el.className =
        "agentero-import agentero-import-" +
        variant +
        (borrowedClass ? " " + borrowedClass : "");
      el.title = "导入到我的论文库";
      el.setAttribute("role", "button");
      el.dataset.paperId = id;
      el.innerHTML =
        LOGO + '<span class="agentero-import-label">' + LABELS.idle + "</span>";
      return el;
    };
    // The card title is the first text-bearing leaf block inside it — the site's
    // own classes are content-hashed. Needing one also keeps the decorator off
    // plain nav anchors, whose text sits directly on the anchor.
    var titleOf = function (card) {
      var nodes = card.querySelectorAll("div");
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].children.length) continue;
        if ((nodes[i].textContent || "").trim()) return nodes[i];
      }
      return null;
    };
    var decorate = function () {
      var cards = document.querySelectorAll('a[href^="/papers/"]');
      for (var i = 0; i < cards.length; i++) {
        var card = cards[i];
        if (card.querySelector(".agentero-import")) continue;
        var path = null;
        try {
          path = new URL(card.href, location.href).pathname;
        } catch (e) {}
        // An anchor to the page already open is the detail tab strip, not a card;
        // decorating it drops a button on top of the tab label.
        if (!path || path === location.pathname) continue;
        var id = paperId(path);
        if (!id) continue;
        var title = titleOf(card);
        if (!title || !title.parentNode) continue;
        // The title is width-clamped with an ellipsis, so the button cannot live
        // inside it; give the pair a flex row. Re-created if React undoes it.
        var titleRow = document.createElement("div");
        titleRow.className = "agentero-import-titlerow";
        title.parentNode.insertBefore(titleRow, title);
        titleRow.appendChild(title);
        var cardButton = button(id, "card");
        // Match the title's line box so the button centres on the text. A
        // `normal` line-height is not a length, so the CSS fallback stands.
        var lineHeight = getComputedStyle(title).lineHeight;
        if (/^[\d.]+px$/.test(lineHeight)) cardButton.style.height = lineHeight;
        titleRow.appendChild(cardButton);
      }
      var current = paperId(location.pathname);
      if (!current) return;
      // Sit beside the detail page's own 「arXiv 原文 / PDF / Git」 actions, wearing
      // their classes. The row is found through the arXiv favicon: its classes are
      // content-hashed and its label is localized, but the icon's src is neither.
      var icon = document.querySelector('img[src*="arxiv.org"]');
      var arxivAction = icon && icon.parentElement;
      var row = arxivAction && arxivAction.parentNode;
      if (!row || row.querySelector(".agentero-import-action")) return;
      row.insertBefore(
        button(current, "action", arxivAction.className),
        arxivAction
      );
    };
    // React re-renders wipe injected nodes, and the feed also paginates in place.
    var scheduled = false;
    var schedule = function () {
      if (scheduled) return;
      scheduled = true;
      setTimeout(function () {
        scheduled = false;
        decorate();
      }, 100);
    };
    var start = function () {
      decorate();
      if (window.MutationObserver) {
        new MutationObserver(schedule).observe(document.body, {
          childList: true,
          subtree: true
        });
      }
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start);
    } else {
      start();
    }

    // Registered before the link interceptor below: a card's button sits *inside*
    // the card's own anchor, so this click must be swallowed whole or the router
    // navigates away under the import.
    document.addEventListener(
      "click",
      function (event) {
        var target = event.target && event.target.closest
          ? event.target.closest(".agentero-import")
          : null;
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (target.dataset.state) return;
        var id = target.dataset.paperId;
        target.dataset.state = "pending";
        setLabel(target, LABELS.pending);
        post({
          importPaper: {
            id: id,
            branch: "arxiv",
            url: "https://arxiv.org/abs/" + id,
            title: null
          }
        });
      },
      true
    );

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
        if (allowed(url)) return;
        event.preventDefault();
        // preventDefault alone does not stop umi's own Link handler from routing.
        event.stopPropagation();
        event.stopImmediatePropagation();
        handoff(url);
      },
      true
    );

    // ModelScope centres a page action with
    // `scrollIntoView({ block: "center", inline: "center" })`. The frame is
    // narrower than the site's 1280px desktop layout, so that call drags the
    // whole document sideways and the feed loads scrolled past its left edge
    // (#550). The panel is panned by the user, not by the site: undo the
    // horizontal part of every such call, leaving vertical scrolling alone.
    var scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function () {
      var chain = [];
      for (var node = this; node; node = node.parentElement) chain.push(node);
      chain.push(document.scrollingElement);
      var before = [];
      for (var i = 0; i < chain.length; i++) {
        before.push(chain[i] ? chain[i].scrollLeft : 0);
      }
      var result = scrollIntoView.apply(this, arguments);
      for (var j = 0; j < chain.length; j++) {
        if (chain[j] && chain[j].scrollLeft !== before[j]) {
          chain[j].scrollLeft = before[j];
        }
      }
      return result;
    };

    // The frame owns horizontal panning: nothing outside an iframe reliably
    // receives its wheel deltas, and the frame is narrower than the site's
    // desktop layout. Trackpad swipes, and Shift+wheel (a keyboard reports that
    // as deltaY), pan the document — but the event is never cancelled, so a
    // diagonal gesture keeps scrolling vertically too. An engine that pans
    // horizontally on its own is left to it: the delta is only added when the
    // document did not move. An in-page horizontal scroller (a carousel) wins.
    var scrollsHorizontally = function (node) {
      while (node && node.nodeType === 1 && node !== document.documentElement) {
        var overflow = getComputedStyle(node).overflowX;
        if (
          (overflow === "auto" || overflow === "scroll" || overflow === "overlay") &&
          node.scrollWidth > node.clientWidth + 1
        ) {
          return true;
        }
        node = node.parentElement;
      }
      return false;
    };
    var panFrame = 0;
    var panPending = 0;
    var panStart = null;
    document.addEventListener("wheel", function (event) {
      if (event.ctrlKey || event.deltaMode === 2) return;
      var scroller = document.scrollingElement || document.documentElement;
      if (!scroller || scroller.scrollWidth <= scroller.clientWidth + 1) return;
      if (scrollsHorizontally(event.target)) return;
      var dx = event.deltaX;
      if (!dx && event.shiftKey) dx = event.deltaY;
      if (!dx) return;
      if (event.deltaMode === 1) dx *= 16;
      if (panStart === null) panStart = scroller.scrollLeft;
      panPending += dx;
      if (panFrame) return;
      panFrame = requestAnimationFrame(function () {
        panFrame = 0;
        var moved = scroller.scrollLeft - panStart;
        var delta = panPending;
        panStart = null;
        panPending = 0;
        if (!moved) scroller.scrollLeft += delta;
      });
    });

    // The site's own layout root is a scroll container as well (`overflow-x:
    // hidden` next to `overflow-y: overlay`, which stays scrollable in script).
    // The browser parks it 10px to the right, shaving the card gutter off the
    // left edge; it is never meant to scroll, so pin it.
    document.addEventListener(
      "scroll",
      function (event) {
        var node = event.target;
        if (
          node &&
          node.classList &&
          node.classList.contains("ms-page-container") &&
          node.scrollLeft
        ) {
          node.scrollLeft = 0;
        }
      },
      true
    );

    // Without allow-popups these calls are silently dropped by the sandbox.
    window.open = function (url) {
      var resolved;
      try {
        resolved = new URL(url, location.href);
      } catch (e) {
        return null;
      }
      if (!allowed(resolved)) {
        handoff(resolved);
        return null;
      }
      location.assign(resolved.href);
      return null;
    };

    window.addEventListener("message", function (event) {
      var data = event.data;
      if (!data || data.source !== "agentero-plaza-host") return;
      if (typeof data.importedId !== "string") return;
      // arXiv ids contain dots, so id-based DOM lookups are out.
      var buttons = document.querySelectorAll(".agentero-import");
      for (var i = 0; i < buttons.length; i++) {
        var el = buttons[i];
        if (el.dataset.paperId !== data.importedId) continue;
        if (data.ok) {
          el.dataset.state = "done";
          setLabel(el, LABELS.done);
        } else {
          delete el.dataset.state;
          setLabel(el, LABELS.idle);
        }
      }
    });
  } catch (e) {}
})();
</script>"##;

/// Make the shell's CDN references absolute, then inject the bridge.
///
/// Every asset in the shell is protocol-relative (`//g.alicdn.com/…`), including
/// the `publicPath` umi resolves its async chunks against. Left alone they
/// resolve to `agentero-modelscope://g.alicdn.com/…` under our scheme and the
/// application never boots.
fn rewrite_html(html: &str) -> String {
    let absolute = html
        .replace("=\"//", "=\"https://")
        .replace("='//", "='https://")
        // `window.publicPath = "//g.alicdn.com/sail-web/maas/<version>/"`.
        .replace("= \"//", "= \"https://");
    match absolute.find("</head>") {
        Some(_) => absolute.replacen("</head>", &format!("{NAV_BRIDGE}</head>"), 1),
        None => format!("{NAV_BRIDGE}{absolute}"),
    }
}

static SITE: SiteProxy = SiteProxy {
    label: "ModelScope",
    origin: ORIGIN,
    user_agent: USER_AGENT,
    rewrite: rewrite_html,
};

pub fn handle(request: tauri::http::Request<Vec<u8>>, responder: tauri::UriSchemeResponder) {
    crate::features::paper::discovery::proxy::handle(&SITE, request, responder);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absolutizes_protocol_relative_assets() {
        let out = rewrite_html(
            "<html><head><script src=\"//g.alicdn.com/sail-web/maas/2.13.127/umi.js\"></script></head></html>",
        );
        assert!(out.contains("src=\"https://g.alicdn.com/sail-web/maas/2.13.127/umi.js\""));
        assert!(!out.contains("src=\"//g.alicdn.com"));
    }

    /// umi resolves every async chunk against this, so a broken value leaves the
    /// panel on an empty `<div id="root">`.
    #[test]
    fn absolutizes_the_umi_public_path() {
        let out = rewrite_html(
            "<html><head><script>window.publicPath = \"//g.alicdn.com/sail-web/maas/2.13.127/\";</script></head></html>",
        );
        assert!(
            out.contains("window.publicPath = \"https://g.alicdn.com/sail-web/maas/2.13.127/\"")
        );
    }

    #[test]
    fn leaves_absolute_urls_alone() {
        let out = rewrite_html(
            "<html><head><a href=\"https://arxiv.org/abs/2307.13826\">x</a></head></html>",
        );
        assert!(out.contains("href=\"https://arxiv.org/abs/2307.13826\""));
        assert!(!out.contains("https://https://"));
    }

    #[test]
    fn injects_the_bridge_before_head_close() {
        let out = rewrite_html("<html><head><title>t</title></head><body></body></html>");
        let script = out.find("agentero-plaza").expect("bridge present");
        let head_end = out.find("</head>").expect("head close present");
        assert!(script < head_end);
    }

    #[test]
    fn injects_the_bridge_even_without_a_head() {
        let out = rewrite_html("<p>fragment</p>");
        assert!(out.contains("agentero-plaza"));
        assert!(out.contains("<p>fragment</p>"));
    }

    /// The site's own nav is the only route out of the paper feed, and it also
    /// carries the login entry point we deliberately do not support.
    #[test]
    fn hides_the_site_header() {
        assert!(NAV_BRIDGE.contains("header.antd5-layout-header { display: none !important; }"));
    }

    /// The onboarding tour dims the page and injects `body { overflow-y: hidden }`,
    /// which locks the paper feed. Hide the tour and keep the body scrollable.
    #[test]
    fn suppresses_onboarding_tour_and_keeps_body_scrollable() {
        assert!(NAV_BRIDGE.contains(".antd5-tour"));
        assert!(NAV_BRIDGE.contains(".antd5-tour-mask"));
        assert!(NAV_BRIDGE.contains("display: none !important"));
        assert!(NAV_BRIDGE.contains("html body { overflow-y: visible !important; }"));
    }

    /// The panel browses the site as a narrow desktop window: the frame keeps
    /// the 1280px layout and its own document is the horizontal scrollport, so a
    /// trackpad pans it. Clamping the pages to the panel would leave no
    /// horizontal overflow — and nothing to pan.
    #[test]
    fn keeps_the_desktop_layout_pannable() {
        assert!(!NAV_BRIDGE.contains("min-width: 0 !important"));
        assert!(!NAV_BRIDGE.contains("max-width: 100% !important"));
    }

    /// ModelScope centres a page action with
    /// `scrollIntoView({ block: "center", inline: "center" })`, which dragged the
    /// document right and hid the left edge (#550). Horizontal self-panning is
    /// undone; vertical scrolling must survive.
    #[test]
    fn undoes_programmatic_horizontal_panning() {
        assert!(NAV_BRIDGE.contains("Element.prototype.scrollIntoView = function"));
        assert!(NAV_BRIDGE.contains("chain[j].scrollLeft = before[j]"));
    }

    /// Nothing outside the frame reliably receives its wheel deltas, so the
    /// bridge pans horizontally itself — while never cancelling the event, and
    /// only when the engine did not already pan (a diagonal gesture must keep
    /// scrolling vertically). An in-page scroller keeps priority.
    #[test]
    fn pans_horizontally_without_cancelling_the_wheel() {
        assert!(NAV_BRIDGE.contains("scrollsHorizontally(event.target)"));
        assert!(NAV_BRIDGE.contains("if (!moved) scroller.scrollLeft += delta;"));
    }

    /// The site's own layout root is scrollable in script and gets parked 10px to
    /// the right, shaving the card gutter off the left edge. Pin it.
    #[test]
    fn pins_the_sites_own_layout_root() {
        assert!(NAV_BRIDGE.contains("classList.contains(\"ms-page-container\")"));
    }

    /// A card click is a pushState route, not a navigation: without these the
    /// panel's path readout and Back / Forward never move.
    #[test]
    fn observes_spa_routing() {
        assert!(NAV_BRIDGE.contains("pushState"));
        assert!(NAV_BRIDGE.contains("replaceState"));
        assert!(NAV_BRIDGE.contains("popstate"));
    }

    /// Only `/papers*` browses in place; same-origin sections hand off through
    /// `externalPath` because the browser cannot resolve our scheme.
    #[test]
    fn confines_in_frame_navigation_to_the_paper_feed() {
        assert!(NAV_BRIDGE.contains("/^\\/papers(\\/|$)/"));
        assert!(NAV_BRIDGE.contains("externalPath"));
        assert!(NAV_BRIDGE.contains("window.open = function"));
    }

    /// umi's `Link` calls `preventDefault` itself and routes regardless, so a
    /// rejected click has to stop propagating before React ever sees it.
    #[test]
    fn stops_rejected_clicks_from_reaching_the_router() {
        assert!(NAV_BRIDGE.contains("stopImmediatePropagation"));
    }

    #[test]
    fn ships_the_import_affordance() {
        assert!(NAV_BRIDGE.contains("agentero-import"));
        assert!(NAV_BRIDGE.contains("importPaper"));
        assert!(NAV_BRIDGE.contains("https://arxiv.org/abs/"));
        // Settled from the app so a row can show 已入库 / stay retryable.
        assert!(NAV_BRIDGE.contains("agentero-plaza-host"));
    }

    /// Absolute positioning against the card's own anchor is ill-defined: the
    /// anchor is `display: inline` but wraps block content, so the containing
    /// block resolves to its box in Chromium but to its zero-width leading line
    /// box in WKWebView, which flings the button to the container's edge.
    #[test]
    fn keeps_the_card_button_in_normal_flow_beside_the_title() {
        assert!(NAV_BRIDGE.contains("agentero-import-titlerow"));
        assert!(NAV_BRIDGE.contains("titleRow.appendChild(title);"));
        assert!(!NAV_BRIDGE.contains("position: absolute"));
    }

    /// The title's box is two line-heights tall but holds a single line at the
    /// top, so `align-items: center` sits the button a whole line below the text.
    #[test]
    fn centres_the_card_button_on_the_title_text() {
        assert!(NAV_BRIDGE.contains("align-items: flex-start;"));
        assert!(NAV_BRIDGE.contains("cardButton.style.height = lineHeight;"));
    }

    /// The title is the only structural handle on a card, and requiring one is
    /// also what keeps the decorator off the site's plain nav anchors.
    #[test]
    fn decorates_only_cards_with_a_title() {
        assert!(NAV_BRIDGE.contains("var titleOf = function (card)"));
        assert!(NAV_BRIDGE.contains("if (!title || !title.parentNode) continue;"));
    }

    /// Both affordances are buttons carrying the Agentero mark, so they read as
    /// ours rather than as one of the site's own actions.
    #[test]
    fn brands_both_buttons_with_the_agentero_mark() {
        assert!(NAV_BRIDGE.contains("agentero-import-logo"));
        // The mark's copper spectacles.
        assert!(NAV_BRIDGE.contains("#B96442"));
        assert!(NAV_BRIDGE.contains("border-radius: 6px;"));
    }

    /// The detail affordance joins the site's own action row and borrows its
    /// classes, so it cannot key off them: the row is reached through the arXiv
    /// favicon, which is neither content-hashed nor localized.
    #[test]
    fn matches_the_detail_action_row_buttons() {
        assert!(NAV_BRIDGE.contains("img[src*=\"arxiv.org\"]"));
        assert!(NAV_BRIDGE.contains("arxivAction.className"));
        assert!(NAV_BRIDGE.contains("row.insertBefore("));
    }

    /// The detail page's tab strip is built from `/papers/<id>`,
    /// `/papers/<id>/summary` and `/papers/<id>/feedback`. Without both guards the
    /// decorator drops buttons on top of the tab labels and offers to import
    /// `<id>/summary`.
    #[test]
    fn keeps_card_buttons_off_the_detail_tab_strip() {
        // Ids are a single path segment: no `/` in the character class.
        assert!(NAV_BRIDGE.contains("var ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;"));
        assert!(NAV_BRIDGE.contains("path === location.pathname"));
    }

    /// The bridge lands in `<head>`, where the body does not exist yet.
    #[test]
    fn defers_decoration_until_the_dom_exists() {
        assert!(NAV_BRIDGE.contains("DOMContentLoaded"));
        assert!(NAV_BRIDGE.contains("MutationObserver"));
    }
}

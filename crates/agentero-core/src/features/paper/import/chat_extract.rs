//! Extract paper identifiers from pasted chat / share-page text (#652).
//!
//! Deterministic scanner (no LLM, no network): matches only unambiguous
//! identifier forms so precision stays high in noisy chat text —
//!
//! - arXiv: `arxiv.org/(abs|pdf|html|src)` URLs (incl. `export.arxiv.org`)
//!   and `arXiv:<id>` mentions
//! - DOI: `doi.org` / `dx.doi.org` / `www.doi.org` URLs, bare
//!   `10.\d{4,9}/…` and `doi:` mentions (validated via [`is_valid_doi`]);
//!   balanced parens/angle brackets survive, trailing sentence punctuation
//!   is trimmed
//! - PMID: `pubmed.ncbi.nlm.nih.gov/<pmid>` URLs and `PMID[: ]<pmid>` mentions
//!
//! Deliberately excluded: bare `2403.15388`-style arXiv numbers — they
//! false-positive heavily in chat text (version strings, page numbers).
//! Duplicates collapse in first-seen order.

use crate::error::AppError;
use crate::features::scholar_api::identifiers::strip_arxiv_version;

/// Identifiers extracted from one blob of text, first-seen order.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct ExtractedIdentifiers {
    /// Version-stripped arXiv ids (e.g. `2403.15388`).
    pub arxiv: Vec<String>,
    /// DOIs without the `https://doi.org/` prefix.
    pub dois: Vec<String>,
    /// Bare PubMed ids.
    pub pmids: Vec<String>,
}

impl ExtractedIdentifiers {
    /// Total identifier count.
    pub fn len(&self) -> usize {
        self.arxiv.len() + self.dois.len() + self.pmids.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Characters that reliably end an identifier inside chat text. `&`/`?`/`=`
/// only occur in URL query strings, never in a DOI suffix or arXiv id, so they
/// end identifiers too — HTML-decoded share pages carry `doi.org/<doi>&amp;…`
/// tracking tails that would otherwise corrupt the extracted DOI. `\` is the
/// markdown-escape residue chatgpt.com share pages leave after identifiers,
/// `*` is bold markup, and identifiers are pure ASCII — private-use code
/// points (e.g. U+E201) inside share pages terminate too.
fn ident_end(c: char) -> bool {
    !c.is_ascii()
        || c.is_whitespace()
        || matches!(
            c,
            '\\' | '&'
                | '?'
                | '='
                | '*'
                | '"'
                | '\''
                | '<'
                | '>'
                | '('
                | ')'
                | '['
                | ']'
                | '{'
                | '}'
                | '|'
                | '`'
                | ','
                | ';'
                | '，'
                | '。'
                | '、'
                | '”'
                | '“'
                | '‘'
                | '’'
                | '（'
                | '）'
                | '：'
                | '；'
                | '！'
                | '？'
        )
}

fn push_unique(list: &mut Vec<String>, value: String) {
    if !value.is_empty() && !list.contains(&value) {
        list.push(value);
    }
}

/// `<YYMM>.<NNNN[N]>` with optional vN. The month half must be 01–12 and the
/// post-dot sequence exactly 4–5 digits — new-style ids are exactly that
/// shape (`2403.1` / `2403.123456` are invalid). Old-style `hep-th/9901001`
/// ids don't match the URL/mention paths at all; documented non-goal.
fn read_arxiv_tail(rest: &str) -> String {
    let yy: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if yy.len() != 4 {
        return String::new();
    }
    let Some(after_dot) = rest[4..].strip_prefix('.') else {
        return String::new();
    };
    // Count ALL consecutive digits first — a 6th digit must invalidate the
    // whole id, not truncate to a valid-looking 5-digit prefix.
    let nn: String = after_dot
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    if !(4..=5).contains(&nn.len()) {
        return String::new();
    }
    let mut out = format!("{yy}.{nn}");
    if let Some(vtail) = after_dot[nn.len()..].strip_prefix('v') {
        let vn: String = vtail.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !vn.is_empty() {
            out.push('v');
            out.push_str(&vn);
        }
    }
    // YYMM: the month half must be 01–12 (kills `2413.xxxx`, `2450.xxxx`).
    let yy_mm: u32 = yy.parse().unwrap_or(0);
    if !(1..=12).contains(&(yy_mm % 100)) {
        return String::new();
    }
    out
}

/// A `needle` occurrence only counts when the character right before it is
/// neither alphanumeric nor `-`/`_`/`.` — kills `notarxiv.org`, `myarxiv:`
/// and `fakedoi.org` lookalikes while still allowing scheme (`://`), path
/// (`/`) and plain line/word starts.
fn host_boundary(hay: &str, idx: usize) -> bool {
    idx == 0
        || hay[..idx]
            .chars()
            .next_back()
            .is_none_or(|c| !c.is_ascii_alphanumeric() && c != '-' && c != '_' && c != '.')
}

/// Invoke `f` on the tail after every boundary-anchored occurrence of
/// `needle` in `hay`.
fn for_each_tail<'a, F: FnMut(&'a str)>(hay: &'a str, needle: &str, mut f: F) {
    let mut from = 0usize;
    while let Some(rel) = hay[from..].find(needle) {
        let abs = from + rel;
        if host_boundary(hay, abs) {
            f(&hay[abs + needle.len()..]);
        }
        from = abs + needle.len();
    }
}

/// Strict DOI shape: `10.\d{4,9}/<non-empty suffix>` with the suffix at least
/// 4 chars — real DOI suffixes never run shorter, while ellipsis-truncated
/// citation cards leave 1–3 char stubs like `10.1088/13` (credit: a second
/// real share link, #814).
fn is_valid_doi(s: &str) -> bool {
    let Some(rest) = s.strip_prefix("10.") else {
        return false;
    };
    let digits = rest.chars().take_while(|c| c.is_ascii_digit()).count();
    if !(4..=9).contains(&digits) {
        return false;
    }
    let suffix = &rest[digits..];
    suffix.starts_with('/') && suffix.len() > 4
}

/// Push a DOI, resolving truncation duplicates: share pages carry
/// ellipsis-truncated copies (`…356682`) of the same DOI, so when the new
/// value and an existing one are prefix-related, keep the longer one.
fn push_unique_doi(list: &mut Vec<String>, value: String) {
    if value.is_empty() {
        return;
    }
    list.retain(|existing| !(value.starts_with(existing.as_str()) && existing.len() < value.len()));
    if !list
        .iter()
        .any(|existing| existing.starts_with(value.as_str()))
    {
        list.push(value);
    }
}

/// Read a DOI tail, keeping balanced parentheses and angle brackets inline —
/// Lancet/Wiley DOIs carry them (`10.1016/S0140-6736(20)30183-5`,
/// `10.1002/(SICI)1097-4636...`). An opener is consumed only when its closer
/// sits within 24 chars with no whitespace inside and real content follows
/// the closer; otherwise the identifier ends there — prose punctuation
/// after a DOI is far more common than unbalanced DOI suffixes. URL
/// fragments (`#`) and query tails (`?`) end the DOI. Trailing sentence
/// punctuation (`.`/`:`/`!`/`'`) is trimmed — sentence-final DOIs are the
/// common case in pasted prose and no real DOI ends in those. SICI-era
/// suffixes get one narrow continuation: a `;` right after `.CO` consumes
/// `;` + digits/hyphens (`3.0.CO;2-9`).
fn read_doi_tail(rest: &str) -> String {
    let chars: Vec<char> = rest.chars().collect();
    let mut out = String::new();
    let mut i = 0usize;
    while i < chars.len() && out.chars().count() < 120 {
        let c = chars[i];
        if c == '(' || c == '<' {
            let closer = if c == '(' { ')' } else { '>' };
            let run = &chars[i + 1..];
            let close_rel = run.iter().position(|&x| x == closer);
            let balanced = close_rel.filter(|&k| {
                k <= 24
                    && run[..k]
                        .iter()
                        .all(|&x| !x.is_whitespace() && x != '(' && x != '<')
                    && i + k + 2 < chars.len()
            });
            match balanced {
                Some(k) => {
                    out.extend(&chars[i..=i + k + 1]);
                    i += k + 2;
                }
                None => break,
            }
            continue;
        }
        if c == ';' && out.ends_with(".co") {
            // SICI continuation: `;` + digits/hyphens, then stop.
            let mut j = i + 1;
            out.push(';');
            while j < chars.len() && (chars[j].is_ascii_digit() || chars[j] == '-') {
                out.push(chars[j]);
                j += 1;
            }
            break;
        }
        if ident_end(c) || c == '#' {
            break;
        }
        out.push(c);
        i += 1;
    }
    // Trim a trailing run of sentence punctuation — no real DOI ends in
    // `.`/`:`/`!`/`'`, and sentence-final DOIs are the common pasted form.
    while out
        .chars()
        .next_back()
        .is_some_and(|c| matches!(c, '.' | ':' | '!' | '\''))
    {
        out.pop();
    }
    out
}

/// Scan chat/share text for paper identifiers.
pub fn extract_identifiers(text: &str) -> ExtractedIdentifiers {
    let mut out = ExtractedIdentifiers::default();
    // Chinese input methods frequently emit a full-width colon after
    // `arXiv`/`PMID` mentions; normalize so both mention forms parse.
    let hay = text
        .to_ascii_lowercase()
        .replace("arxiv：", "arxiv:")
        .replace("pmid：", "pmid:");

    // arXiv URLs: arxiv.org/{abs|pdf|html|src}/<id>. The export mirror needs
    // its own needle — `host_boundary` rejects the `.` in `export.arxiv.org`,
    // which is exactly what keeps lookalike hosts out.
    for_each_tail(&hay, "export.arxiv.org/", |after| {
        if let Some(after) = after.strip_prefix("abs/") {
            let id = read_arxiv_tail(after);
            if !id.is_empty() {
                push_unique(&mut out.arxiv, strip_arxiv_version(&id));
            }
        }
    });
    for_each_tail(&hay, "arxiv.org/", |after| {
        let after = after
            .strip_prefix("abs/")
            .or_else(|| after.strip_prefix("pdf/"))
            .or_else(|| after.strip_prefix("html/"))
            .or_else(|| after.strip_prefix("src/"));
        if let Some(after) = after {
            let id = read_arxiv_tail(after);
            if !id.is_empty() {
                push_unique(&mut out.arxiv, strip_arxiv_version(&id));
            }
        }
    });

    // arXiv: mentions
    for_each_tail(&hay, "arxiv:", |after| {
        let after = after.trim_start_matches(|c: char| c.is_whitespace() || c == '/');
        let id = read_arxiv_tail(after);
        if !id.is_empty() {
            push_unique(&mut out.arxiv, strip_arxiv_version(&id));
        }
    });

    // DOI URLs: doi.org/<doi> plus the dx/www mirrors old citations and
    // Wikipedia still carry — each needs its own needle because
    // `host_boundary` rejects their `.`-prefixed host form.
    for needle in ["doi.org/", "dx.doi.org/", "www.doi.org/"] {
        for_each_tail(&hay, needle, |after| {
            let doi = read_doi_tail(after);
            if is_valid_doi(&doi) {
                push_unique_doi(&mut out.dois, doi);
            }
        });
    }

    // Bare DOIs (incl. `doi:`-prefixed mentions — the prefix ends with a
    // boundary char, so one scanner covers both). Bare `10.\d{4,9}/…`
    // doesn't collide with version strings or page numbers and is common in
    // chat citations (credit @Fengsuid). Bare arXiv numbers stay excluded:
    // they DO collide with version strings and YYMM validation alone is not
    // enough. The preceding char must also not be `/` — a `10.` inside a URL
    // path (possibly on a lookalike host) is not prose.
    {
        let mut from = 0usize;
        while let Some(rel) = hay[from..].find("10.") {
            let abs = from + rel;
            let prev = hay[..abs].chars().next_back();
            // `:<word>10.` only counts when the word is literally `doi`
            // (`doi:10.…` ok, `mydoi:10.…` not).
            let colon_ok = match prev {
                Some(':') => {
                    let word: String = hay[..abs - 1]
                        .chars()
                        .rev()
                        .take_while(|c| c.is_ascii_alphanumeric())
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect();
                    word == "doi"
                }
                _ => true,
            };
            let prev_slash = prev == Some('/');
            if colon_ok && host_boundary(&hay, abs) && !prev_slash {
                let candidate = format!("10.{}", &hay[abs + 3..]);
                let doi = read_doi_tail(&candidate);
                if is_valid_doi(&doi) {
                    push_unique_doi(&mut out.dois, doi);
                }
            }
            from = abs + 3;
        }
    }

    // PubMed URLs — the domain anchor is trustworthy, so the full 1–9 digit
    // range is accepted (PMID 1 exists).
    for_each_tail(&hay, "pubmed.ncbi.nlm.nih.gov/", |after| {
        let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
        if (1..=9).contains(&digits.len()) {
            push_unique(&mut out.pmids, digits);
        }
    });

    // PMID mentions — the prefix anchor makes short ids safe; 4+ digits
    // keeps stray `pmid: 12` counters out.
    for_each_tail(&hay, "pmid", |after| {
        let after = after.trim_start_matches([':', ' ', '\t']);
        let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
        if (4..=9).contains(&digits.len()) {
            push_unique(&mut out.pmids, digits);
        }
    });

    out
}

/// True when `text` is exactly a public AI-chat share URL whose page renders
/// server-side, so a plain HTTP GET yields the conversation text. ChatGPT
/// first (#652); Claude/Gemini share pages need their own adapters and are
/// deliberately not claimed here.
pub fn is_share_url(text: &str) -> bool {
    let t = text.trim();
    if t.contains(char::is_whitespace) {
        return false;
    }
    let lowered = t.to_ascii_lowercase();
    let known = lowered.starts_with("https://chatgpt.com/share/")
        || lowered.starts_with("https://chat.openai.com/share/");
    known && lowered.rsplit('/').next().is_some_and(|id| !id.is_empty())
}

/// chatgpt.com serves Cloudflare challenges to non-browser agents; a desktop
/// Chrome UA passes for share pages (verified against a real share link).
const SHARE_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/// Hard cap on the share page body — real share pages are well under 1 MiB;
/// anything larger is not a conversation page (review point on #814).
const SHARE_MAX_BYTES: usize = 5 * 1024 * 1024;

/// Hosts a share fetch may redirect to (`chatgpt.com` SSO hops stay inside
/// its own domain; anything else is refused).
const SHARE_HOSTS: [&str; 2] = ["chatgpt.com", "chat.openai.com"];

/// Fetch a share page over HTTPS and return its server-rendered HTML.
/// Cloudflare fingerprints non-browser TLS stacks even behind a real UA, so
/// send the full browser header set — the combo matters as much as the UA.
async fn fetch_share_page(url: &str) -> Result<String, AppError> {
    let client = reqwest::Client::builder()
        .user_agent(SHARE_UA)
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() > 3 {
                return attempt.error("too many redirects");
            }
            let host_ok = attempt
                .url()
                .host_str()
                .map(|h| h.to_ascii_lowercase())
                .is_some_and(|h| SHARE_HOSTS.contains(&h.as_str()));
            if host_ok {
                attempt.follow()
            } else {
                attempt.error("redirect left the share host")
            }
        }))
        .build()
        .map_err(|e| AppError::Message(format!("share http client: {e}")))?;
    let mut resp = client
        .get(url)
        .header("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8")
        .header("accept-language", "zh-CN,zh;q=0.9,en;q=0.8")
        .header("sec-ch-ua", "\"Chromium\";v=\"130\", \"Google Chrome\";v=\"130\"")
        .header("sec-ch-ua-mobile", "?0")
        .header("sec-ch-ua-platform", "\"Windows\"")
        .header("sec-fetch-dest", "document")
        .header("sec-fetch-mode", "navigate")
        .header("sec-fetch-site", "none")
        .header("sec-fetch-user", "?1")
        .header("upgrade-insecure-requests", "1")
        .send()
        .await
        .map_err(|e| AppError::Message(format!("share fetch failed: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(AppError::Message(format!(
            "share fetch returned HTTP {status}"
        )));
    }
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| AppError::Message(format!("share read failed: {e}")))?
    {
        if body.len() + chunk.len() > SHARE_MAX_BYTES {
            return Err(AppError::Message(
                "share page exceeded 5 MiB; not a conversation page".into(),
            ));
        }
        body.extend_from_slice(&chunk);
    }
    let body = String::from_utf8_lossy(&body).into_owned();
    if body.contains("Just a moment...") {
        return Err(AppError::Message(
            "share page served a bot challenge; paste the conversation text instead".into(),
        ));
    }
    Ok(body)
}

/// Fetch a share URL and extract identifiers from its server-rendered text.
/// The conversation body stays in memory only — identifiers are returned,
/// the page text is dropped. No HTML entity decoding is needed: `&` already
/// ends identifiers, so `&amp;`-suffixed tracking tails are cut by the
/// scanner itself.
pub async fn extract_from_share_url(url: &str) -> Result<ExtractedIdentifiers, AppError> {
    let html = fetch_share_page(url).await?;
    Ok(extract_identifiers(&html))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Realistic AI-chat snippet: full links, mentions, duplicates, noise,
    /// Chinese punctuation, and a non-paper URL that must not match.
    const CHAT_SAMPLE: &str = "我最近看了几篇：
1. https://arxiv.org/abs/2403.15388 讲 token 合并的
2. arXiv:1706.03762 就是那篇 Attention
3. Nature 那篇：https://doi.org/10.1038/nature12373，
4. PubMed 上的 https://pubmed.ncbi.nlm.nih.gov/38729424/ 也可以
5. 又贴了一遍 2403 的（重复）：https://arxiv.org/pdf/2403.15388v2
6. 参考 https://www.nature.com/articles/nature12373（不是 doi.org，不应入列）
7. PMID: 31245678
欢迎补充！";

    #[test]
    fn extracts_all_forms_and_deduplicates() {
        let out = extract_identifiers(CHAT_SAMPLE);
        assert_eq!(out.arxiv, vec!["2403.15388", "1706.03762"]);
        assert_eq!(out.dois, vec!["10.1038/nature12373"]);
        // dedup vs the PMID: mention below
        assert_eq!(out.pmids, vec!["38729424", "31245678"]);
        assert_eq!(out.len(), 5);
    }

    #[test]
    fn chinese_punctuation_boundaries() {
        let out = extract_identifiers("论文（https://doi.org/10.1088/1361-6560/ac1a20）。很好");
        assert_eq!(out.dois, vec!["10.1088/1361-6560/ac1a20"]);
    }

    #[test]
    fn bare_numbers_are_ignored_for_precision() {
        let out = extract_identifiers("版本号 2403.15388 和 2024.3.5 不是文献，裸 10.1/x 也不算");
        assert!(out.is_empty(), "bare forms intentionally excluded: {out:?}");
    }

    #[test]
    fn noise_urls_do_not_match() {
        let out =
            extract_identifiers("看 https://github.com/poco-ai/Agentero 和 https://www.bing.com");
        assert!(out.is_empty());
    }

    #[test]
    fn share_url_detection() {
        assert!(is_share_url(
            "https://chatgpt.com/share/6ac3cc27-d230-83ec-a2c5-7f7849d3c8e0"
        ));
        assert!(is_share_url("https://chat.openai.com/share/abc123"));
        assert!(!is_share_url("https://chatgpt.com/share/"));
        assert!(!is_share_url("https://chatgpt.com/"));
        assert!(!is_share_url("看这个 https://chatgpt.com/share/xyz 谢谢"));
        assert!(!is_share_url("https://arxiv.org/abs/2403.15388"));
        assert!(!is_share_url("http://chatgpt.com/share/abc"));
    }

    #[test]
    fn html_entity_tails_stripped() {
        // Share pages carry DOIs inside href attributes with entity-encoded
        // query tails; `&` ending identifiers cuts them without any decoding.
        let html =
            "论文 <a href=\"https://doi.org/10.1088/1361-6560/ac1a20&amp;from=chat\">链接</a>。";
        assert_eq!(
            extract_identifiers(html).dois,
            vec!["10.1088/1361-6560/ac1a20"]
        );
    }

    /// Every repro from @Fengsuid's adversarial review of #814, plus the
    /// adopted bare-DOI behaviour.
    #[test]
    fn adversarial_review_cases() {
        // #1 balanced-paren DOIs are not truncated (Lancet/Wiley style).
        assert_eq!(
            extract_identifiers("https://doi.org/10.1016/S0140-6736(20)30183-5").dois,
            vec!["10.1016/s0140-6736(20)30183-5"]
        );
        // Trailing prose parentheses are NOT swallowed.
        assert_eq!(
            extract_identifiers("参考 https://doi.org/10.1038/nature12373（全文）").dois,
            vec!["10.1038/nature12373"]
        );
        // #2 URL fragments don't leak into the DOI.
        assert_eq!(
            extract_identifiers("https://doi.org/10.1038/nature12373#supplementary-information")
                .dois,
            vec!["10.1038/nature12373"]
        );
        // #3 arXiv shape: post-dot digit count and month half are validated.
        assert!(extract_identifiers("https://arxiv.org/abs/2403.1")
            .arxiv
            .is_empty());
        assert!(extract_identifiers("https://arxiv.org/abs/2403.123456")
            .arxiv
            .is_empty());
        assert!(
            extract_identifiers("https://arxiv.org/abs/2413.12345") // month 13
                .arxiv
                .is_empty()
        );
        assert_eq!(
            extract_identifiers("https://arxiv.org/abs/2603.29080").arxiv,
            vec!["2603.29080"]
        );
        // #4 lookalike hosts and prefixed mentions don't match.
        assert!(extract_identifiers(
            "https://notarxiv.org/abs/2403.15388 https://fakedoi.org/10.1038/nature12373 myarxiv:2403.15388"
        )
        .is_empty());
        assert!(extract_identifiers("mydoi:10.1038/nature12373").is_empty());
        // #5 short PMIDs: full 1–9 range on the domain anchor, 4+ on mentions.
        let out = extract_identifiers("https://pubmed.ncbi.nlm.nih.gov/1234/ and PMID: 5678");
        assert_eq!(out.pmids, vec!["1234", "5678"]);
        // Bare / `doi:` DOIs (adopted per review) — no collision with
        // version strings like `1.26.4` or bare arXiv numbers.
        assert_eq!(
            extract_identifiers("方法见 10.1038/nature12373，数据 doi: 10.1126/science.abc1234")
                .dois,
            vec!["10.1038/nature12373", "10.1126/science.abc1234"]
        );
        assert!(extract_identifiers("升级到 1.26.4 和 2024.12345").is_empty());
        // SICI-era suffixes: the narrow `.CO;` continuation now consumes the
        // full tail (chosen behaviour — @Fengsuid's corpus covers it either way).
        let sici = extract_identifiers(
            "https://doi.org/10.1002/(SICI)1097-4636(199801)39:1<1::AID-JBM1>3.0.CO;2-9",
        )
        .dois;
        assert_eq!(
            sici,
            vec!["10.1002/(sici)1097-4636(199801)39:1<1::aid-jbm1>3.0.co;2-9"]
        );
        // Bare SICI form in prose keeps the tail too.
        assert_eq!(
            extract_identifiers(
                "老论文 10.1002/(SICI)1097-4636(199801)39:1<1::AID-JBM1>3.0.CO;2-9 结束"
            )
            .dois
            .len(),
            1
        );
    }

    /// Second-round review repros (#814): trailing sentence punctuation and
    /// the dx/www/export mirrors the boundary anchoring accidentally dropped.
    #[test]
    fn review_round_two_regressions() {
        // A. Sentence-final punctuation must not leak into DOIs.
        assert_eq!(
            extract_identifiers(
                "See 10.1038/nature12373. The follow-up is 10.1016/S0140-6736(20)30183-5."
            )
            .dois,
            vec!["10.1038/nature12373", "10.1016/s0140-6736(20)30183-5"]
        );
        assert_eq!(
            extract_identifiers("https://doi.org/10.1038/nature12373. Next sentence.").dois,
            vec!["10.1038/nature12373"]
        );
        assert_eq!(
            extract_identifiers("see 10.1038/nature12373: important").dois,
            vec!["10.1038/nature12373"]
        );
        // B. dx.doi.org / www.doi.org / export.arxiv.org mirrors parse again.
        assert_eq!(
            extract_identifiers("https://dx.doi.org/10.1038/nature12373").dois,
            vec!["10.1038/nature12373"]
        );
        assert_eq!(
            extract_identifiers("https://www.doi.org/10.1038/nature12373").dois,
            vec!["10.1038/nature12373"]
        );
        assert_eq!(
            extract_identifiers("https://export.arxiv.org/abs/2403.15388").arxiv,
            vec!["2403.15388"]
        );
        // Mirrors still dedup against the canonical form.
        assert_eq!(
            extract_identifiers(
                "https://doi.org/10.1038/nature12373 和 https://dx.doi.org/10.1038/nature12373"
            )
            .dois
            .len(),
            1
        );
        // Markdown-escape residue: chatgpt.com share pages emit `\` after
        // identifiers (found on a second real share link).
        assert_eq!(
            extract_identifiers(
                r"链接 [10.1109/TMC.2025.3547371\](https://doi.org/10.1109/TMC.2025.3547371) 和 arXiv:2609.36844\\",
            )
            .dois,
            vec!["10.1109/tmc.2025.3547371"]
        );
        assert_eq!(
            extract_identifiers("https://arxiv.org/abs/2312.07192\\ tail").arxiv,
            vec!["2312.07192"]
        );
    }

    /// Pathologies from a second real share link (robotics survey, 15 papers):
    /// private-use code points (U+E201), bold markup and ellipsis-truncated
    /// citation cards — all must collapse to clean, unique identifiers.
    #[test]
    fn share_page_markup_pathologies() {
        // U+E201 + `**` right after a DOI inside a table cell.
        assert_eq!(
            extract_identifiers("10.1109/TMC.2025.3547371\u{e201}**（IEEE TMC 2025）| CUHK").dois,
            vec!["10.1109/tmc.2025.3547371"]
        );
        // Ellipsis-truncated citation cards: the stub must not survive
        // alongside (or instead of) the full DOI seen elsewhere in the page.
        assert!(
            extract_identifiers("https://doi.org/10.1088/13... truncated")
                .dois
                .is_empty()
        );
        assert_eq!(
            extract_identifiers(
                "https://doi.org/10.1109/TIM.2025.3566826 引用卡片 10.1109/TIM.2025.356682...",
            )
            .dois,
            vec!["10.1109/tim.2025.3566826"]
        );
        // Truncation arriving first still loses to the full form later.
        assert_eq!(
            extract_identifiers(
                "卡片 10.1109/TIM.2025.356682... 正文 https://doi.org/10.1109/TIM.2025.3566826",
            )
            .dois,
            vec!["10.1109/tim.2025.3566826"]
        );
    }

    /// Distilled from a real chatgpt.com/share conversation: seven papers,
    /// the main one surfacing in five different forms (abs/pdf/html links,
    /// bare `arXiv:` mentions, version suffixes). The scanner must collapse
    /// them to the seven unique ids in first-seen order — this is the
    /// automated form of the accuracy sample quoted in #652.
    #[test]
    fn real_share_page_surface_forms_collapse() {
        let page = r#"
            <main>聊聊这篇：<a href="https://arxiv.org/abs/2603.29080">abs</a>
            <a href="https://arxiv.org/pdf/2603.29080">pdf</a> 和 https://arxiv.org/html/2603.29080v1
            正文里也提到 arXiv:2603.29080 与 arXiv:2603.29080v1。
            相关工作里有 <a href="https://arxiv.org/pdf/2606.10789">a</a>
            <a href="https://arxiv.org/html/2605.14893v1">b</a>
            <a href="https://arxiv.org/html/2404.07983v3">c</a>
            <a href="https://arxiv.org/abs/2605.16887">d</a>
            <a href="https://arxiv.org/abs/2405.18570">e</a>
            以及更早的 arXiv:1401.1671。
            </main>
        "#;
        assert_eq!(
            extract_identifiers(page).arxiv,
            vec![
                "2603.29080",
                "2606.10789",
                "2605.14893",
                "2404.07983",
                "2605.16887",
                "2405.18570",
                "1401.1671",
            ]
        );
    }

    #[test]
    fn identifier_edge_boundaries() {
        // URL query tails and mixed-case hosts.
        let out = extract_identifiers(
            "https://pubmed.ncbi.nlm.nih.gov/38729424/?report=classic 和 https://DOI.ORG/10.1038/nature12373",
        );
        assert_eq!(out.pmids, vec!["38729424"]);
        assert_eq!(out.dois, vec!["10.1038/nature12373"]);

        // `arXiv:` mention with a space after the colon still parses.
        assert_eq!(
            extract_identifiers("如 arXiv: 1706.03762 所示").arxiv,
            vec!["1706.03762"]
        );

        // Full-width colon after mentions (Chinese IME, credit @Fengsuid).
        let out = extract_identifiers("重点看 arXiv：2301.08745 和 PMID：31245678");
        assert_eq!(out.arxiv, vec!["2301.08745"]);
        assert_eq!(out.pmids, vec!["31245678"]);

        // The same DOI twice collapses to one entry.
        assert_eq!(
            extract_identifiers(
                "https://doi.org/10.1038/nature12373 再贴一次 doi.org/10.1038/nature12373"
            )
            .dois
            .len(),
            1
        );

        // Whitespace-only input yields nothing.
        assert!(extract_identifiers("  \n\t ").is_empty());
    }
}

//! Skill source parsing for GitHub-backed skill imports.

use super::super::resolver::ResolvedIdentifier;

/// Machine kind tag for the Skill side-channel. Skills are deliberately not
/// resolver-table driven (see [`extract_skill_source`]).
pub const SKILL_KIND: &str = "skill";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SkillSource {
    pub owner: String,
    pub repo: String,
    pub reference: Option<String>,
    pub subpath: Option<String>,
    pub skill_names: Vec<String>,
    pub source: String,
}

/// Skill identifier for a skill-looking `text` (the multi-token batch path
/// cannot reuse [`extract_primary_identifier`] because free text would win).
pub fn skill_identifier(text: &str) -> Option<ResolvedIdentifier> {
    extract_skill_source(text).map(|source| ResolvedIdentifier {
        kind: SKILL_KIND,
        value: source.source,
        catalog_column: None,
    })
}

pub fn extract_skill_source(text: &str) -> Option<SkillSource> {
    let input = text.trim();
    if input.is_empty() {
        return None;
    }

    if input.starts_with("npx skills add ") {
        let mut words = input.split_whitespace();
        words.next();
        words.next();
        words.next();
        let source = words.next()?;
        let mut parsed = parse_skill_repo(source, input)?;
        let mut names = Vec::new();
        let mut iter = words.peekable();
        while let Some(word) = iter.next() {
            if word == "--skill" || word == "-s" {
                if let Some(name) = iter.next() {
                    names.push(name.to_string());
                }
            } else if let Some(name) = word.strip_prefix("--skill=") {
                names.push(name.to_string());
            }
        }
        parsed.skill_names = names;
        return Some(parsed);
    }

    if let Some(rest) = input.strip_prefix("github:") {
        return parse_skill_repo(rest, input);
    }

    let url = url::Url::parse(input).ok()?;
    match url.host_str()? {
        "github.com" | "www.github.com" => parse_github_url(&url, input),
        "skills.sh" | "www.skills.sh" => {
            let parts: Vec<_> = url.path_segments()?.filter(|p| !p.is_empty()).collect();
            if parts.len() < 3 {
                return None;
            }
            Some(SkillSource {
                owner: parts[0].to_string(),
                repo: parts[1].to_string(),
                reference: fragment_ref(&url),
                subpath: None,
                skill_names: vec![parts[2].to_string()],
                source: input.to_string(),
            })
        }
        _ => None,
    }
}

fn parse_skill_repo(value: &str, source: &str) -> Option<SkillSource> {
    let mut raw = value.trim().trim_end_matches('/');
    if raw.starts_with("http://") || raw.starts_with("https://") {
        let url = url::Url::parse(raw).ok()?;
        return parse_github_url(&url, source);
    }
    let mut reference = None;
    if let Some((base, fragment)) = raw.split_once('#') {
        raw = base;
        if !fragment.is_empty() {
            reference = Some(fragment.to_string());
        }
    }
    let raw = raw.strip_suffix(".git").unwrap_or(raw);
    let parts: Vec<_> = raw.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() != 2 || !valid_github_part(parts[0]) || !valid_github_part(parts[1]) {
        return None;
    }
    Some(SkillSource {
        owner: parts[0].to_string(),
        repo: parts[1].to_string(),
        reference,
        subpath: None,
        skill_names: Vec::new(),
        source: source.to_string(),
    })
}

fn parse_github_url(url: &url::Url, source: &str) -> Option<SkillSource> {
    let parts: Vec<_> = url.path_segments()?.filter(|p| !p.is_empty()).collect();
    if parts.len() < 2 || !valid_github_part(parts[0]) || !valid_github_part(parts[1]) {
        return None;
    }
    let repo = parts[1].strip_suffix(".git").unwrap_or(parts[1]);
    let (reference, subpath) = if parts.get(2) == Some(&"tree") && parts.len() >= 4 {
        let reference = Some(parts[3].to_string());
        let subpath = if parts.len() > 4 {
            Some(parts[4..].join("/"))
        } else {
            None
        };
        (reference, subpath)
    } else {
        (fragment_ref(url), None)
    };
    Some(SkillSource {
        owner: parts[0].to_string(),
        repo: repo.to_string(),
        reference,
        subpath,
        skill_names: Vec::new(),
        source: source.to_string(),
    })
}

fn fragment_ref(url: &url::Url) -> Option<String> {
    url.fragment().filter(|s| !s.is_empty()).map(str::to_string)
}

fn valid_github_part(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_npx_skill_command() {
        let source =
            extract_skill_source("npx skills add vercel-labs/agent-skills --skill frontend-design")
                .unwrap();
        assert_eq!(source.owner, "vercel-labs");
        assert_eq!(source.repo, "agent-skills");
        assert_eq!(source.skill_names, vec!["frontend-design"]);
    }

    #[test]
    fn parses_github_url_with_tree() {
        let source =
            extract_skill_source("https://github.com/openai/skills/tree/main/skills/create-plan")
                .unwrap();
        assert_eq!(source.owner, "openai");
        assert_eq!(source.repo, "skills");
        assert_eq!(source.reference.as_deref(), Some("main"));
        assert_eq!(source.subpath.as_deref(), Some("skills/create-plan"));
    }

    #[test]
    fn rejects_non_skill_url() {
        assert!(extract_skill_source("https://example.com/paper").is_none());
    }

    #[test]
    fn parses_requested_skill_import_examples() {
        let input = "npx skills add anthropics/skills --skill pptx";
        let source = extract_skill_source(input).unwrap();
        assert_eq!(source.owner, "anthropics");
        assert_eq!(source.repo, "skills");
        assert_eq!(source.skill_names, vec!["pptx"]);
    }
}

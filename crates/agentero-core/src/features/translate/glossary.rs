//! Bounded, user-authored glossary parsing and term matching.
use crate::error::AppError;
use std::collections::BTreeMap;
pub type GlossaryTerm = (String, String);

pub(super) fn word_character(c: char) -> bool {
    (c.is_alphanumeric() || c == '_') && !('\u{4e00}'..='\u{9fff}').contains(&c)
}

// Keep original byte ranges so PDF line breaks and Unicode hyphens can match a
// compound alias without changing the surrounding source sent to the provider.
fn fold_term_text(text: &str) -> (String, Vec<(usize, usize)>) {
    let mut folded = String::new();
    let mut offsets: Vec<(usize, usize)> = Vec::new();
    for (start, c) in text.char_indices() {
        let end = start + c.len_utf8();
        if c.is_whitespace() || matches!(c, '-' | '\u{2010}'..='\u{2015}' | '\u{2212}') {
            if folded.ends_with(' ') {
                offsets.last_mut().expect("space offset").1 = end;
            } else {
                folded.push(' ');
                offsets.push((start, end));
            }
        } else {
            for lower in c.to_lowercase() {
                folded.push(lower);
                offsets.extend(std::iter::repeat_n((start, end), lower.len_utf8()));
            }
        }
    }
    (folded, offsets)
}

pub(super) fn lookup_key(text: &str) -> String {
    fold_term_text(text).0.trim().to_owned()
}
pub fn parse_glossary(input: &str) -> Result<Vec<GlossaryTerm>, AppError> {
    let invalid = || {
        AppError::message("Invalid glossary: use a JSON string map or source → target pairs (up to 200 entries / 16000 characters).")
    };
    if input.encode_utf16().count() > 16000 {
        return Err(invalid());
    }
    let input = input.trim();
    if input.is_empty() {
        return Ok(vec![]);
    }
    let pairs: Vec<GlossaryTerm> = if input.starts_with('{') {
        serde_json::from_str::<BTreeMap<String, String>>(input)
            .map_err(|_| invalid())?
            .into_iter()
            .collect()
    } else {
        input
            .split(['\r', '\n', ',', '，'])
            .filter(|s| !s.trim().is_empty())
            .map(|line| {
                let (pos, sep) = ["->", "→", ":", "："]
                    .iter()
                    .filter_map(|sep| line.find(sep).map(|p| (p, *sep)))
                    .min_by_key(|(p, _)| *p)
                    .ok_or_else(invalid)?;
                Ok((line[..pos].to_string(), line[pos + sep.len()..].to_string()))
            })
            .collect::<Result<_, AppError>>()?
    };
    if pairs.len() > 200 {
        return Err(invalid());
    }
    let mut terms = BTreeMap::new();
    for (source, target) in pairs {
        let source = source.trim();
        let target = target.trim();
        if source.is_empty()
            || target.is_empty()
            || source.encode_utf16().count() > 120
            || target.encode_utf16().count() > 240
            || source
                .chars()
                .chain(target.chars())
                .any(|c| matches!(c, '\r' | '\n' | '\t'))
        {
            return Err(invalid());
        }
        terms.insert(source.to_string(), target.to_string());
    }
    Ok(terms.into_iter().collect())
}
pub fn matching_glossary(input: &str, text: &str) -> Result<Vec<GlossaryTerm>, AppError> {
    let (folded, offsets) = fold_term_text(text);
    let mut spans = Vec::new();
    for (source, target) in parse_glossary(input)? {
        let key = lookup_key(&source);
        if key.is_empty() {
            continue;
        }
        for (index, _) in folded.match_indices(&key) {
            let start = offsets[index].0;
            let end = offsets[index + key.len() - 1].1;
            let boundary = |c: char| !word_character(c);
            if (!source.chars().next().is_some_and(word_character)
                || text[..start].chars().next_back().is_none_or(boundary))
                && (!source.chars().next_back().is_some_and(word_character)
                    || text[end..].chars().next().is_none_or(boundary))
            {
                let actual = &text[start..end];
                let alias = if source.eq_ignore_ascii_case(actual) {
                    source.clone()
                } else {
                    actual.to_owned()
                };
                spans.push((start, end, alias, target.clone()));
            }
        }
    }
    // Leftmost, longest match wins. A standalone LLM later in the same sentence
    // still contributes its own constraint; the LLM inside a compound does not.
    spans.sort_by_key(|(start, end, _, _)| (*start, std::cmp::Reverse(end - start)));
    let mut end = 0;
    let mut terms = BTreeMap::new();
    for (start, finish, source, target) in spans {
        if start >= end {
            terms.insert(source, target);
            end = finish;
        }
    }
    Ok(terms.into_iter().collect())
}
pub(crate) fn prompt_constraint(terms: &[GlossaryTerm]) -> Option<String> {
    if terms.is_empty() {
        None
    } else {
        Some(format!(
            "Required terminology (source → target; apply only to the selected text):\n{}",
            serde_json::to_string(
                &terms
                    .iter()
                    .map(|(s, t)| (s, t))
                    .collect::<BTreeMap<_, _>>()
            )
            .unwrap_or_default()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compound_matches_share_frontend_boundaries_and_longest_match_rules() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../test/fixtures/translate-compounds.json"
        ))
        .unwrap();
        let glossary = serde_json::to_string(&fixture["glossary"]).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let actual: BTreeMap<_, _> =
                matching_glossary(&glossary, case["text"].as_str().unwrap())
                    .unwrap()
                    .into_iter()
                    .collect();
            assert_eq!(
                serde_json::to_value(actual).unwrap(),
                case["expected"],
                "{}",
                case["text"]
            );
        }
    }
    #[test]
    fn accepts_user_formats_and_rejects_invalid_entries() {
        let expected = vec![
            ("KV cache".into(), "KV 缓存".into()),
            ("LLM".into(), "大模型".into()),
        ];
        for input in [
            r#"{"LLM":"大模型","KV cache":"KV 缓存"}"#,
            "LLM:大模型,KV cache->KV 缓存",
            "LLM：大模型，KV cache→KV 缓存",
            "LLM → 大模型\nKV cache → KV 缓存",
        ] {
            assert_eq!(parse_glossary(input).unwrap(), expected);
        }
        for input in [r#"{"LLM":1}"#, "{broken", "LLM", "LLM:", ":model"] {
            assert!(parse_glossary(input).is_err(), "{input}");
        }
        assert!(parse_glossary(&"x".repeat(16001)).is_err());
    }
    #[test]
    fn matches_chinese_prose_and_mixed_script_terms() {
        assert_eq!(
            matching_glossary("大模型→LLM", "我们使用大模型进行推理。")
                .unwrap()
                .len(),
            1
        );
        assert_eq!(matching_glossary("LLM→大模型", "LLM模型").unwrap().len(), 1);
    }
    #[test]
    fn matches_boundaries_and_case_without_regex_interpretation() {
        let input = r#"{"LLM":"大模型","KV cache":"KV 缓存","C++":"C++"}"#;
        assert_eq!(
            matching_glossary(input, "LLMs use a KV cache.").unwrap(),
            vec![("KV cache".into(), "KV 缓存".into())]
        );
        assert_eq!(
            matching_glossary(input, "An llm uses C++.").unwrap().len(),
            2
        );
    }
}

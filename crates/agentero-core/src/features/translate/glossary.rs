//! Bounded, user-authored glossary parsing and term matching.
use crate::error::AppError;
use std::collections::BTreeMap;
pub type GlossaryTerm = (String, String);
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
    Ok(parse_glossary(input)?
        .into_iter()
        .filter(|(source, _)| {
            let source = source.to_lowercase();
            let text = text.to_lowercase();
            text.match_indices(&source).any(|(start, matched)| {
                let word_character = |c: char| {
                    (c.is_alphanumeric() || c == '_') && !('\u{4e00}'..='\u{9fff}').contains(&c)
                };
                let boundary = |c: char| !word_character(c);
                (!source.chars().next().is_some_and(word_character)
                    || text[..start].chars().next_back().is_none_or(boundary))
                    && (!source.chars().next_back().is_some_and(word_character)
                        || text[start + matched.len()..]
                            .chars()
                            .next()
                            .is_none_or(boundary))
            })
        })
        .collect())
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

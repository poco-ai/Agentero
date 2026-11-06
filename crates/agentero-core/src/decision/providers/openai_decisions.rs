//! OpenAI Decisions API adapter for the System One transport surface.
//!
//! Agentero's callers (probe, smart-highlight, DecisionEngine schemas) speak
//! System One: `{ state, questions: { id: { type, instructions, criteria } } }`
//! with `answers` as a map. OpenAI Decisions speaks
//! `{ input, questions: [ { name, type, ... } ] }` with `answers` as an array.
//!
//! This module translates both directions so the existing
//! [`super::SystemOneProvider`] can target `POST /v1/decisions` when the
//! configured endpoint (or provider preset) is OpenAI Decisions.

use serde_json::{json, Map, Value};

/// True when `base_url` should be treated as OpenAI Decisions rather than
/// System One. Matches the official path (`…/decisions`) and the bare OpenAI
/// API root users often paste (`https://api.openai.com/v1`).
pub fn is_openai_decisions_endpoint(base_url: &str) -> bool {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    lower.ends_with("/decisions")
        || lower.contains("api.openai.com")
        || lower.contains("openai.azure.com")
}

/// Normalize a user-supplied OpenAI base URL to the Decisions endpoint.
///
/// - `https://api.openai.com/v1/decisions` → unchanged
/// - `https://api.openai.com/v1` → append `/decisions`
/// - `https://api.openai.com` → append `/v1/decisions`
pub fn normalize_openai_decisions_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return "https://api.openai.com/v1/decisions".to_string();
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.ends_with("/decisions") {
        return trimmed.to_string();
    }
    if lower.ends_with("/v1") {
        return format!("{trimmed}/decisions");
    }
    // Bare host or unusual root — append the canonical path.
    if lower.contains("api.openai.com") && !lower.contains("/v1/") {
        return format!("{trimmed}/v1/decisions");
    }
    // Custom OpenAI-compatible host already pointing at a decisions-ish path,
    // or a proxy: append `/decisions` as the least surprising default.
    format!("{trimmed}/decisions")
}

/// Convert a System One request body into an OpenAI Decisions request body.
///
/// Returns `None` when the body is not a System One-shaped object (so the
/// caller can POST it unchanged). `model` is injected by the transport.
pub fn system_one_to_openai_request(body: &Value) -> Option<Value> {
    let object = body.as_object()?;
    // Already Decisions-shaped: leave alone.
    if object.contains_key("input") && !object.contains_key("state") {
        return Some(body.clone());
    }
    let state = object.get("state").cloned().unwrap_or(Value::Null);
    let questions = object.get("questions")?;

    let openai_questions = match questions {
        Value::Object(map) => map
            .iter()
            .map(|(name, q)| convert_question(name, q))
            .collect::<Option<Vec<_>>>()?,
        Value::Array(arr) => {
            // Rare: already an array — ensure each entry has a name.
            arr.iter()
                .enumerate()
                .map(|(i, q)| {
                    let name = q
                        .get("name")
                        .and_then(Value::as_str)
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| format!("q{i}"));
                    convert_question(&name, q)
                })
                .collect::<Option<Vec<_>>>()?
        }
        _ => return None,
    };

    if openai_questions.is_empty() {
        return None;
    }

    // Structured state travels as input_json so callers keep object keys;
    // a string state stays a plain string input.
    let input = match state {
        Value::String(s) => Value::String(s),
        Value::Null => Value::String(String::new()),
        other => json!([{
            "role": "user",
            "content": [
                {
                    "type": "input_text",
                    "text": "Evaluate the following decision state."
                },
                {
                    "type": "input_json",
                    "data": other
                }
            ]
        }]),
    };

    let mut out = Map::new();
    out.insert("input".to_string(), input);
    out.insert("questions".to_string(), Value::Array(openai_questions));
    // Preserve an explicit model if the caller already set one.
    if let Some(model) = object.get("model") {
        out.insert("model".to_string(), model.clone());
    }
    Some(Value::Object(out))
}

fn convert_question(name: &str, question: &Value) -> Option<Value> {
    let object = question.as_object()?;
    let qtype = object
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("choice");
    let instructions = object
        .get("instructions")
        .cloned()
        .unwrap_or_else(|| Value::String(String::new()));

    match qtype {
        // System One yes/no → OpenAI predicate
        "noul" | "predicate" => Some(json!({
            "type": "predicate",
            "name": name,
            "instructions": instructions,
        })),
        "score" => {
            let levels =
                criteria_to_levels(object.get("criteria").or_else(|| object.get("levels")));
            let mut q = Map::new();
            q.insert("type".to_string(), Value::String("score".to_string()));
            q.insert("name".to_string(), Value::String(name.to_string()));
            q.insert("instructions".to_string(), instructions);
            if let Some(levels) = levels {
                q.insert("levels".to_string(), levels);
            }
            Some(Value::Object(q))
        }
        // Default / "choice"
        _ => {
            let choices =
                criteria_to_choices(object.get("criteria").or_else(|| object.get("choices")));
            let mut q = Map::new();
            q.insert("type".to_string(), Value::String("choice".to_string()));
            q.insert("name".to_string(), Value::String(name.to_string()));
            q.insert("instructions".to_string(), instructions);
            if let Some(choices) = choices {
                q.insert("choices".to_string(), choices);
            }
            Some(Value::Object(q))
        }
    }
}

fn criteria_to_levels(criteria: Option<&Value>) -> Option<Value> {
    let value = criteria?;
    if let Some(arr) = value.as_array() {
        // Already OpenAI levels?
        if arr.first().and_then(|v| v.get("label")).is_some() {
            return Some(value.clone());
        }
        let levels: Vec<Value> = arr
            .iter()
            .map(|item| match item {
                Value::String(s) => json!({ "label": s, "description": s }),
                Value::Object(obj) => {
                    let label = obj
                        .get("label")
                        .or_else(|| obj.get("value"))
                        .cloned()
                        .unwrap_or_else(|| Value::String("level".to_string()));
                    let description = obj
                        .get("description")
                        .cloned()
                        .unwrap_or_else(|| label.clone());
                    json!({ "label": label, "description": description })
                }
                other => json!({ "label": other.to_string(), "description": other.to_string() }),
            })
            .collect();
        return Some(Value::Array(levels));
    }
    None
}

fn criteria_to_choices(criteria: Option<&Value>) -> Option<Value> {
    let value = criteria?;
    if let Some(arr) = value.as_array() {
        if arr.first().and_then(|v| v.get("value")).is_some() {
            return Some(value.clone());
        }
        let choices: Vec<Value> = arr
            .iter()
            .map(|item| match item {
                Value::String(s) => json!({ "value": s, "description": s }),
                Value::Object(obj) => {
                    let val = obj
                        .get("value")
                        .or_else(|| obj.get("label"))
                        .cloned()
                        .unwrap_or_else(|| Value::String("option".to_string()));
                    let description = obj
                        .get("description")
                        .cloned()
                        .unwrap_or_else(|| val.clone());
                    json!({ "value": val, "description": description })
                }
                other => json!({ "value": other.to_string(), "description": other.to_string() }),
            })
            .collect();
        return Some(Value::Array(choices));
    }
    None
}

/// Convert an OpenAI Decisions response into a System One `answers` map so
/// existing consumers (`jev` highlight, `interpret_answers`) keep working.
pub fn openai_to_system_one_response(response: &Value) -> Value {
    let Some(answers) = response.get("answers") else {
        return response.clone();
    };

    // Already a System One map.
    if answers.is_object() {
        return response.clone();
    }

    let Some(arr) = answers.as_array() else {
        return response.clone();
    };

    let mut map = Map::new();
    for (idx, answer) in arr.iter().enumerate() {
        let name = answer
            .get("name")
            .and_then(Value::as_str)
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("answer_{idx}"));
        if let Some(converted) = convert_answer(answer) {
            map.insert(name, converted);
        }
    }

    let mut out = response.as_object().cloned().unwrap_or_default();
    out.insert("answers".to_string(), Value::Object(map));
    Value::Object(out)
}

fn convert_answer(answer: &Value) -> Option<Value> {
    let object = answer.as_object()?;
    let atype = object.get("type").and_then(Value::as_str).unwrap_or("");

    match atype {
        "predicate" => {
            let probability = object
                .get("probability")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            Some(json!({
                "noul": probability,
                "confidence": probability,
            }))
        }
        "choice" => {
            let mut out = Map::new();
            if let Some(choice) = object.get("choice") {
                out.insert("choice".to_string(), choice.clone());
            }
            if let Some(confidence) = object.get("confidence") {
                out.insert("confidence".to_string(), confidence.clone());
            }
            if let Some(probs) = object.get("probabilities") {
                out.insert(
                    "probabilities".to_string(),
                    probabilities_array_to_map(probs),
                );
            }
            Some(Value::Object(out))
        }
        "score" => {
            let mut out = Map::new();
            if let Some(score) = object.get("score") {
                out.insert("score".to_string(), score.clone());
            }
            if let Some(confidence) = object.get("confidence") {
                out.insert("confidence".to_string(), confidence.clone());
            }
            if let Some(probs) = object.get("probabilities") {
                out.insert(
                    "probabilities".to_string(),
                    probabilities_array_to_map(probs),
                );
            }
            Some(Value::Object(out))
        }
        "refusal" => {
            // Surface as no actionable fields so interpret_answers yields
            // no-opinion and the engine can fall back.
            Some(json!({ "refusal": true }))
        }
        _ => {
            // Pass through unrecognized shapes with a conservative wrapper.
            Some(answer.clone())
        }
    }
}

fn probabilities_array_to_map(probs: &Value) -> Value {
    if let Some(obj) = probs.as_object() {
        return Value::Object(obj.clone());
    }
    let Some(arr) = probs.as_array() else {
        return probs.clone();
    };
    let mut map = Map::new();
    for item in arr {
        let key = item
            .get("label")
            .or_else(|| item.get("value"))
            .map(|v| match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            })
            .unwrap_or_else(|| "option".to_string());
        if let Some(p) = item.get("probability") {
            map.insert(key, p.clone());
        }
    }
    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_openai_endpoints() {
        assert!(is_openai_decisions_endpoint(
            "https://api.openai.com/v1/decisions"
        ));
        assert!(is_openai_decisions_endpoint("https://api.openai.com/v1"));
        assert!(is_openai_decisions_endpoint("https://api.openai.com"));
        assert!(!is_openai_decisions_endpoint(
            "https://api.typesafe.ai/v1/systemone"
        ));
    }

    #[test]
    fn normalizes_openai_urls() {
        assert_eq!(
            normalize_openai_decisions_url("https://api.openai.com/v1"),
            "https://api.openai.com/v1/decisions"
        );
        assert_eq!(
            normalize_openai_decisions_url("https://api.openai.com/v1/decisions"),
            "https://api.openai.com/v1/decisions"
        );
        assert_eq!(
            normalize_openai_decisions_url("https://api.openai.com"),
            "https://api.openai.com/v1/decisions"
        );
    }

    #[test]
    fn converts_score_probe_request() {
        let body = json!({
            "state": { "paper_title": "probe" },
            "questions": {
                "health_score": {
                    "type": "score",
                    "instructions": "Sanity check",
                    "criteria": ["No", "Maybe", "Yes"],
                }
            }
        });
        let converted = system_one_to_openai_request(&body).expect("convert");
        assert!(converted.get("input").is_some());
        assert!(converted.get("state").is_none());
        let questions = converted["questions"].as_array().expect("array");
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0]["type"], "score");
        assert_eq!(questions[0]["name"], "health_score");
        assert_eq!(questions[0]["levels"].as_array().unwrap().len(), 3);
        assert_eq!(questions[0]["levels"][0]["label"], "No");
    }

    #[test]
    fn converts_noul_to_predicate() {
        let body = json!({
            "state": { "x": 1 },
            "questions": {
                "is_relevant": {
                    "type": "noul",
                    "instructions": "Is this relevant?"
                }
            }
        });
        let converted = system_one_to_openai_request(&body).expect("convert");
        assert_eq!(converted["questions"][0]["type"], "predicate");
        assert_eq!(converted["questions"][0]["name"], "is_relevant");
    }

    #[test]
    fn converts_openai_score_answer_to_map() {
        let response = json!({
            "answers": [{
                "type": "score",
                "name": "health_score",
                "score": 2.0,
                "confidence": 0.8,
                "probabilities": [
                    { "value": 0, "label": "No", "probability": 0.05 },
                    { "value": 1, "label": "Maybe", "probability": 0.15 },
                    { "value": 2, "label": "Yes", "probability": 0.8 }
                ]
            }]
        });
        let converted = openai_to_system_one_response(&response);
        let answer = &converted["answers"]["health_score"];
        assert_eq!(answer["score"], 2.0);
        assert_eq!(answer["confidence"], 0.8);
        assert_eq!(answer["probabilities"]["Yes"], 0.8);
    }

    #[test]
    fn converts_predicate_answer_to_noul() {
        let response = json!({
            "answers": [{
                "type": "predicate",
                "name": "ok",
                "probability": 0.91
            }]
        });
        let converted = openai_to_system_one_response(&response);
        assert_eq!(converted["answers"]["ok"]["noul"], 0.91);
    }
}

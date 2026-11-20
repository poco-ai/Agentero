//! The user-facing command catalog drives clap, machine help and the CLI adapter.
use crate::error::CliError;
use clap::{Arg, ArgAction, ArgMatches, Command};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::sync::LazyLock;

#[derive(Deserialize, Serialize)]
pub struct Operation {
    pub path: &'static str,
    about: String,
    about_en: String,
    behavior: Option<String>,
    returns: Option<String>,
    example: String,
    pub tool: Option<&'static str>,
    pub result: Option<&'static str>,
    args: Vec<Parameter>,
}

#[derive(Deserialize, Serialize)]
struct Parameter {
    name: &'static str,
    help: String,
    help_en: String,
    #[serde(default)]
    positional: bool,
    #[serde(default)]
    required: bool,
    #[serde(default)]
    many: bool,
    kind: Option<&'static str>,
    default: Option<&'static str>,
    choices: Option<Vec<&'static str>>,
    min: Option<f64>,
    max: Option<f64>,
}

pub static OPERATIONS: LazyLock<Vec<Operation>> = LazyLock::new(|| {
    serde_json::from_str(agentero_core::ops::CLI_INTERFACE_JSON)
        .expect("valid built-in command catalog")
});

pub fn operation(path: &str) -> Option<&'static Operation> {
    OPERATIONS.iter().find(|op| op.path == path)
}

fn build(op: &Operation, chinese: bool) -> Command {
    let name = op.path.split_whitespace().last().unwrap_or("agentero");
    let examples = op.example.replace('\n', "\n  ");
    let mut footer = format!(
        "{}\n  {examples}",
        if chinese { "示例" } else { "Examples" }
    );
    if let (true, Some(behavior)) = (chinese, &op.behavior) {
        footer.push_str(&format!("\n\n行为\n  {behavior}"));
    }
    if let Some(returns) = &op.returns {
        footer.push_str(&format!(
            "\n\n{}\n  {returns}",
            if chinese { "结果" } else { "Result" }
        ));
    }
    let mut cmd = Command::new(name)
        .about(if chinese {
            op.about.clone()
        } else {
            op.about_en.clone()
        })
        .after_help(footer)
        .disable_help_subcommand(true);
    if op.path.is_empty() {
        cmd = cmd.version(env!("CARGO_PKG_VERSION"))
            .after_long_help(format!("Examples:\n  {}\n\nDocs: https://agentero-docs.poco-ai.com\nFeedback: https://github.com/poco-ai/Agentero/issues",op.example.replace('\n',"\n  ")))
            .arg(Arg::new("vault").long("vault").global(true).value_name("VAULT").help("Vault ID or local root directory"))
            .arg(Arg::new("json").long("json").global(true).action(ArgAction::SetTrue).help("Emit structured JSON"))
            .arg(Arg::new("no-input").long("no-input").global(true).action(ArgAction::SetTrue).help("Disable interactive prompts"))
            .arg(Arg::new("quiet").long("quiet").global(true).action(ArgAction::SetTrue).help("Suppress progress"))
            .arg(Arg::new("color").long("color").global(true).value_parser(["auto","always","never"]).default_value("auto").help("Terminal colors"));
    }
    for param in &op.args {
        let mut arg = Arg::new(param.name)
            .help(if chinese {
                param.help.clone()
            } else {
                param.help_en.clone()
            })
            .required(param.required);
        if !param.positional {
            arg = arg.long(param.name);
        }
        if param.kind == Some("bool") {
            arg = arg.action(ArgAction::SetTrue);
        } else {
            if param.many {
                arg = arg.action(ArgAction::Append);
                if param.positional {
                    arg = arg.num_args(1..);
                }
            }
            if let Some(default) = param.default {
                arg = arg.default_value(default);
            }
            if let Some(choices) = &param.choices {
                arg = arg.value_parser(clap::builder::PossibleValuesParser::new(
                    choices.iter().copied(),
                ));
            }
        }
        if param.name == "plain" {
            arg = arg.conflicts_with("json");
        }
        cmd = cmd.arg(arg);
    }
    for child in OPERATIONS.iter().filter(|child| {
        !child.path.is_empty()
            && child.path.rsplit_once(' ').map_or("", |(parent, _)| parent) == op.path
    }) {
        cmd = cmd.subcommand(build(child, chinese));
    }
    cmd
}

pub fn root() -> Command {
    let chinese = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .filter_map(std::env::var_os)
        .find(|v| !v.is_empty())
        .is_some_and(|v| v.to_string_lossy().to_ascii_lowercase().starts_with("zh"));
    let mut cmd = build(&OPERATIONS[0], chinese);
    cmd.build();
    cmd
}

pub fn arguments(op: &Operation, m: &ArgMatches) -> Result<Value, CliError> {
    let mut args = Map::new();
    for p in &op.args {
        if op.path == "mcp serve"
            && p.name == "listen"
            && m.value_source(p.name) == Some(clap::parser::ValueSource::DefaultValue)
        {
            continue;
        }
        let key = p.name.replace('-', "_");
        if p.kind == Some("bool") {
            if m.get_flag(p.name) {
                args.insert(key, Value::Bool(true));
            }
        } else if let Some(values) = m.get_many::<String>(p.name) {
            let parsed = values.map(|s| parse(p, s)).collect::<Result<Vec<_>, _>>()?;
            if p.many {
                args.insert(key, Value::Array(parsed));
            } else if let Some(v) = parsed.into_iter().next() {
                args.insert(key, v);
            }
        }
    }
    Ok(Value::Object(args))
}

fn parse(p: &Parameter, s: &str) -> Result<Value, CliError> {
    let invalid = || CliError::usage(format!("invalid {}: {s}", p.name));
    let value = match p.kind {
        Some("integer") => Value::from(s.parse::<u64>().map_err(|_| invalid())?),
        Some("number") => serde_json::Number::from_f64(s.parse().map_err(|_| invalid())?)
            .map(Value::Number)
            .ok_or_else(invalid)?,
        Some("json") => serde_json::from_str(s).map_err(|_| invalid())?,
        _ => Value::String(s.to_string()),
    };
    if let Some(n) = value.as_f64() {
        if p.min.is_some_and(|min| n < min) || p.max.is_some_and(|max| n > max) {
            return Err(invalid());
        }
    }
    Ok(value)
}

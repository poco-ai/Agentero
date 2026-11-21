//! Headless research CLI. The desktop and MCP transports share its data operations.
mod commands;
mod config;
mod dispatch;
mod error;
mod interface;
mod output;
mod prompt;
mod resolve;
mod style;

use clap::Command;
use error::CliError;
use output::OutputFormat;
use resolve::GlobalOpts;
use serde_json::{json, Value};
use std::ffi::OsString;
use std::io::{self, Write};
use std::process::ExitCode;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

pub const CLI_TASK_ID: &str = "agentero-cli-task";

fn help_target(args: &[OsString]) -> Option<Command> {
    let mut words = args.iter().take_while(|x| x.as_os_str() != "--").peekable();
    if !words
        .clone()
        .any(|x| x.as_os_str() == "-h" || x.as_os_str() == "--help")
    {
        return None;
    }
    let mut current = interface::root();
    while let Some(word) = words.next() {
        let Some(word) = word.to_str() else { continue };
        if matches!(word, "--vault" | "--color") {
            words.next();
            continue;
        }
        if word.starts_with('-') {
            continue;
        }
        if let Some(child) = current.find_subcommand(word) {
            current = child.clone()
        } else if current.has_subcommands() {
            return None;
        } else {
            break;
        }
    }
    Some(current)
}

fn display_help(body: impl std::fmt::Display, json: bool) -> ExitCode {
    match writeln!(io::stdout().lock(), "{body}") {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) if e.kind() == io::ErrorKind::BrokenPipe => ExitCode::SUCCESS,
        Err(e) => fail(e.into(), json),
    }
}

fn main() -> ExitCode {
    if let Some(status) = agentero_core::features::import::pdf_parse::try_run_pdf_parse_worker() {
        return ExitCode::from(status as u8);
    }
    let argv: Vec<_> = std::env::args_os().skip(1).collect();
    let json_mode = argv
        .iter()
        .take_while(|x| x.as_os_str() != "--")
        .any(|x| x.as_os_str() == "--json");
    if let Some(mut cmd) = help_target(&argv) {
        return display_help(cmd.render_long_help(), json_mode);
    }
    let root = interface::root();
    let matches = match root
        .clone()
        .try_get_matches_from(std::iter::once(OsString::from("agentero")).chain(argv))
    {
        Ok(m) => m,
        Err(err) if !err.use_stderr() => {
            let _ = err.print();
            return ExitCode::SUCCESS;
        }
        Err(err) => return fail(CliError::usage(err.to_string()), json_mode),
    };
    let mut m = &matches;
    let mut route = Vec::new();
    while let Some((sub, child)) = m.subcommand() {
        route.push(sub);
        m = child;
    }
    let path = route.join(" ");
    let op = interface::operation(&path).expect("registered command");
    let json = m.get_flag("json");
    if op.result.is_none() || path == "help" {
        let target = if path == "help" {
            m.get_many::<String>("command")
                .into_iter()
                .flatten()
                .map(String::as_str)
                .collect::<Vec<_>>()
        } else {
            route
        };
        let mut cmd = &root;
        for word in &target {
            let Some(child) = cmd.find_subcommand(word) else {
                return fail(CliError::usage(format!("unknown help topic: {word}")), json);
            };
            cmd = child;
        }
        if json {
            let prefix = target.join(" ");
            let children: Vec<_> = interface::OPERATIONS
                .iter()
                .filter(|op| {
                    prefix.is_empty()
                        || op.path == prefix
                        || op.path.starts_with(&format!("{prefix} "))
                })
                .collect();
            return display_help(json!({"path":prefix,"commands":children}), true);
        } else {
            return display_help(cmd.clone().render_long_help(), false);
        }
    }
    let args = match interface::arguments(op, m) {
        Ok(v) => v,
        Err(e) => return fail(e, json),
    };
    let format = if json {
        OutputFormat::Json
    } else {
        OutputFormat::Text
    };
    let color = match m.get_one::<String>("color").map(String::as_str) {
        Some("always") => style::ColorWhen::Always,
        Some("never") => style::ColorWhen::Never,
        _ => style::ColorWhen::Auto,
    };
    let g = GlobalOpts {
        vault_flag: m.get_one::<String>("vault").map(Into::into),
        yes: args["yes"] == true,
        no_input: m.get_flag("no-input"),
        quiet: m.get_flag("quiet"),
        translator_url: None,
        format,
        style: if json {
            style::Style::new(false)
        } else {
            style::Style::from_when(color)
        },
    };
    if !json && !g.quiet {
        let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn"))
            .try_init();
    }
    agentero_core::features::import::institution_proxy::load_institution_proxy_from_settings();
    agentero_core::features::import::openreview::load_openreview_from_settings();
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => return fail(e.into(), json),
    };
    let plain = args["plain"] == true;
    let cancelled = Arc::new(AtomicBool::new(false));
    let probe = Arc::clone(&cancelled);
    agentero_core::cancel::install_cancel_probe(move |id| {
        id == CLI_TASK_ID && probe.load(Ordering::Acquire)
    });
    let (interrupted,result)=runtime.block_on(async {
        let work=dispatch::run(op,args,&g);
        tokio::pin!(work);
        if path=="mcp serve"{return (false,Some(work.await))}
        tokio::select!{
            output=&mut work=>(false,Some(output)),
            _=tokio::signal::ctrl_c()=>{
                cancelled.store(true,Ordering::Release);
                let finish_write=agentero_core::ops::get(&path.replace(' ',".")).is_some_and(|o|matches!(o.side_effects,agentero_core::ops::OpSideEffect::Write|agentero_core::ops::OpSideEffect::Destructive));
                let receipt=if finish_write{Some(work.await)}else{None};
                (true,receipt)
            }
        }
    });
    if interrupted {
        let details = match result {
            Some(Ok(receipt)) => json!({"completed":receipt}),
            Some(Err(err)) => {
                json!({"cause":{"code":err.code,"message":err.message,"details":err.details}})
            }
            None => json!({}),
        };
        if json {
            eprintln!(
                "{}",
                json!({"error":{"code":"interrupted","message":"interrupted","details":details,"hint":"Inspect the operation receipt before retrying."}})
            )
        } else {
            eprintln!("Interrupted. {details}")
        }
        return ExitCode::from(130);
    }
    let result = result.expect("completed operation has an outcome");
    let partial = result.as_ref().is_ok_and(|v| {
        v["items"]
            .as_array()
            .is_some_and(|items| items.iter().any(|i| i["outcome"] == "failed"))
    });
    match result {
        Ok(result) => match print_result(&path, result, json, plain, g.style) {
            Ok(()) if partial => fail(
                CliError::message("Some items failed. Retry only the failed items."),
                json,
            ),
            Ok(()) => ExitCode::SUCCESS,
            Err(err) if err.kind() == io::ErrorKind::BrokenPipe => ExitCode::SUCCESS,
            Err(e) => fail(e.into(), json),
        },
        Err(e) => fail(e, json),
    }
}

fn print_result(
    path: &str,
    mut data: Value,
    json_mode: bool,
    plain: bool,
    style: style::Style,
) -> io::Result<()> {
    if path == "mcp serve" {
        return Ok(());
    }
    let lines = data.as_object_mut().and_then(|obj| obj.remove("lines"));
    let mut stdout = io::stdout().lock();
    if json_mode {
        writeln!(stdout, "{data}")
    } else if plain {
        let key = if path == "search" { "cite" } else { "id" };
        for item in data["items"].as_array().into_iter().flatten() {
            if let Some(id) = item[key].as_str() {
                writeln!(stdout, "{id}")?;
            }
        }
        Ok(())
    } else if let Some(raw) = data["text"].as_str().or_else(|| data["content"].as_str()) {
        write!(stdout, "{raw}")
    } else if let Some(lines) = lines.as_ref().and_then(Value::as_array) {
        for line in lines.iter().filter_map(Value::as_str) {
            writeln!(stdout, "{line}")?;
        }
        Ok(())
    } else if let Some(items) = data["items"]
        .as_array()
        .or_else(|| data["tools"].as_array())
    {
        for item in items {
            let label = ["id", "path", "source", "region", "name", "identifier"]
                .iter()
                .find_map(|k| item[k].as_str());
            let detail = [
                "title",
                "excerpt",
                "outcome",
                "description",
                "name",
                "message",
            ]
            .iter()
            .find_map(|k| item[k].as_str())
            .unwrap_or("");
            if let Some(label) = label {
                write!(stdout, "{}", style.path(label))?;
                if !detail.is_empty() && detail != label {
                    write!(stdout, "  {detail}")?;
                }
                writeln!(stdout)?;
                if let Some(cite) = item["cite"].as_str() {
                    writeln!(stdout, "  {}", style.dim(cite))?;
                }
            } else {
                writeln!(stdout, "{item}")?;
            }
        }
        Ok(())
    } else if let Some(obj) = data.as_object() {
        for (key, value) in obj {
            if value.is_null() {
                continue;
            }
            write!(stdout, "{}  ", style.bold(key))?;
            if let Some(text) = value.as_str() {
                writeln!(stdout, "{text}")?;
            } else {
                writeln!(stdout, "{value}")?;
            }
        }
        Ok(())
    } else {
        writeln!(stdout, "{data}")
    }
}

fn fail(e: CliError, json_mode: bool) -> ExitCode {
    let hint = match e.code.as_str() {
        "ambiguous_quote" | "ambiguous_section" | "paper_ambiguous" | "ambiguous" => {
            "Choose one of the candidates in details and retry with its citation, locator, or path."
        }
        "revision_conflict" => "Read the current revision before retrying.",
        "scope_denied" | "permission_denied" => "Select a source in the authorized scope.",
        "vault_required" | "vault_not_found" => "Run agentero vault list or specify --vault.",
        "stale_citation" | "stale_cursor" => "Repeat the original search or listing.",
        "usage" => "Run the command with --help.",
        _ => "",
    };
    if json_mode {
        eprintln!(
            "{}",
            json!({"error":{"code":e.code,"message":e.message,"details":e.details,"hint":hint}})
        )
    } else {
        eprintln!("{} ({})", e.message, e.code);
        if !hint.is_empty() {
            eprintln!("{hint}")
        }
    }
    ExitCode::from(e.exit_code() as u8)
}

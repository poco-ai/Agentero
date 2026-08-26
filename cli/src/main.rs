//! Agentero headless CLI (`agentero`).
//!
//! Vault / Catalog machine interface — no BYOA, no paper-reader.
//! See `docs/development/cli.md`.

mod args_rewrite;
mod commands;
mod config;
mod error;
mod output;
mod prompt;
mod resolve;
mod style;

use clap::builder::styling::{AnsiColor, Effects, Styles};
use clap::{ColorChoice, CommandFactory, FromArgMatches, Parser, Subcommand, ValueEnum, ValueHint};
use error::{CliError, ExitCode};
use output::{emit_err, emit_ok, OutputFormat};
use resolve::GlobalOpts;
use std::path::PathBuf;
use std::process::ExitCode as StdExitCode;
use style::Style;

#[derive(Debug, Clone, Copy, ValueEnum)]
enum ColorWhen {
    Auto,
    Always,
    Never,
}

impl From<ColorWhen> for style::ColorWhen {
    fn from(w: ColorWhen) -> Self {
        match w {
            ColorWhen::Auto => style::ColorWhen::Auto,
            ColorWhen::Always => style::ColorWhen::Always,
            ColorWhen::Never => style::ColorWhen::Never,
        }
    }
}

/// High-contrast help styles so sections / flags / placeholders are easy to scan.
///
/// | Part | Color | Examples |
/// |---|---|---|
/// | header | magenta + bold + underline | `Commands:`, `Options:` |
/// | usage | bright white + bold | `Usage:` |
/// | literal | bright green + bold | `paper`, `--vault`, `list` |
/// | placeholder | bright yellow | `<PATH>`, `<COMMAND>` |
/// | valid | bright cyan | `text`, `json`, `auto` |
/// | error / invalid | bright red + bold | parse errors |
fn clap_styles() -> Styles {
    Styles::styled()
        .header(
            AnsiColor::BrightMagenta
                .on_default()
                .effects(Effects::BOLD | Effects::UNDERLINE),
        )
        .usage(AnsiColor::BrightWhite.on_default().effects(Effects::BOLD))
        .literal(AnsiColor::BrightGreen.on_default().effects(Effects::BOLD))
        .placeholder(AnsiColor::BrightYellow.on_default())
        .valid(AnsiColor::BrightCyan.on_default())
        .invalid(AnsiColor::BrightRed.on_default().effects(Effects::BOLD))
        .error(AnsiColor::BrightRed.on_default().effects(Effects::BOLD))
}

/// Peek `--color` before full parse so help itself is styled correctly.
///
/// Priority: explicit `--color` → `CLICOLOR_FORCE` → `NO_COLOR` / `CLICOLOR=0` → auto.
fn peek_color_when() -> ColorWhen {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--color" {
            return match args.next().as_deref() {
                Some("always") => ColorWhen::Always,
                Some("never") => ColorWhen::Never,
                Some("auto") | None => ColorWhen::Auto,
                Some(_) => ColorWhen::Auto,
            };
        }
        if let Some(v) = arg.strip_prefix("--color=") {
            return match v {
                "always" => ColorWhen::Always,
                "never" => ColorWhen::Never,
                _ => ColorWhen::Auto,
            };
        }
    }
    // Env only applies when the flag is omitted.
    if matches!(
        std::env::var("CLICOLOR_FORCE").as_deref(),
        Ok(v) if v != "0" && !v.is_empty()
    ) {
        return ColorWhen::Always;
    }
    if std::env::var_os("NO_COLOR").is_some()
        || matches!(std::env::var("CLICOLOR").as_deref(), Ok("0"))
    {
        return ColorWhen::Never;
    }
    ColorWhen::Auto
}

fn color_choice(when: ColorWhen) -> ColorChoice {
    match when {
        ColorWhen::Auto => ColorChoice::Auto,
        ColorWhen::Always => ColorChoice::Always,
        ColorWhen::Never => ColorChoice::Never,
    }
}

#[derive(Debug, Parser)]
#[command(
    name = "agentero",
    version,
    about = "Agentero headless CLI — Vault / Catalog machine interface (no BYOA)",
    long_about = "Discover, manage, and expose a local Agentero research vault and catalog.\n\
                  Does not run agents or paper-reader. Prefer --json for scripts and external agents.\n\
                  Open a vault in the desktop app: `agentero open <PATH>` or `agentero <PATH>`.\n\
                  Design: docs/backend/cli.md",
    styles = clap_styles(),
    propagate_version = true
)]
struct Cli {
    /// Vault root (absolute or relative). Overrides env / walk-up / config.
    #[arg(
        short = 'v',
        long = "vault",
        global = true,
        value_name = "PATH",
        value_hint = ValueHint::DirPath
    )]
    vault: Option<PathBuf>,

    /// Emit JSON on stdout (alias for `-o json`).
    #[arg(long = "json", global = true)]
    json: bool,

    /// Output format (`text` | `json`). Prefer `--json` for scripts.
    /// Note: short `-o` is reserved for command-local file outputs (e.g. `export bib -o`).
    #[arg(long = "output", global = true, value_enum, default_value = "text")]
    output: OutputFormat,

    /// Pretty-print JSON output (default: compact single line, cheaper for agents).
    #[arg(long = "pretty", global = true)]
    pretty: bool,

    /// Quiet success messages (errors still on stderr).
    #[arg(short = 'q', long = "quiet", global = true)]
    quiet: bool,

    /// Skip confirmation for destructive ops.
    #[arg(short = 'y', long = "yes", global = true)]
    yes: bool,

    /// Override Translator base URL.
    #[arg(
        long = "translator-url",
        global = true,
        value_name = "URL",
        value_hint = ValueHint::Url
    )]
    translator_url: Option<String>,

    /// Colorize help and text output (`auto` = TTY; `always` / `never` force).
    #[arg(long = "color", global = true, value_enum, default_value = "auto")]
    color: ColorWhen,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Vault lifecycle: create, resolve, inspect.
    Vault {
        #[command(subcommand)]
        cmd: commands::vault::VaultCmd,
    },
    /// List vault-relative file tree.
    Tree {
        /// Subpath under vault (default: root).
        #[arg(value_hint = ValueHint::AnyPath)]
        path: Option<String>,
        /// Max depth (default 3; -1 = unlimited).
        #[arg(long = "depth", default_value = "3")]
        depth: i32,
    },
    /// Paper catalog operations.
    Paper {
        #[command(subcommand)]
        cmd: commands::paper::PaperCmd,
    },
    /// Import papers into the vault.
    Import {
        #[command(subcommand)]
        cmd: commands::import::ImportCmd,
    },
    /// Export catalog data.
    Export {
        #[command(subcommand)]
        cmd: commands::export::ExportCmd,
    },
    /// List and manage the local recycle bin.
    Trash {
        #[command(subcommand)]
        cmd: commands::trash::TrashCmd,
    },
    /// CLI-only configuration (not GUI settings).
    Config {
        #[command(subcommand)]
        cmd: commands::config_cmd::ConfigCmd,
    },
    /// Inspect Vault-local wikilinks.
    Wiki {
        #[command(subcommand)]
        cmd: commands::wiki::WikiCmd,
    },
    /// Diagnose Vault structure, Catalog, wikilinks, and paper aliases.
    Doctor {
        #[command(subcommand)]
        cmd: Option<commands::doctor::DoctorCmd>,
    },
    /// Sidebar layout index (figures / tables / algorithms / formulas).
    Layout {
        #[command(subcommand)]
        cmd: commands::layout::LayoutCmd,
    },
    /// Reading marks (region-anchored annotations).
    Mark {
        #[command(subcommand)]
        cmd: commands::mark::MarkCmd,
    },
    /// Translate text with free machine translation (no API key).
    Translate {
        /// Text to translate.
        text: String,
        /// Target language (default zh-CN).
        #[arg(long = "to", value_name = "LANG", default_value = "zh-CN")]
        to: String,
        /// Source language (default auto).
        #[arg(long = "from", value_name = "LANG", default_value = "auto")]
        from: String,
        /// Pick one free engine instead of racing the defaults.
        #[arg(long = "provider", value_name = "ID")]
        provider: Option<String>,
    },
    /// Device-local activity log (XDG usage.sqlite).
    Usage {
        #[command(subcommand)]
        cmd: commands::usage::UsageCmd,
    },
    /// Plaza RSS / Atom subscriptions (XDG feeds.sqlite).
    Feed {
        #[command(subcommand)]
        cmd: commands::feed::FeedCmd,
    },
    /// Start a Model Context Protocol server over stdio for external AI clients.
    Mcp,
    /// Open a local directory as a Vault in the desktop App.
    ///
    /// Shorthand: bare `agentero <PATH>` rewrites to this when `<PATH>` looks like
    /// a directory path and is not a known subcommand.
    Open {
        /// Local directory to open (absolute, relative, or `~`).
        #[arg(value_hint = ValueHint::DirPath)]
        path: PathBuf,
    },
    /// Generate shell completion script (bash / zsh / fish / powershell / elvish).
    ///
    /// Prints the script to stdout. `--install` writes it into the user
    /// completion directory and does not edit shell rc files.
    Completion {
        /// Target shell.
        shell: clap_complete::Shell,
        /// Write the script to the user completion directory.
        #[arg(long = "install")]
        install: bool,
        /// Command name to complete (`agentero` or `agentero-cli`).
        #[arg(long = "bin-name", value_name = "NAME")]
        bin_name: Option<String>,
    },
}

fn init_logging() {
    // Logs go to stderr so `--json` stdout stays a pure business envelope.
    // Default is quiet (warn+ only): everyday CLI use should not print op start/end.
    // Opt in: `RUST_LOG=info agentero …` or `RUST_LOG=agentero::op=info,agentero_lib=debug`.
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn"))
        .format_timestamp_secs()
        .try_init();
}

fn main() -> StdExitCode {
    if let Some(status) = agentero_lib::features::import::pdf_parse::try_run_pdf_parse_worker() {
        return StdExitCode::from(status as u8);
    }
    init_logging();

    // `agentero <dir>` → `agentero open <dir>` before clap (subcommand names win).
    let argv = args_rewrite::rewrite_path_shorthand(std::env::args_os().collect());

    // Apply color choice before parse so `--help` / usage errors use the same styles.
    let mut cmd = Cli::command()
        .styles(clap_styles())
        .color(color_choice(peek_color_when()));
    let matches = match cmd.try_get_matches_from_mut(argv) {
        Ok(m) => m,
        Err(err) => {
            // clap prints help / usage itself (styled).
            err.exit();
        }
    };
    let cli = match Cli::from_arg_matches(&matches) {
        Ok(c) => c,
        Err(err) => err.exit(),
    };

    // Honor AGENTERO_OUTPUT when -o / --json not set explicitly via env default later.
    let format = resolve_format(&cli);
    // JSON must never carry ANSI; text paints when --color allows + TTY (auto).
    let style = match format {
        OutputFormat::Json => Style::new(false),
        OutputFormat::Text => Style::from_when(cli.color.into()),
    };
    let globals = GlobalOpts {
        vault_flag: cli.vault.clone(),
        yes: cli.yes,
        quiet: cli.quiet,
        translator_url: cli.translator_url.clone(),
        format,
        pretty: cli.pretty,
        style,
    };

    let cmd_name = command_label(&cli.command);
    let start = std::time::Instant::now();
    log::info!(target: "agentero::op", "op start {cmd_name}");

    // Completion scripts must be raw stdout — never wrap in the JSON/text envelope.
    if let Commands::Completion {
        shell,
        install,
        bin_name,
    } = cli.command
    {
        return match commands::completion::run(
            shell,
            install,
            bin_name.as_deref(),
            Cli::command(),
            &globals,
        ) {
            Ok(None) => {
                log::info!(
                    target: "agentero::op",
                    "op end {cmd_name} ok=true duration_ms={}",
                    start.elapsed().as_millis()
                );
                StdExitCode::SUCCESS
            }
            Ok(Some(value)) => finish_ok(cmd_name, start, &globals, &value),
            Err(err) => finish_err(cmd_name, start, &globals, err),
        };
    }

    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            log::error!("failed to start async runtime: {e}");
            eprintln!("failed to start async runtime: {e}");
            return StdExitCode::from(ExitCode::Business as u8);
        }
    };

    // MCP owns stdout for JSON-RPC messages, so never send it through the CLI
    // result envelope. Stderr remains available for diagnostics.
    if matches!(&cli.command, Commands::Mcp) {
        return match rt.block_on(commands::mcp::serve(&globals)) {
            Ok(()) => StdExitCode::SUCCESS,
            Err(err) => {
                log::error!("MCP server stopped with error: {err}");
                eprintln!("{err}");
                StdExitCode::from(err.exit_code() as u8)
            }
        };
    }

    let result = rt.block_on(run(cli.command, &globals));
    match result {
        Ok(value) => finish_ok(cmd_name, start, &globals, &value),
        Err(err) => finish_err(cmd_name, start, &globals, err),
    }
}

fn finish_ok(
    cmd_name: &str,
    start: std::time::Instant,
    globals: &GlobalOpts,
    value: &serde_json::Value,
) -> StdExitCode {
    if let Err(e) = emit_ok(globals, value) {
        log::error!(
            target: "agentero::op",
            "op end {cmd_name} ok=false duration_ms={} error={}",
            start.elapsed().as_millis(),
            e
        );
        eprintln!("{e}");
        return StdExitCode::from(ExitCode::Business as u8);
    }
    log::info!(
        target: "agentero::op",
        "op end {cmd_name} ok=true duration_ms={}",
        start.elapsed().as_millis()
    );
    StdExitCode::SUCCESS
}

fn finish_err(
    cmd_name: &str,
    start: std::time::Instant,
    globals: &GlobalOpts,
    err: CliError,
) -> StdExitCode {
    log::error!(
        target: "agentero::op",
        "op end {cmd_name} ok=false duration_ms={} error_code={} error={}",
        start.elapsed().as_millis(),
        err.code,
        err.message
    );
    let code = err.exit_code();
    let _ = emit_err(globals, &err);
    StdExitCode::from(code as u8)
}

fn command_label(cmd: &Commands) -> &'static str {
    match cmd {
        Commands::Vault { cmd } => match cmd {
            commands::vault::VaultCmd::Create { .. } => "cli.vault.create",
            commands::vault::VaultCmd::Which => "cli.vault.which",
            commands::vault::VaultCmd::Info => "cli.vault.info",
            commands::vault::VaultCmd::Check => "cli.vault.check",
            commands::vault::VaultCmd::Use { .. } => "cli.vault.use",
        },
        Commands::Tree { .. } => "cli.tree",
        Commands::Paper { .. } => "cli.paper",
        Commands::Import { .. } => "cli.import",
        Commands::Export { .. } => "cli.export",
        Commands::Trash { .. } => "cli.trash",
        Commands::Config { .. } => "cli.config",
        Commands::Wiki { .. } => "cli.wiki",
        Commands::Doctor { .. } => "cli.doctor",
        Commands::Layout { .. } => "cli.layout",
        Commands::Mark { .. } => "cli.mark",
        Commands::Translate { .. } => "cli.translate",
        Commands::Usage { .. } => "cli.usage",
        Commands::Feed { .. } => "cli.feed",
        Commands::Mcp => "cli.mcp",
        Commands::Open { .. } => "cli.open",
        Commands::Completion { .. } => "cli.completion",
    }
}

fn resolve_format(cli: &Cli) -> OutputFormat {
    if cli.json {
        return OutputFormat::Json;
    }
    if matches!(cli.output, OutputFormat::Json) {
        return OutputFormat::Json;
    }
    match std::env::var("AGENTERO_OUTPUT")
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "json" => OutputFormat::Json,
        _ => cli.output,
    }
}

async fn run(command: Commands, globals: &GlobalOpts) -> Result<serde_json::Value, CliError> {
    match command {
        Commands::Vault { cmd } => commands::vault::run(cmd, globals).await,
        Commands::Tree { path, depth } => commands::tree::run(path.as_deref(), depth, globals),
        Commands::Paper { cmd } => commands::paper::run(cmd, globals).await,
        Commands::Import { cmd } => commands::import::run(cmd, globals).await,
        Commands::Export { cmd } => commands::export::run(cmd, globals).await,
        Commands::Trash { cmd } => commands::trash::run(cmd, globals),
        Commands::Config { cmd } => commands::config_cmd::run(cmd, globals),
        Commands::Wiki { cmd } => commands::wiki::run(cmd, globals),
        Commands::Doctor { cmd } => commands::doctor::run(cmd, globals),
        Commands::Layout { cmd } => commands::layout::run(cmd, globals),
        Commands::Mark { cmd } => commands::mark::run(cmd, globals).await,
        Commands::Translate {
            text,
            to,
            from,
            provider,
        } => commands::translate::run(&text, &to, &from, provider.as_deref(), globals).await,
        Commands::Usage { cmd } => commands::usage::run(cmd, globals),
        Commands::Feed { cmd } => commands::feed::run(cmd, globals).await,
        Commands::Mcp => unreachable!("handled before normal CLI result emission"),
        Commands::Open { path } => commands::open::run(&path, globals),
        Commands::Completion { .. } => unreachable!("handled before async runtime"),
    }
}

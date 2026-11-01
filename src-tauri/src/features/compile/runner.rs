#[cfg(not(windows))]
use super::forward_lines;
use super::{
    diagnostics::{parse_diagnostics, read_fls},
    latexmk_engine_flag, line_milestone, resolve_engine,
    tools::prepare_command,
    types::{
        artifacts, compiler_kind, expand, is_latexmk, tool_directory, tool_option, CompilerKind,
        LatexArtifacts, LatexBuildOptions, LatexCompileResult, LatexTool,
    },
    CompileProgress, LatexCompileParams, ERROR_TAIL_LINES,
};
use crate::features::jobs::{emit_job_changed, JobCenter, RunOutcome, StartedJob};
use std::{
    collections::BTreeMap,
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
};

#[cfg(windows)]
use std::io::{Read, Seek, SeekFrom};
use tauri::Emitter;

fn environment_value<'a>(environment: &'a BTreeMap<String, String>, name: &str) -> Option<&'a str> {
    // Match Command::envs precedence when a Windows recipe contains e.g.
    // both PATH and Path: environment names are case-insensitive there.
    environment.iter().rev().find_map(|(key, value)| {
        let matches = if cfg!(windows) {
            key.eq_ignore_ascii_case(name)
        } else {
            key == name
        };
        matches.then_some(value.as_str())
    })
}

/// TeX Live wraps log and terminal lines at `max_print_line` (79 columns by
/// default). Under a long project path that splits `file:line: message`
/// errors and file names across lines, and the diagnostics parsers read one
/// line at a time. MiKTeX ignores the variable.
const MAX_PRINT_LINE: &str = "max_print_line";
const UNWRAPPED_LOG_WIDTH: &str = "10000";

fn tool_environment(
    tool: &LatexTool,
    root: &Path,
    artifact: &LatexArtifacts,
) -> BTreeMap<String, String> {
    let mut environment = tool
        .env
        .iter()
        .flat_map(|environment| environment.iter())
        .map(|(key, value)| (key.clone(), expand(value, root, artifact)))
        .collect();
    widen_log_lines(&mut environment, std::env::var_os(MAX_PRINT_LINE).is_some());
    environment
}

/// A width set by the recipe or inherited from the user's environment wins.
fn widen_log_lines(environment: &mut BTreeMap<String, String>, inherited: bool) {
    if !inherited && environment_value(environment, MAX_PRINT_LINE).is_none() {
        environment.insert(MAX_PRINT_LINE.into(), UNWRAPPED_LOG_WIDTH.into());
    }
}

#[cfg(windows)]
fn windows_executable_path(
    command: &str,
    cwd: &Path,
    environment: &BTreeMap<String, String>,
) -> Option<PathBuf> {
    let path = Path::new(command);
    let directories = if path.is_absolute() || path.components().count() > 1 {
        vec![cwd.to_path_buf()]
    } else {
        let paths = environment_value(environment, "PATH")
            .map(std::ffi::OsString::from)
            .or_else(|| std::env::var_os("PATH"))?;
        std::env::split_paths(&paths)
            .map(|path| {
                if path.is_absolute() {
                    path
                } else {
                    cwd.join(path)
                }
            })
            .collect()
    };
    let extensions = environment_value(environment, "PATHEXT")
        .map(String::from)
        .or_else(|| std::env::var("PATHEXT").ok())
        .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".into());
    for directory in directories {
        let candidate = super::root::normalize_lexical(&directory.join(path));
        if candidate.is_file() {
            return Some(candidate);
        }
        // PATHEXT belongs to this recipe, rather than which's cached copy of
        // the host environment. Never mutate the process-wide environment.
        for extension in extensions.split(';').filter(|value| !value.is_empty()) {
            let mut filename = candidate.as_os_str().to_os_string();
            filename.push(extension);
            let candidate = PathBuf::from(filename);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn executable_path(
    command: &str,
    cwd: &Path,
    environment: &BTreeMap<String, String>,
) -> Option<PathBuf> {
    #[cfg(windows)]
    if environment_value(environment, "PATH").is_some()
        || environment_value(environment, "PATHEXT").is_some()
    {
        return windows_executable_path(command, cwd, environment);
    }
    let path = Path::new(command);
    if path.is_absolute() {
        Some(path.to_path_buf())
    } else if path.components().count() > 1 {
        Some(super::root::normalize_lexical(&cwd.join(path)))
    } else if let Some(paths) = environment_value(environment, "PATH") {
        // The recipe's PATH is a replacement. A miss must not fall back to
        // the host PATH or launch an unrelated system tool of the same name.
        let paths = std::env::join_paths(std::env::split_paths(paths).map(|path| {
            if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            }
        }))
        .ok()?;
        which::which_in(command, Some(paths), cwd).ok()
    } else {
        resolve_engine(command)
    }
}

fn tool_arguments(
    tool: &LatexTool,
    root: &Path,
    artifact: &LatexArtifacts,
    options: &LatexBuildOptions,
) -> Vec<String> {
    let compiler = compiler_kind(&expand(&tool.command, root, artifact));
    // Helpers may intentionally use their own output flags for intermediate
    // artifacts. Only TeX compiler invocations inherit project output settings.
    if compiler.is_none() {
        return tool
            .args
            .iter()
            .map(|value| expand(value, root, artifact))
            .collect();
    }
    let mut args = Vec::new();
    let mut skip = false;
    for (index, arg) in tool.args.iter().enumerate() {
        if skip {
            skip = false;
            continue;
        }
        let (flag, value) = arg
            .split_once('=')
            .map(|(a, b)| (a, Some(b)))
            .unwrap_or((arg.as_str(), tool.args.get(index + 1).map(String::as_str)));
        let replacement = match flag.trim_start_matches('-') {
            "outdir" | "output-directory" => Some(artifact.out_dir.clone()),
            "auxdir" | "aux-directory" => Some(artifact.aux_dir.clone()),
            "jobname" => Some(
                Path::new(&artifact.pdf_path)
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
            ),
            _ => None,
        };
        if let (Some(replacement), Some(_)) = (replacement, value) {
            if arg.contains('=') {
                args.push(format!("{flag}={replacement}"));
            } else {
                args.push(flag.into());
                args.push(replacement);
                skip = true;
            }
        } else {
            args.push(expand(arg, root, artifact));
        }
    }
    if (options.force || options.clean)
        && is_latexmk(&expand(&tool.command, root, artifact))
        && !args
            .iter()
            .any(|arg| ["-g", "-gg", "--g", "--gg"].contains(&arg.as_str()))
    {
        args.retain(|arg| arg != "-g-");
        args.insert(0, "-g".into());
    }
    let selected = |value: &Option<String>| {
        value
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
    };
    let mut extra = Vec::new();
    if selected(&options.out_dir) && tool_option(tool, &["outdir", "output-directory"]).is_none() {
        let flag = match compiler {
            Some(CompilerKind::Latexmk) => "-outdir",
            Some(CompilerKind::Tectonic) => "--outdir",
            _ => "-output-directory",
        };
        extra.push(format!("{flag}={}", artifact.out_dir));
    }
    if compiler == Some(CompilerKind::Latexmk)
        && selected(&options.aux_dir)
        && tool_option(tool, &["auxdir", "aux-directory"]).is_none()
    {
        extra.push(format!("-auxdir={}", artifact.aux_dir));
    }
    if matches!(compiler, Some(CompilerKind::Latexmk | CompilerKind::Tex))
        && selected(&options.jobname)
        && tool_option(tool, &["jobname"]).is_none()
    {
        let name = Path::new(&artifact.pdf_path)
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy();
        extra.push(format!("-jobname={name}"));
    }
    // TeX stops option parsing at the input file, so selected options precede
    // the recipe argv rather than being appended after `%DOC%`.
    extra.extend(args);
    extra
}

/// One captured stream. Bytes stay in `carry` until a newline arrives.
#[cfg(windows)]
struct LogCursor {
    pos: u64,
    carry: String,
}

#[cfg(windows)]
impl LogCursor {
    fn new() -> Self {
        Self {
            pos: 0,
            carry: String::new(),
        }
    }

    fn pull(&mut self, path: &Path, flush: bool) -> Vec<String> {
        let mut file = match std::fs::OpenOptions::new().read(true).open(path) {
            Ok(file) => file,
            Err(_) => return Vec::new(),
        };
        let end = file.seek(SeekFrom::End(0)).unwrap_or(self.pos);
        if end < self.pos {
            self.pos = 0;
        }
        if end > self.pos && file.seek(SeekFrom::Start(self.pos)).is_ok() {
            let mut buf = vec![0_u8; (end - self.pos) as usize];
            if let Ok(read) = file.read(&mut buf) {
                if read > 0 {
                    self.pos += read as u64;
                    self.carry.push_str(&String::from_utf8_lossy(&buf[..read]));
                }
            }
        }
        let mut lines = Vec::new();
        while let Some(index) = self.carry.find('\n') {
            let mut line: String = self.carry.drain(..=index).collect();
            line.pop();
            if line.ends_with('\r') {
                line.pop();
            }
            lines.push(line);
        }
        if flush && !self.carry.is_empty() {
            lines.push(std::mem::take(&mut self.carry));
        }
        lines
    }
}

/// stdout/stderr files for one tool. Dropped after the process exits.
#[cfg(windows)]
struct CaptureLogs {
    stdout_path: PathBuf,
    stderr_path: PathBuf,
}

#[cfg(windows)]
impl CaptureLogs {
    fn create(index: usize) -> std::io::Result<(Self, std::fs::File, std::fs::File)> {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let stem = format!("agentero-tex-{}-{index}-{nonce}", std::process::id());
        let dir = std::env::temp_dir();
        let stdout_path = dir.join(format!("{stem}.out"));
        let stderr_path = dir.join(format!("{stem}.err"));
        let stdout = std::fs::File::create(&stdout_path)?;
        let stderr = match std::fs::File::create(&stderr_path) {
            Ok(file) => file,
            Err(error) => {
                let _ = std::fs::remove_file(&stdout_path);
                return Err(error);
            }
        };
        Ok((
            Self {
                stdout_path,
                stderr_path,
            },
            stdout,
            stderr,
        ))
    }
}

#[cfg(windows)]
impl Drop for CaptureLogs {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.stdout_path);
        let _ = std::fs::remove_file(&self.stderr_path);
    }
}

#[allow(clippy::too_many_arguments)]
async fn note_compile_line(
    line: &str,
    logfile: &mut std::fs::File,
    output: &mut String,
    tail: &mut std::collections::VecDeque<String>,
    app: &tauri::AppHandle,
    job_id: &str,
    root_path: &str,
    progress: &mut CompileProgress,
    index: usize,
    total: usize,
    center: &JobCenter,
) {
    let _ = writeln!(logfile, "{line}");
    output.push_str(line);
    output.push('\n');
    if tail.len() == ERROR_TAIL_LINES {
        tail.pop_front();
    }
    tail.push_back(line.to_string());
    let _ = app.emit(
        "compile:log",
        serde_json::json!({"jobId": job_id, "rootPath": root_path, "line": line}),
    );
    if let Some((value, phase)) = line_milestone(line)
        .and_then(|(value, phase)| progress.advance((index as f32 + value) / total as f32, phase))
    {
        if let Some(snapshot) = center
            .job_report(job_id, Some(value), Some(phase), None, None)
            .await
        {
            emit_job_changed(app, snapshot);
        }
    }
}

async fn wait_or_cancel(
    child: &mut crate::core::process::ProcessTree,
    token: &tokio_util::sync::CancellationToken,
) -> std::io::Result<Option<std::process::ExitStatus>> {
    tokio::select! {
        biased;
        _=token.cancelled()=>{terminate(child).await;Ok(None)},
        status=child.wait()=>status.map(Some),
    }
}

fn clean_tool(root: &Path, artifact: &LatexArtifacts) -> LatexTool {
    let name = Path::new(&artifact.pdf_path)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();
    LatexTool {
        command: "latexmk".into(),
        args: vec![
            "-c".into(),
            format!("-outdir={}", artifact.out_dir),
            format!("-auxdir={}", artifact.aux_dir),
            format!("-jobname={name}"),
            root.to_string_lossy().into_owned(),
        ],
        env: None,
        cwd: None,
    }
}

async fn terminate(child: &mut crate::core::process::ProcessTree) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // Each tool has its own process group, including latexmk's engine
        // and bibliography descendants that inherit the output pipes.
        let _ = tokio::process::Command::new("/bin/kill")
            .args(["-KILL", "--", &format!("-{pid}")])
            .status()
            .await;
    }
    // Windows closes the job inside `kill`, which ends the launcher and the
    // engines it spawned. `taskkill /T` raced that tree and missed processes
    // that had already been reparented.
    let _ = child.kill().await;
    let _ = child.wait().await;
}

pub(super) async fn run_latexmk(
    center: &JobCenter,
    app: &tauri::AppHandle,
    started: &StartedJob,
    params: LatexCompileParams,
) -> RunOutcome {
    let root = PathBuf::from(&params.tex_path);
    let options = params.build.unwrap_or_default();
    let artifact = match artifacts(&root, &options) {
        Ok(value) => value,
        Err(e) => return RunOutcome::Failed(Some(e)),
    };
    if !root.is_file() {
        return RunOutcome::Failed(Some(format!("tex file not found: {}", root.display())));
    }
    let cwd = root.parent().unwrap_or(Path::new("."));
    for dir in [&artifact.out_dir, &artifact.aux_dir] {
        if let Err(e) = std::fs::create_dir_all(dir) {
            return RunOutcome::Failed(Some(format!("cannot create build directory: {e}")));
        }
    }
    let mut logfile = match std::fs::File::create(&artifact.log_path) {
        Ok(value) => value,
        Err(e) => return RunOutcome::Failed(Some(format!("cannot create build log: {e}"))),
    };
    let mut tools = Vec::new();
    if options.clean {
        tools.push(clean_tool(&root, &artifact));
    }
    if let Some(recipe) = &options.recipe {
        if recipe.tools.is_empty() || recipe.tools.len() > 32 {
            return RunOutcome::Failed(Some(
                "a build recipe must contain between 1 and 32 tools".into(),
            ));
        }
        tools.extend(recipe.tools.clone());
    } else {
        let Some(flag) = latexmk_engine_flag(&params.engine) else {
            return RunOutcome::Failed(Some(format!("unknown latex engine: {}", params.engine)));
        };
        let mut args = vec![
            flag.into(),
            "-interaction=nonstopmode".into(),
            "-halt-on-error".into(),
            "-file-line-error".into(),
            "-synctex=1".into(),
            "-recorder".into(),
            format!("-outdir={}", artifact.out_dir),
        ];
        if artifact.aux_dir != artifact.out_dir {
            args.push(format!("-auxdir={}", artifact.aux_dir));
        }
        if options.force || options.clean {
            args.push("-g".into());
        }
        if let Some(name) = &options.jobname {
            args.push(format!("-jobname={name}"));
        }
        args.push(root.to_string_lossy().into_owned());
        tools.push(LatexTool {
            command: "latexmk".into(),
            args,
            env: None,
            cwd: None,
        });
    }
    let mut output = String::new();
    let mut tail = std::collections::VecDeque::new();
    let mut outcome = RunOutcome::Succeeded;
    let mut progress = CompileProgress::default();
    let total = tools.len();
    for (index, tool) in tools.into_iter().enumerate() {
        if started.cancel_token.is_cancelled() {
            outcome = RunOutcome::Cancelled;
            break;
        }
        let command_name = expand(&tool.command, &root, &artifact);
        let tool_dir = tool_directory(&tool, &root, &artifact);
        let environment = tool_environment(&tool, &root, &artifact);
        let Some(executable) = executable_path(&command_name, &tool_dir, &environment) else {
            outcome = RunOutcome::Failed(Some(format!("{command_name} not found on this system")));
            break;
        };
        let args = tool_arguments(&tool, &root, &artifact, &options);
        let mut command = tokio::process::Command::new(&executable);
        prepare_command(&mut command, &executable);
        #[cfg(unix)]
        command.process_group(0);
        command
            .args(&args)
            .current_dir(tool_dir)
            .stdin(Stdio::null());
        // pdfTeX's fflush returns EINVAL when stdout is a pipe on Windows
        // (no console, and latexmk switches the console code page). A file
        // flushes. The live log is tailed from that file.
        #[cfg(windows)]
        let (captured, stdout_file, stderr_file) = match CaptureLogs::create(index) {
            Ok(value) => value,
            Err(error) => {
                outcome = RunOutcome::Failed(Some(format!(
                    "cannot capture {command_name} output: {error}"
                )));
                break;
            }
        };
        #[cfg(windows)]
        command
            .stdout(Stdio::from(stdout_file))
            .stderr(Stdio::from(stderr_file));
        #[cfg(not(windows))]
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        command.envs(environment);
        let description = format!(
            "[{} / {total}] {command_name} {}",
            index + 1,
            args.join(" ")
        );
        let _ = writeln!(logfile, "{description}");
        let _ = app.emit("compile:log",serde_json::json!({"jobId":started.snapshot.id,"rootPath":params.tex_path,"line":description}));
        let mut child = match crate::core::process::ProcessTree::spawn(&mut command) {
            Ok(value) => value,
            Err(e) => {
                outcome = RunOutcome::Failed(Some(format!("failed to run {command_name}: {e}")));
                break;
            }
        };
        let mut cancelled = false;
        #[cfg(not(windows))]
        {
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
            if let Some(stdout) = child.stdout().take() {
                tokio::spawn(forward_lines(stdout, tx.clone()));
            }
            if let Some(stderr) = child.stderr().take() {
                tokio::spawn(forward_lines(stderr, tx.clone()));
            }
            drop(tx);
            loop {
                tokio::select! {
                    biased;
                    _ = started.cancel_token.cancelled() => {
                        cancelled = true;
                        break;
                    }
                    line = rx.recv() => {
                        let Some(line) = line else { break };
                        note_compile_line(
                            &line,
                            &mut logfile,
                            &mut output,
                            &mut tail,
                            app,
                            &started.snapshot.id,
                            &params.tex_path,
                            &mut progress,
                            index,
                            total,
                            center,
                        )
                        .await;
                    }
                }
            }
        }
        #[cfg(windows)]
        {
            let mut stdout_cursor = LogCursor::new();
            let mut stderr_cursor = LogCursor::new();
            loop {
                tokio::select! {
                    biased;
                    _ = started.cancel_token.cancelled() => {
                        cancelled = true;
                        break;
                    }
                    _ = tokio::time::sleep(std::time::Duration::from_millis(50)) => {
                        let mut batch = Vec::new();
                        batch.extend(stdout_cursor.pull(&captured.stdout_path, false));
                        batch.extend(stderr_cursor.pull(&captured.stderr_path, false));
                        let finished = matches!(child.try_wait(), Ok(Some(_)));
                        if finished {
                            batch.extend(stdout_cursor.pull(&captured.stdout_path, true));
                            batch.extend(stderr_cursor.pull(&captured.stderr_path, true));
                        }
                        for line in batch {
                            note_compile_line(
                                &line,
                                &mut logfile,
                                &mut output,
                                &mut tail,
                                app,
                                &started.snapshot.id,
                                &params.tex_path,
                                &mut progress,
                                index,
                                total,
                                center,
                            )
                            .await;
                        }
                        if finished {
                            break;
                        }
                    }
                }
            }
        }
        if cancelled {
            terminate(&mut child).await;
            outcome = RunOutcome::Cancelled;
            break;
        }
        match wait_or_cancel(&mut child, &started.cancel_token).await {
            Ok(None) => {
                outcome = RunOutcome::Cancelled;
                break;
            }
            Ok(Some(status)) if status.success() => {}
            Ok(Some(status)) => {
                let detail = tail.iter().cloned().collect::<Vec<_>>().join("\n");
                outcome = RunOutcome::Failed(Some(if detail.is_empty() {
                    format!("{command_name} exited with {status}")
                } else {
                    detail
                        .chars()
                        .rev()
                        .take(2000)
                        .collect::<String>()
                        .chars()
                        .rev()
                        .collect()
                }));
                break;
            }
            Err(e) => {
                outcome = RunOutcome::Failed(Some(e.to_string()));
                break;
            }
        }
    }
    let success =
        matches!(outcome, RunOutcome::Succeeded) && Path::new(&artifact.pdf_path).is_file();
    if matches!(outcome, RunOutcome::Succeeded) && !success {
        outcome = RunOutcome::Failed(Some(format!("build did not produce {}", artifact.pdf_path)));
    }
    if let RunOutcome::Failed(Some(message)) = &outcome {
        let _ = writeln!(logfile, "{message}");
    }
    let _ = logfile.flush();
    // The engine log records useful diagnostics that do not always reach
    // latexmk's console stream (especially nonfatal reference warnings).
    let tex_log = Path::new(&artifact.fls_path).with_extension("log");
    if let Ok(text) = std::fs::read_to_string(tex_log) {
        output.push_str(&text);
    }
    let result = LatexCompileResult {
        job_id: started.snapshot.id.clone(),
        root_path: params.tex_path,
        success,
        pdf_path: artifact.pdf_path,
        log_path: artifact.log_path,
        synctex_path: artifact.synctex_path,
        dependencies: read_fls(Path::new(&artifact.fls_path), cwd),
        diagnostics: parse_diagnostics(&output, &root),
    };
    let _ = app.emit("compile:finished", result);
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recipe_expansion_keeps_spaces_as_a_single_argument() {
        let root = Path::new("/project with spaces/main.tex");
        let artifact = artifacts(root, &Default::default()).unwrap();
        assert_eq!(
            expand("%DOC%", root, &artifact),
            "/project with spaces/main.tex"
        );
        assert_eq!(
            expand("%OUTDIR%/%JOBNAME%.pdf", root, &artifact),
            "/project with spaces/main.pdf"
        );
    }

    #[test]
    fn custom_latexmk_honors_force_and_inferred_cleanup_jobname() {
        let root = Path::new("/project/main.tex");
        let tool = LatexTool {
            command: "latexmk".into(),
            args: vec!["-pdf".into(), "-jobname=draft".into(), "%DOC%".into()],
            cwd: None,
            env: None,
        };
        let options = LatexBuildOptions {
            force: true,
            recipe: Some(super::super::types::LatexRecipe {
                name: "draft".into(),
                tools: vec![tool.clone()],
            }),
            ..Default::default()
        };
        let artifact = artifacts(root, &options).unwrap();
        assert!(tool_arguments(&tool, root, &artifact, &options).contains(&"-g".into()));
        assert!(clean_tool(root, &artifact)
            .args
            .contains(&"-jobname=draft".into()));
        let normal = LatexBuildOptions {
            force: false,
            ..options
        };
        assert!(!tool_arguments(&tool, root, &artifact, &normal).contains(&"-g".into()));
    }

    #[test]
    fn relative_executable_and_output_flags_share_tool_cwd() {
        let root = Path::new("/project/main.tex");
        let tool = LatexTool {
            command: "./scripts/build.sh".into(),
            args: vec!["-output-directory".into(), "out".into(), "%DOC%".into()],
            cwd: Some("build".into()),
            env: None,
        };
        let options = LatexBuildOptions {
            recipe: Some(super::super::types::LatexRecipe {
                name: "custom".into(),
                tools: vec![tool.clone()],
            }),
            ..Default::default()
        };
        let artifact = artifacts(root, &options).unwrap();
        assert_eq!(artifact.pdf_path, "/project/build/out/main.pdf");
        let cwd = tool_directory(&tool, root, &artifact);
        assert_eq!(
            executable_path(&tool.command, &cwd, &BTreeMap::new()),
            Some(PathBuf::from("/project/build/scripts/build.sh"))
        );
        assert_eq!(tool_arguments(&tool, root, &artifact, &options)[1], "out");
    }

    #[test]
    fn tex_log_lines_are_unwrapped_unless_a_width_is_already_set() {
        let mut environment = BTreeMap::from([("TEXINPUTS".into(), "styles:".into())]);
        widen_log_lines(&mut environment, false);
        assert_eq!(
            environment_value(&environment, "max_print_line"),
            Some("10000")
        );
        assert_eq!(
            environment_value(&environment, "TEXINPUTS"),
            Some("styles:")
        );

        let configured = BTreeMap::from([("max_print_line".into(), "200".into())]);
        let mut recipe = configured.clone();
        widen_log_lines(&mut recipe, false);
        assert_eq!(recipe, configured);
        #[cfg(windows)]
        {
            // Environment names are case-insensitive on Windows.
            let configured = BTreeMap::from([("MAX_PRINT_LINE".into(), "200".into())]);
            let mut recipe = configured.clone();
            widen_log_lines(&mut recipe, false);
            assert_eq!(recipe, configured);
        }

        let mut inherited = BTreeMap::new();
        widen_log_lines(&mut inherited, true);
        assert!(inherited.is_empty());

        // The built-in latexmk tool has no recipe environment of its own.
        if std::env::var_os("max_print_line").is_none() {
            let root = Path::new("/project/main.tex");
            let artifact = artifacts(root, &Default::default()).unwrap();
            let tool = LatexTool {
                command: "latexmk".into(),
                args: Vec::new(),
                cwd: None,
                env: None,
            };
            assert_eq!(
                tool_environment(&tool, root, &artifact),
                BTreeMap::from([("max_print_line".into(), "10000".into())])
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn resolves_and_runs_command_using_expanded_recipe_path() {
        use std::os::unix::fs::PermissionsExt;
        let project = tempfile::tempdir().unwrap();
        let bin = project.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        let executable = bin.join("project-latex");
        std::fs::write(&executable, "#!/bin/sh\nprintf 'recipe compiler'\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let root = project.path().join("main.tex");
        let artifact = artifacts(&root, &Default::default()).unwrap();
        let tool = LatexTool {
            command: "project-latex".into(),
            args: Vec::new(),
            cwd: None,
            env: Some(BTreeMap::from([("PATH".into(), "%DIR%/bin".into())])),
        };
        let environment = tool_environment(&tool, &root, &artifact);
        let found = executable_path(&tool.command, project.path(), &environment).unwrap();
        assert_eq!(found, executable);
        let output = std::process::Command::new(found)
            .current_dir(project.path())
            .envs(&environment)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"recipe compiler");
        // Relative PATH entries resolve against the tool cwd too.
        let relative = BTreeMap::from([("PATH".into(), "bin".into())]);
        assert_eq!(
            executable_path(&tool.command, project.path(), &relative),
            Some(executable)
        );
        let absent = BTreeMap::from([(
            "PATH".into(),
            project.path().join("absent").to_string_lossy().into_owned(),
        )]);
        assert!(executable_path("sh", project.path(), &absent).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn windows_recipe_path_and_pathext_names_are_case_insensitive() {
        let project = tempfile::tempdir().unwrap();
        let bin = project.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        let executable = bin.join("project-latex.TOOL");
        std::fs::write(&executable, "test executable lookup").unwrap();
        let environment = BTreeMap::from([
            ("Path".into(), bin.to_string_lossy().into_owned()),
            ("PathExt".into(), ".TOOL".into()),
        ]);
        assert_eq!(
            executable_path("project-latex", project.path(), &environment),
            Some(executable.clone())
        );
        assert_eq!(
            executable_path("bin/project-latex", project.path(), &environment),
            Some(executable.clone())
        );
        assert_eq!(
            executable_path(&executable.to_string_lossy(), project.path(), &environment),
            Some(executable)
        );
    }

    #[test]
    fn project_output_settings_are_injected_into_example_and_minimal_recipes() {
        let root = Path::new("/project/main.tex");
        for input_args in [
            vec!["-pdf", "-outdir=%OUTDIR%", "%DOC%"],
            vec!["-pdf", "%DOC%"],
        ] {
            let tool = LatexTool {
                command: "latexmk".into(),
                args: input_args.into_iter().map(String::from).collect(),
                env: None,
                cwd: None,
            };
            let options = LatexBuildOptions {
                out_dir: Some("build".into()),
                aux_dir: Some("cache".into()),
                jobname: Some("draft".into()),
                recipe: Some(super::super::types::LatexRecipe {
                    name: "example".into(),
                    tools: vec![tool.clone()],
                }),
                ..Default::default()
            };
            let artifact = artifacts(root, &options).unwrap();
            let args = tool_arguments(&tool, root, &artifact, &options);
            assert!(args.contains(&"-outdir=/project/build".into()));
            assert!(args.contains(&"-auxdir=/project/cache".into()));
            assert!(args.contains(&"-jobname=draft".into()));
            assert_eq!(args.last().unwrap(), "/project/main.tex");
            assert_eq!(artifact.pdf_path, "/project/build/draft.pdf");
        }
    }

    #[test]
    fn helpers_keep_their_output_options_and_direct_engines_reject_separate_aux() {
        let root = Path::new("/project/main.tex");
        let helper = LatexTool {
            command: "image-converter".into(),
            args: vec!["-outdir=images".into()],
            env: None,
            cwd: None,
        };
        let options = LatexBuildOptions {
            out_dir: Some("build".into()),
            ..Default::default()
        };
        let artifact = artifacts(root, &options).unwrap();
        assert_eq!(
            tool_arguments(&helper, root, &artifact, &options),
            vec!["-outdir=images"]
        );
        let tool = LatexTool {
            command: "pdflatex".into(),
            args: vec!["%DOC%".into()],
            env: None,
            cwd: None,
        };
        let options = LatexBuildOptions {
            aux_dir: Some("cache".into()),
            recipe: Some(super::super::types::LatexRecipe {
                name: "direct".into(),
                tools: vec![tool],
            }),
            ..options
        };
        assert!(artifacts(root, &options).is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_still_works_after_child_closes_output_pipes() {
        use tokio::io::AsyncReadExt;
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .args(["-c", "exec 1>&- 2>&-; sleep 30"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .kill_on_drop(true);
        let mut child = crate::core::process::ProcessTree::spawn(&mut command).unwrap();
        let mut stdout = child.stdout().take().unwrap();
        let mut stderr = child.stderr().take().unwrap();
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).await.unwrap();
        stderr.read_to_end(&mut bytes).await.unwrap();
        let token = tokio_util::sync::CancellationToken::new();
        token.cancel();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            wait_or_cancel(&mut child, &token),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(result.is_none());
    }
}

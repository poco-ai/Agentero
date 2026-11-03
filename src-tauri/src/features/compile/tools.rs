use super::resolve_engine;
use crate::core::error::{ApiResult, AppError};
use serde::Serialize;
use std::{path::Path, process::Stdio, time::Duration};
use tokio::process::Command;

pub(super) fn prepare_command(command: &mut Command, executable: &Path) {
    if let Some(dir) = executable.parent() {
        let mut paths = vec![dir.to_path_buf()];
        paths.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        if let Ok(value) = std::env::join_paths(paths) {
            command.env("PATH", value);
        }
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    command.kill_on_drop(true);
}

async fn tool_output(name: &str, args: &[String], cwd: &Path) -> Result<String, String> {
    let executable =
        resolve_engine(name).ok_or_else(|| format!("{name} not found on this system"))?;
    let mut command = Command::new(&executable);
    prepare_command(&mut command, &executable);
    command
        .args(args)
        .current_dir(super::types::tool_path(cwd))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // SyncTeX honors these variables by launching another app; this API only
    // queries coordinates and must never execute the user's viewer command.
    command
        .env_remove("SYNCTEX_VIEWER")
        .env_remove("SYNCTEX_EDITOR");
    let output = tokio::time::timeout(
        Duration::from_secs(30),
        crate::core::process::command_output(&mut command),
    )
    .await
    .map_err(|_| format!("{name} timed out"))?
    .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "{name}: {}",
            String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(2000)
                .collect::<String>()
        ));
    }
    Ok(decode_tool_stdout(&output.stdout))
}

/// synctex on Windows writes UTF-16 or the ANSI code page when a path is not
/// ASCII. The records we parse (`Page`, `Input`) are ASCII either way.
fn decode_tool_stdout(bytes: &[u8]) -> String {
    if let Some(text) = decode_utf16_stdout(bytes) {
        return text;
    }
    match String::from_utf8(bytes.to_vec()) {
        Ok(text) => text,
        Err(error) => {
            let (gbk, _, gbk_errors) = encoding_rs::GBK.decode(error.as_bytes());
            if !gbk_errors {
                return gbk.into_owned();
            }
            String::from_utf8_lossy(error.as_bytes()).into_owned()
        }
    }
}

fn decode_utf16_stdout(bytes: &[u8]) -> Option<String> {
    let bom = bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]);
    let (rest, little) = if bytes.starts_with(&[0xFF, 0xFE]) {
        (&bytes[2..], true)
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        (&bytes[2..], false)
    } else {
        (bytes, true)
    };
    if rest.len() < 8 || rest.len() % 2 != 0 {
        return None;
    }
    let high_index = if little { 1 } else { 0 };
    let zeros = rest
        .iter()
        .skip(high_index)
        .step_by(2)
        .filter(|byte| **byte == 0)
        .count();
    // A BOM is enough. Without one, require some ASCII (the Page/Input keys)
    // so a GBK path is not mistaken for UTF-16.
    if !bom && zeros < rest.len() / 8 {
        return None;
    }
    let units: Vec<u16> = rest
        .as_chunks::<2>()
        .0
        .iter()
        .map(|chunk| {
            if little {
                u16::from_le_bytes([chunk[0], chunk[1]])
            } else {
                u16::from_be_bytes([chunk[0], chunk[1]])
            }
        })
        .collect();
    let text = String::from_utf16(&units).ok()?;
    if text.contains("Page:") || text.contains("Input:") || text.contains("SyncTeX") {
        Some(text)
    } else {
        None
    }
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncTexLocation {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncTexSource {
    pub path: String,
    pub line: u32,
    pub column: u32,
}

fn parse_forward(text: &str) -> Vec<SyncTexLocation> {
    let mut locations = Vec::new();
    let mut current: Option<(SyncTexLocation, Option<f64>, Option<f64>)> = None;
    for line in text.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key == "Page" {
            if let Some((mut location, h, v)) = current.take() {
                finish_forward(&mut location, h, v);
                locations.push(location);
            }
            current = value.trim().parse().ok().map(|page| {
                (
                    SyncTexLocation {
                        page,
                        x: 0.0,
                        y: 0.0,
                        width: 0.0,
                        height: 0.0,
                    },
                    None,
                    None,
                )
            });
        } else if let Some((location, h, v)) = current.as_mut() {
            let Ok(value) = value.trim().parse::<f64>() else {
                continue;
            };
            if !value.is_finite() {
                continue;
            }
            match key {
                "x" => location.x = value,
                "y" => location.y = value,
                "h" => *h = Some(value),
                "v" => *v = Some(value),
                "W" => location.width = value.abs(),
                "H" => location.height = value.abs(),
                _ => {}
            }
        }
    }
    if let Some((mut location, h, v)) = current {
        finish_forward(&mut location, h, v);
        locations.push(location);
    }
    locations.into_iter().filter(|v| v.page > 0).collect()
}

/// `view` reports the word's point in x/y but the line box in h/v/W/H:
/// h is the left edge and v the bottom, so the drawn rect starts at v - H.
fn finish_forward(location: &mut SyncTexLocation, h: Option<f64>, v: Option<f64>) {
    if let Some(h) = h {
        location.x = h;
    }
    if let Some(v) = v {
        location.y = v - location.height;
    }
}

#[tauri::command]
#[specta::specta]
pub async fn latex_synctex_forward(
    pdf_path: String,
    tex_path: String,
    line: u32,
    column: u32,
) -> ApiResult<Vec<SyncTexLocation>> {
    if line == 0 || !Path::new(&pdf_path).is_file() {
        return ApiResult::err(AppError::message(
            "PDF is missing or source line is invalid",
        ));
    }
    let tool_tex = super::types::tool_path(Path::new(&tex_path));
    let args = vec![
        "view".into(),
        "-i".into(),
        format!("{line}:{column}:{}", tool_tex.display()),
        "-o".into(),
        super::types::tool_path(Path::new(&pdf_path))
            .to_string_lossy()
            .into_owned(),
    ];
    match tool_output(
        "synctex",
        &args,
        Path::new(&tex_path).parent().unwrap_or(Path::new(".")),
    )
    .await
    {
        Ok(text) => ApiResult::ok(parse_forward(&text)),
        Err(e) => ApiResult::err(AppError::message(e)),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn latex_synctex_backward(
    pdf_path: String,
    page: u32,
    x: f64,
    y: f64,
) -> ApiResult<Option<SyncTexSource>> {
    if page == 0 || !x.is_finite() || !y.is_finite() || !Path::new(&pdf_path).is_file() {
        return ApiResult::err(AppError::message(
            "PDF is missing or coordinates are invalid",
        ));
    }
    let cwd = Path::new(&pdf_path).parent().unwrap_or(Path::new("."));
    let tool_pdf = super::types::tool_path(Path::new(&pdf_path));
    let args = vec![
        "edit".into(),
        "-o".into(),
        format!("{page}:{x}:{y}:{}", tool_pdf.display()),
    ];
    match tool_output("synctex", &args, cwd).await {
        Ok(text) => {
            let value = |key: &str| {
                text.lines()
                    .find_map(|line| line.strip_prefix(key))
                    .map(str::trim)
            };
            let found = value("Input:")
                .zip(value("Line:").and_then(|v| v.parse::<u32>().ok()))
                .map(|(path, line)| {
                    let path = Path::new(path);
                    let path = if path.is_absolute() {
                        path.to_path_buf()
                    } else {
                        cwd.join(path)
                    };
                    SyncTexSource {
                        path: super::types::caller_path(
                            &super::root::normalize_lexical(&path).to_string_lossy(),
                            Path::new(&pdf_path),
                        ),
                        line: line.max(1),
                        column: value("Column:")
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(1)
                            .max(1),
                    }
                });
            ApiResult::ok(found)
        }
        Err(e) => ApiResult::err(AppError::message(e)),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn latex_clean(
    root_path: String,
    build: Option<super::types::LatexBuildOptions>,
) -> ApiResult<()> {
    let root = Path::new(&root_path);
    if !root.is_file() {
        return ApiResult::err(AppError::message("LaTeX root file does not exist"));
    }
    let artifact = match super::types::artifacts(root, &build.unwrap_or_default()) {
        Ok(v) => v,
        Err(e) => return ApiResult::err(AppError::message(e)),
    };
    let name = Path::new(&artifact.pdf_path)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();
    let tool_artifact = super::types::tool_artifacts(&artifact);
    let args = vec![
        "-c".into(),
        format!("-outdir={}", tool_artifact.out_dir),
        format!("-auxdir={}", tool_artifact.aux_dir),
        format!("-jobname={name}"),
        super::types::tool_path(root).to_string_lossy().into_owned(),
    ];
    match tool_output("latexmk", &args, root.parent().unwrap_or(Path::new("."))).await {
        Ok(_) => ApiResult::ok(()),
        Err(e) => ApiResult::err(AppError::message(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn forward_sync_preserves_top_left_points_and_multiple_records() {
        let values = parse_forward("SyncTeX result begin\nPage:1\nx:72.5\ny:100.0\nW:200\nH:12\nPage:2\nx:80\ny:110\nW:190\nH:10\nSyncTeX result end");
        assert_eq!(values.len(), 2);
        assert_eq!(values[0].x, 72.5);
        assert_eq!(values[1].page, 2);
    }

    #[test]
    fn forward_sync_draws_the_line_box_not_the_baseline_point() {
        let values = parse_forward(
            "SyncTeX result begin\nPage:1\nx:95.6\ny:107.3\nh:72.0\nv:109.4\nW:468.0\nH:9.7\nSyncTeX result end",
        );
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].x, 72.0);
        assert!((values[0].y - 99.7).abs() < 1e-6);
        assert_eq!(values[0].width, 468.0);
        assert_eq!(values[0].height, 9.7);
    }

    #[test]
    fn synctex_stdout_accepts_utf16_and_gbk_paths() {
        let utf16: Vec<u8> = "Page:3\nx:1\ny:2\nW:3\nH:4\n"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        let text = decode_tool_stdout(&utf16);
        assert_eq!(parse_forward(&text)[0].page, 3);

        let (gbk, _, _) =
            encoding_rs::GBK.encode("Output:论文.pdf\nPage:1\nx:10\ny:20\nW:5\nH:6\n");
        let text = decode_tool_stdout(gbk.as_ref());
        assert!(text.contains("论文"));
        assert_eq!(parse_forward(&text)[0].x, 10.0);
    }
}

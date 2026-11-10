//! Compiler diagnostics and recorder dependencies; no UI state lives here.
use super::types::LatexDiagnostic;
use std::path::{Path, PathBuf};

fn diagnostic_line(text: &str) -> Option<u32> {
    ["input line ", "at lines ", "at line "]
        .iter()
        .find_map(|marker| {
            text.rsplit_once(marker).and_then(|(_, suffix)| {
                suffix
                    .chars()
                    .take_while(char::is_ascii_digit)
                    .collect::<String>()
                    .parse()
                    .ok()
            })
        })
}

/// Engine logs delimit input files with parentheses. Track ordinary pairs as
/// empty frames too, so `(Font)` and metric messages cannot close a source.
#[derive(Default)]
struct SourceStack {
    frames: Vec<Option<PathBuf>>,
}
impl SourceStack {
    fn source(&self, root: &Path) -> PathBuf {
        self.frames
            .iter()
            .rev()
            .flatten()
            .find(|path| {
                matches!(
                    path.extension().and_then(|e| e.to_str()),
                    Some("tex" | "sty" | "cls" | "ltx" | "def" | "bbl")
                )
            })
            .cloned()
            .unwrap_or_else(|| root.to_path_buf())
    }
    fn update(&mut self, text: &str, cwd: &Path) {
        let mut index = 0;
        let bytes = text.as_bytes();
        while index < bytes.len() {
            match bytes[index] {
                b'(' => {
                    let suffix = &text[index + 1..];
                    let path = if let Some(quoted) = suffix.strip_prefix('"') {
                        quoted.find('"').map(|end| quoted[..end].to_string())
                    } else {
                        [
                            ".tex", ".sty", ".cls", ".bib", ".bbl", ".aux", ".cfg", ".def", ".fd",
                            ".bbx", ".cbx", ".clo", ".ltx",
                        ]
                        .iter()
                        .filter_map(|ext| {
                            let end = suffix.find(ext)? + ext.len();
                            if suffix
                                .as_bytes()
                                .get(end)
                                .is_some_and(|c| !c.is_ascii_whitespace() && *c != b')')
                            {
                                return None;
                            }
                            let value = &suffix[..end];
                            (!value.chars().any(char::is_whitespace))
                                .then_some((end, value.to_string()))
                        })
                        .min_by_key(|(end, _)| *end)
                        .map(|(_, value)| value)
                    };
                    let path = path.map(|value| {
                        let path = PathBuf::from(&value);
                        super::root::normalize_lexical(&if path.is_absolute()
                            || value.as_bytes().get(1) == Some(&b':')
                        {
                            path
                        } else {
                            cwd.join(path)
                        })
                    });
                    self.frames.push(path);
                }
                b')' => {
                    self.frames.pop();
                }
                _ => {}
            }
            index += 1;
        }
    }
}

pub fn parse_diagnostics(output: &str, root: &Path, cwd: &Path) -> Vec<LatexDiagnostic> {
    let mut diagnostics: Vec<LatexDiagnostic> = Vec::new();
    let mut pending_error: Option<(String, PathBuf)> = None;
    let mut pending_warning: Option<usize> = None;
    let mut stack = SourceStack::default();
    for text in output.lines() {
        let text = text.trim();
        if text.starts_with("This is ") {
            stack.frames.clear();
            pending_warning = None;
        }
        let mut file_line = None;
        for (index, _) in text.match_indices(':') {
            let rest = &text[index + 1..];
            let Some(end) = rest.find(':') else { continue };
            if let Ok(line) = rest[..end].parse::<u32>() {
                let path = text[..index].trim().trim_matches('"');
                let extension = Path::new(path)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("");
                if line > 0
                    && [
                        "tex", "sty", "cls", "bib", "bbl", "ltx", "cfg", "def", "fd", "bbx", "cbx",
                    ]
                    .contains(&extension)
                {
                    file_line = Some((path, line, rest[end + 1..].trim()));
                    break;
                }
            }
        }
        if let Some((path, line, message)) = file_line {
            let file = PathBuf::from(path);
            let file = super::root::normalize_lexical(&if file.is_absolute()
                || path.as_bytes().get(1) == Some(&b':')
            {
                file
            } else {
                cwd.join(file)
            });
            diagnostics.push(LatexDiagnostic {
                path: file.to_string_lossy().into_owned(),
                line,
                column: 1,
                severity: if message.to_lowercase().contains("warning") {
                    "warning"
                } else {
                    "error"
                }
                .into(),
                message: message.into(),
                source: "latex".into(),
            });
            pending_error = None;
            pending_warning = None;
            continue;
        }
        if let Some(message) = text.strip_prefix("! ") {
            pending_error = Some((message.into(), stack.source(root)));
            continue;
        }
        if let Some(rest) = text.strip_prefix("l.") {
            if let Some((message, path)) = pending_error.take() {
                let line = rest
                    .split_whitespace()
                    .next()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(1);
                diagnostics.push(LatexDiagnostic {
                    path: path.to_string_lossy().into_owned(),
                    line,
                    column: 1,
                    severity: "error".into(),
                    message,
                    source: "latex".into(),
                });
            }
            continue;
        }
        if text.starts_with("Missing character:") {
            diagnostics.push(LatexDiagnostic {
                path: stack.source(root).to_string_lossy().into_owned(),
                line: diagnostic_line(text).unwrap_or(1),
                column: 1,
                severity: "warning".into(),
                message: text.into(),
                source: "latex".into(),
            });
            continue;
        }
        if text.starts_with("Package graphics Error")
            || text.starts_with("Package graphicx Error")
            || text.contains("Unable to load picture")
            || text.contains("unknown graphics extension")
        {
            diagnostics.push(LatexDiagnostic {
                path: stack.source(root).to_string_lossy().into_owned(),
                line: diagnostic_line(text).unwrap_or(1),
                column: 1,
                severity: "error".into(),
                message: text.trim_start_matches("! ").into(),
                source: "latex".into(),
            });
            pending_error = None;
            continue;
        }
        let lower = text.to_lowercase();
        let is_warning = lower.contains("warning:")
            || text.starts_with("Warning--")
            || text.starts_with("Overfull ")
            || text.starts_with("Underfull ")
            || text.starts_with("ERROR - ")
            || text.starts_with("WARN - ");
        if is_warning {
            let line = diagnostic_line(text);
            pending_warning = line.is_none().then_some(diagnostics.len());
            diagnostics.push(LatexDiagnostic {
                path: stack.source(root).to_string_lossy().into_owned(),
                line: line.unwrap_or(1),
                column: 1,
                severity: if text.starts_with("ERROR - ") {
                    "error"
                } else {
                    "warning"
                }
                .into(),
                message: text.into(),
                source: if text.starts_with("Warning--") {
                    "bibtex"
                } else if text.starts_with("ERROR - ") || text.starts_with("WARN - ") {
                    "biber"
                } else {
                    "latex"
                }
                .into(),
            });
            continue;
        }
        if let (Some(index), Some(line)) = (pending_warning, diagnostic_line(text)) {
            diagnostics[index].line = line;
            diagnostics[index].message.push(' ');
            diagnostics[index].message.push_str(text);
            pending_warning = None;
            continue;
        }
        stack.update(text, cwd);
    }
    if let Some((message, path)) = pending_error {
        diagnostics.push(LatexDiagnostic {
            path: path.to_string_lossy().into_owned(),
            line: 1,
            column: 1,
            severity: "error".into(),
            message,
            source: "latex".into(),
        });
    }
    let mut unique = Vec::new();
    for diagnostic in diagnostics {
        if !unique.contains(&diagnostic) {
            unique.push(diagnostic);
        }
    }
    unique
}

pub fn read_fls(path: &Path, cwd: &Path) -> Vec<String> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut base = cwd.to_path_buf();
    let mut dependencies = std::collections::BTreeSet::new();
    let outputs: std::collections::BTreeSet<PathBuf> = content
        .lines()
        .filter_map(|line| line.strip_prefix("OUTPUT "))
        .map(|value| {
            let path = PathBuf::from(value.trim_matches('"'));
            if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            }
        })
        .collect();
    for line in content.lines() {
        if let Some(dir) = line.strip_prefix("PWD ") {
            base = PathBuf::from(dir);
        }
        if let Some(value) = line.strip_prefix("INPUT ") {
            let path = PathBuf::from(value.trim_matches('"'));
            let path = if path.is_absolute() {
                path
            } else {
                base.join(path)
            };
            if !outputs.contains(&path) && path.is_file() {
                dependencies.insert(path.to_string_lossy().into_owned());
            }
        }
    }
    dependencies.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn portable(value: &str) -> String {
        value.replace('\\', "/")
    }

    #[test]
    fn parses_windows_and_unix_file_line_errors_and_warnings() {
        let found = parse_diagnostics("C:\\work\\chapter.tex:42: Undefined control sequence.\n./intro.tex:8: LaTeX Warning: Reference missing.\n! Missing $ inserted.\nl.9 text\nOverfull \\hbox (3pt too wide) at lines 10--11", Path::new("/work/main.tex"), Path::new("/work"));
        assert_eq!(found.len(), 4);
        assert_eq!(found[0].path, "C:\\work\\chapter.tex");
        assert_eq!(found[0].line, 42);
        assert_eq!(found[1].severity, "warning");
        assert_eq!(found[2].line, 9);
        assert_eq!(found[3].line, 10);
    }
    #[test]
    fn attributes_chapter_warnings_badboxes_and_wrapped_citations_to_source() {
        let output="This is pdfTeX\n(./main.tex\n(/tex/article.cls\nDocument Class: article (standard class)\n)\n(./chapters/intro.tex\nLaTeX Warning: Reference `missing' undefined on input line 7.\nOverfull \\hbox (4pt too wide) at lines 8--9\nPackage natbib Warning: Citation `unknown' undefined\n(natbib) on input line 11.\n)\nLaTeX Warning: Reference `root' undefined on input line 20.\n)";
        let found = parse_diagnostics(
            output,
            Path::new("/project/main.tex"),
            Path::new("/project"),
        );
        assert_eq!(found.len(), 4);
        for item in &found[..3] {
            assert_eq!(portable(&item.path), "/project/chapters/intro.tex");
        }
        assert_eq!(found[0].line, 7);
        assert_eq!(found[1].line, 8);
        assert_eq!(found[2].line, 11);
        assert_eq!(portable(&found[3].path), "/project/main.tex");
        assert_eq!(found[3].line, 20);
    }
    #[test]
    fn keeps_missing_glyphs_picture_failures_and_biber_version_errors() {
        let output = "\
(./main.tex
Missing character: There is no 中 (U+4E2D) in font cmr10!
! Unable to load picture or PDF file 'plot.png'.
l.4 \\includegraphics{plot.png}
ERROR - Error: Found biblatex control file version 3.2, expected version 3.11.
)";
        let found = parse_diagnostics(
            output,
            Path::new("/project/main.tex"),
            Path::new("/project"),
        );
        assert!(found.iter().any(|item| {
            item.severity == "warning" && item.message.starts_with("Missing character:")
        }));
        assert!(found.iter().any(|item| {
            item.severity == "error"
                && item.message.contains("Unable to load picture")
                && item.line == 4
        }));
        assert!(found.iter().any(|item| {
            item.severity == "error"
                && item.source == "biber"
                && item.message.contains("control file")
        }));
    }
    #[test]
    fn recorder_preserves_space_paths_and_excludes_outputs() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("with space.tex");
        let output = dir.path().join("main.aux");
        std::fs::write(&input, "source").unwrap();
        std::fs::write(&output, "aux").unwrap();
        let fls = dir.path().join("main.fls");
        std::fs::write(
            &fls,
            format!(
                "PWD {}\nINPUT with space.tex\nINPUT main.aux\nOUTPUT main.aux\n",
                dir.path().display()
            ),
        )
        .unwrap();
        assert_eq!(
            read_fls(&fls, dir.path()),
            vec![input.to_string_lossy().into_owned()]
        );
    }
}

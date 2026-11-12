//! Generates embedded vault template tables consumed by `features::vault`.
//! Moved alongside the vault service from the Host crate (phase-2 crate split);
//! the Host build no longer needs it.

use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    generate_onboarding_templates();
    generate_skill_templates();
}

fn generate_onboarding_templates() {
    let manifest_dir = PathBuf::from(
        env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by Cargo"),
    );
    let notes_root = manifest_dir.join("../../templates/vault/notes");
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set by Cargo"));
    let generated = out_dir.join("onboarding_templates.rs");

    println!("cargo:rerun-if-changed={}", notes_root.display());

    let mut entries = Vec::new();
    let locales = fs::read_dir(&notes_root)
        .unwrap_or_else(|e| panic!("read onboarding notes directory: {e}"))
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .collect::<Vec<_>>();

    for locale_dir in locales {
        let locale = locale_dir.file_name().to_string_lossy().into_owned();
        let mut files = fs::read_dir(locale_dir.path())
            .unwrap_or_else(|e| panic!("read onboarding locale {locale}: {e}"))
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.path().is_file() && entry.path().extension().is_some_and(|ext| ext == "md")
            })
            .collect::<Vec<_>>();
        files.sort_by_key(|entry| entry.file_name());

        for file in files {
            let filename = file.file_name().to_string_lossy().into_owned();
            // Keep the selected locale in the embedded entry, but flatten the
            // generated Vault paths so onboarding notes live directly in notes/.
            let rel = format!("notes/{filename}");
            let path = file.path();
            entries.push((locale.clone(), rel, path));
        }
    }

    entries.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));

    let mut source =
        String::from("pub(crate) static BUNDLED_ONBOARDING_FILES: &[(&str, &str, &str)] = &[\n");
    for (locale, rel, path) in entries {
        source.push_str(&format!(
            "    ({:?}, {:?}, include_str!({:?})),\n",
            locale,
            rel,
            path.to_string_lossy().to_string()
        ));
    }
    source.push_str("];\n");

    fs::write(generated, source).expect("write generated onboarding templates");
}

fn generate_skill_templates() {
    let manifest_dir = PathBuf::from(
        env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by Cargo"),
    );
    let skills_root = manifest_dir.join("../../templates/vault/.agents/skills");
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set by Cargo"));
    let generated = out_dir.join("skill_templates.rs");

    println!("cargo:rerun-if-changed={}", skills_root.display());

    let mut entries = Vec::new();
    collect_skill_files(&skills_root, &skills_root, &mut entries);
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    let mut source = String::from("pub(crate) static BUNDLED_SKILL_FILES: &[(&str, &str)] = &[\n");
    for (rel, path, cfg) in entries {
        if let Some(cfg_attr) = cfg {
            source.push_str(&format!("    #[cfg({cfg_attr})]\n"));
        }
        source.push_str(&format!(
            "    ({:?}, include_str!({:?})),\n",
            rel,
            path.to_string_lossy().to_string()
        ));
    }
    source.push_str("];\n");

    fs::write(generated, source).expect("write generated skill templates");
}

fn collect_skill_files(
    skills_root: &std::path::Path,
    current: &std::path::Path,
    entries: &mut Vec<(String, PathBuf, Option<&'static str>)>,
) {
    let mut children = fs::read_dir(current)
        .unwrap_or_else(|e| panic!("read skill template directory {}: {e}", current.display()))
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    children.sort_by_key(|entry| entry.file_name());

    for entry in children {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if should_skip_skill_template_entry(&name) {
            continue;
        }

        let path = entry.path();
        if path.is_dir() {
            collect_skill_files(skills_root, &path, entries);
            continue;
        }
        if !path.is_file() {
            continue;
        }

        let rel_to_skills = path
            .strip_prefix(skills_root)
            .expect("skill file under skills root")
            .components()
            .map(|component| component.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");

        let mut parts = rel_to_skills.split('/');
        if parts.next().is_none() {
            continue;
        }
        if parts.next().is_none() {
            // Top-level README/LICENSE files are handled separately; only
            // package directories under `.agents/skills/<id>/...` are skills.
            continue;
        }

        let (vault_rel, cfg) = match rel_to_skills.as_str() {
            "agentero-cli/SKILL-windows.md" => (
                ".agents/skills/agentero-cli/SKILL.md".to_string(),
                Some("windows"),
            ),
            "agentero-cli/SKILL.md" => (
                ".agents/skills/agentero-cli/SKILL.md".to_string(),
                Some("not(windows)"),
            ),
            _ => (format!(".agents/skills/{rel_to_skills}"), None),
        };

        fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!(
                "bundled skill template must be UTF-8 text ({}): {e}",
                path.display()
            )
        });
        entries.push((vault_rel, path, cfg));
    }
}

fn should_skip_skill_template_entry(name: &str) -> bool {
    name.starts_with('.')
        || matches!(
            name,
            "__pycache__" | "node_modules" | "target" | "dist" | "build"
        )
}

use super::*;
use crate::features::paper::capabilities::probe_paper_caps;

pub fn paper_brief(r: &PaperRecord, internal: bool) -> Result<Value> {
    let tags = r
        .tags
        .iter()
        .filter(|t| internal || !papers::is_internal_tag_name(&t.name))
        .map(|t| &t.name)
        .collect::<Vec<_>>();
    Ok(
        json!({"id":r.id,"path":r.path,"title":r.title,"state":if r.is_read{"read"}else{"unread"},"tags":tags,"revision":content_revision(&serde_json::to_vec(r)?)}),
    )
}
pub fn paper_detail(vault: &Path, r: &PaperRecord, internal: bool) -> Result<Value> {
    let mut v = paper_brief(r, internal)?;
    let mut assets = json!({"folder":r.path});
    if let Ok(dir) = existing(vault, &r.path) {
        let caps = probe_paper_caps(&dir);
        for (key, filename) in [
            ("body", "PAPER.md"),
            ("notes", "NOTES.md"),
            ("marks", "marks"),
        ] {
            let path = format!("{}/{filename}", r.path);
            if existing(vault, &path).is_ok() {
                assets[key] = json!(path);
            }
        }
        if caps.has_tex {
            // TeX may live in the paper root or inside the unpacked source tree.
            if let Some(tex) = crate::features::paper::source::read_tex(&dir) {
                if let Ok(rel) = relative(vault, &tex.root) {
                    if existing(vault, &rel).is_ok() {
                        assets["tex"] = json!(rel);
                    }
                }
            }
        }
        if let Some(pdf) = caps.pdf_path {
            if let Ok(rel) = relative(vault, &pdf) {
                if existing(vault, &rel).is_ok() {
                    assets["pdf"] = json!(rel);
                }
            }
        }
    }
    let extra = json!({"authors":r.authors,"venue":r.publication,"date":r.date,"doi":r.doi,"arxiv":r.arxiv_id,"status":r.status,"abstract":r.abstract_text,"assets":assets});
    v.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    Ok(v)
}

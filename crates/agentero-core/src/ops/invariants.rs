/// Guidance shared by embedded skills and research clients.
pub fn common_invariants_markdown() -> &'static str {
    "Start with paper metadata. Search for an excerpt and expand its cite when the question needs original evidence. Keep the source revision when updating an existing object."
}

pub fn mcp_invariants_markdown() -> &'static str {
    "Read agentero://guide for citation and scope rules. Discover the current tools with tools/list. Use vault_list for authorized vault IDs and evidence_read to follow a cite."
}

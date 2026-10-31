//! Exhaustive stability / permission / `since` for every catalog id.
//!
//! `since` follows stability: `"0"` for internal, `"1"` for experimental or
//! stable. A test fails when an id is missing or listed twice.

use super::{OpPermission, OpSpec, OpStability};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct OpClassification {
    pub id: &'static str,
    pub stability: OpStability,
    pub permission: OpPermission,
    pub since: &'static str,
}

const fn spec(
    id: &'static str,
    stability: OpStability,
    permission: OpPermission,
) -> OpClassification {
    let since = match stability {
        OpStability::Internal => "0",
        OpStability::Experimental | OpStability::Stable => "1",
    };
    OpClassification {
        id,
        stability,
        permission,
        since,
    }
}

pub(super) fn classifications() -> &'static [OpClassification] {
    TABLE
}

pub(super) fn apply(ops: &mut [OpSpec]) {
    for op in ops.iter_mut() {
        let Some(class) = classifications().iter().find(|c| c.id == op.id) else {
            continue;
        };
        op.stability = class.stability;
        op.permission = class.permission;
        op.since = class.since.to_string();
    }
}

const TABLE: &[OpClassification] = &[
    spec("vault.search", OpStability::Stable, OpPermission::VaultRead),
    spec("page.read", OpStability::Stable, OpPermission::VaultRead),
    spec(
        "vault.create",
        OpStability::Internal,
        OpPermission::Unspecified,
    ),
    spec("vault.list", OpStability::Stable, OpPermission::VaultRead),
    spec("paper.list", OpStability::Stable, OpPermission::VaultRead),
    spec("paper.get", OpStability::Stable, OpPermission::VaultRead),
    spec("paper.paths", OpStability::Stable, OpPermission::VaultRead),
    spec(
        "paper.set_read",
        OpStability::Stable,
        OpPermission::CatalogWrite,
    ),
    spec(
        "paper.set_meta",
        OpStability::Stable,
        OpPermission::CatalogWrite,
    ),
    spec(
        "paper.tag.add",
        OpStability::Stable,
        OpPermission::CatalogWrite,
    ),
    spec(
        "paper.tag.rm",
        OpStability::Stable,
        OpPermission::CatalogWrite,
    ),
    spec(
        "paper.tag.set",
        OpStability::Stable,
        OpPermission::CatalogWrite,
    ),
    spec(
        "paper.tag.list",
        OpStability::Stable,
        OpPermission::VaultRead,
    ),
    spec(
        "paper.delete",
        OpStability::Internal,
        OpPermission::Unspecified,
    ),
    spec("paper.move", OpStability::Stable, OpPermission::VaultWrite),
    spec(
        "paper.download",
        OpStability::Internal,
        OpPermission::Unspecified,
    ),
    spec(
        "paper.parse",
        OpStability::Internal,
        OpPermission::Unspecified,
    ),
    spec(
        "import.id",
        OpStability::Internal,
        OpPermission::Unspecified,
    ),
    spec(
        "import.pdf",
        OpStability::Internal,
        OpPermission::Unspecified,
    ),
    spec(
        "discover.arxiv",
        OpStability::Internal,
        OpPermission::Unspecified,
    ),
    spec(
        "export.bib",
        OpStability::Internal,
        OpPermission::Unspecified,
    ),
    spec("layout.list", OpStability::Stable, OpPermission::VaultRead),
    spec("layout.get", OpStability::Stable, OpPermission::VaultRead),
    spec(
        "mark.list",
        OpStability::Internal,
        OpPermission::Unspecified,
    ),
    spec("mark.add", OpStability::Internal, OpPermission::Unspecified),
    spec("mark.get", OpStability::Internal, OpPermission::Unspecified),
    spec(
        "mark.update",
        OpStability::Internal,
        OpPermission::Unspecified,
    ),
    spec(
        "mark.delete",
        OpStability::Internal,
        OpPermission::Unspecified,
    ),
    spec(
        "translate",
        OpStability::Internal,
        OpPermission::Unspecified,
    ),
    spec("doctor", OpStability::Internal, OpPermission::Unspecified),
    spec(
        "doctor.wiki",
        OpStability::Internal,
        OpPermission::Unspecified,
    ),
    spec(
        "paper.notes.get",
        OpStability::Stable,
        OpPermission::VaultRead,
    ),
    spec(
        "paper.notes.write",
        OpStability::Stable,
        OpPermission::VaultNotesWrite,
    ),
    spec(
        "paper.notes.fetch",
        OpStability::Experimental,
        OpPermission::VaultNotesWrite,
    ),
    spec("file.list", OpStability::Stable, OpPermission::VaultRead),
    spec("file.read", OpStability::Stable, OpPermission::VaultRead),
    spec("file.write", OpStability::Stable, OpPermission::VaultWrite),
    spec(
        "file.write_binary",
        OpStability::Internal,
        OpPermission::Unspecified,
    ),
    spec(
        "file.move",
        OpStability::Internal,
        OpPermission::Unspecified,
    ),
    spec(
        "file.delete",
        OpStability::Internal,
        OpPermission::Unspecified,
    ),
    spec("open", OpStability::Internal, OpPermission::Unspecified),
    spec(
        "paper.open",
        OpStability::Internal,
        OpPermission::Unspecified,
    ),
    spec("ui.open", OpStability::Internal, OpPermission::Unspecified),
    spec("ui.close", OpStability::Internal, OpPermission::Unspecified),
    spec(
        "ui.window",
        OpStability::Internal,
        OpPermission::Unspecified,
    ),
    spec("ui.split", OpStability::Internal, OpPermission::Unspecified),
    spec("describe", OpStability::Internal, OpPermission::Unspecified),
];

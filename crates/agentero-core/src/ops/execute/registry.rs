use super::{usage, AppError, Result, Value};
use crate::ops::{self, OpPermission, OpSideEffect, OpSpec};
use std::sync::LazyLock;

macro_rules! research_tools {
    ($($variant:ident => $name:literal),+ $(,)?) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum ToolId { $($variant),+ }
        impl ToolId {
            pub const ALL: &[Self] = &[$(Self::$variant),+];
            pub fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $name),+ }
            }
        }
    };
}

research_tools! {
    EvidenceSearch => "evidence_search",
    EvidenceRead => "evidence_read",
    PaperList => "paper_list",
    PaperGet => "paper_get",
    PaperUpdate => "paper_update",
    PaperDiscover => "paper_discover",
    PaperImport => "paper_import",
    PaperRegions => "paper_regions",
    PaperRelations => "paper_relations",
    PaperTagList => "paper_tag_list",
    PaperTagAdd => "paper_tag_add",
    PaperTagRemove => "paper_tag_remove",
    PaperTagSet => "paper_tag_set",
    PaperNoteAppend => "paper_note_append",
    PaperNoteReplace => "paper_note_replace",
    FileList => "file_list",
    FileWrite => "file_write",
    FileMove => "file_move",
    FileRemove => "file_remove",
    TrashList => "trash_list",
    TrashRestore => "trash_restore",
    AnnotationList => "annotation_list",
    AnnotationGet => "annotation_get",
    AnnotationAdd => "annotation_add",
    AnnotationUpdate => "annotation_update",
    AnnotationRemove => "annotation_remove",
    TableQuery => "table_query",
    TableUpsert => "table_upsert",
    TablePatch => "table_patch",
    VaultList => "vault_list",
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Permissions {
    pub write: bool,
    pub online: bool,
    pub full_text: bool,
}
impl Permissions {
    pub fn all() -> Self {
        Self {
            write: true,
            online: true,
            full_text: true,
        }
    }
}

pub struct ResearchOperation {
    pub id: ToolId,
    pub spec: &'static OpSpec,
    input: jsonschema::Validator,
    output: jsonschema::Validator,
}
impl ResearchOperation {
    pub fn writes(&self) -> bool {
        self.spec.side_effects != OpSideEffect::Read
    }
    pub fn authorize(&self, p: Permissions) -> Result<()> {
        let granted = match self.spec.permission {
            OpPermission::None | OpPermission::VaultRead => true,
            OpPermission::CatalogWrite
            | OpPermission::VaultNotesWrite
            | OpPermission::VaultWrite => p.write,
            OpPermission::Desktop | OpPermission::Sync => false,
        };
        if granted && (!self.writes() || p.write) && (!self.spec.requires_online || p.online) {
            Ok(())
        } else {
            Err(AppError::domain(
                "permission_denied",
                "This tool requires additional grants",
            ))
        }
    }
    pub fn validate_input(&self, input: &Value) -> Result<()> {
        self.input.validate(input).map_err(|e| {
            usage(format!(
                "Invalid {} argument at {} (schema {})",
                self.id.as_str(),
                e.instance_path,
                e.schema_path
            ))
        })
    }
    pub fn checked_output(&self, output: Value) -> Result<Value> {
        self.output.validate(&output).map_err(|e| {
            AppError::domain(
                "invalid_result",
                format!(
                    "{} produced invalid output at {} (schema {})",
                    self.id.as_str(),
                    e.instance_path,
                    e.schema_path
                ),
            )
        })?;
        Ok(output)
    }
}
static OPERATIONS: LazyLock<Vec<ResearchOperation>> = LazyLock::new(|| {
    let declared = ops::all().iter().filter(|op| op.mcp_tool.is_some()).count();
    assert_eq!(declared, ToolId::ALL.len(), "MCP/handler inventory differs");
    ToolId::ALL
        .iter()
        .map(|&id| {
            let spec = ops::get(id.as_str()).expect("missing registered research operation");
            assert_eq!(spec.mcp_tool.as_deref(), Some(id.as_str()));
            ResearchOperation {
                id,
                spec,
                input: jsonschema::validator_for(&spec.input).expect("invalid input schema"),
                output: jsonschema::validator_for(&spec.output).expect("invalid output schema"),
            }
        })
        .collect()
});
pub fn operation(name: &str, p: Permissions) -> Result<&'static ResearchOperation> {
    let op = OPERATIONS
        .iter()
        .find(|op| op.id.as_str() == name)
        .ok_or_else(|| AppError::domain("unknown_tool", "Unknown research tool"))?;
    op.authorize(p)?;
    Ok(op)
}

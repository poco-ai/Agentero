pub mod envelope;
pub mod skills;

pub use envelope::{build_prompt, extract_sources, USER_REQUEST_MARKER};
pub use skills::{
    format_skill_mention, list_agent_skills, load_skill_instructions, skill_activation_prefix,
    skill_mention_style, SkillMentionStyle,
};

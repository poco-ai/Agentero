pub mod config;
pub mod handlers;
pub mod history;
pub mod pool;
pub mod query;
pub mod run;
pub mod warm;

pub use history::{delete_acp_session, list_acp_sessions, load_acp_session};
pub use pool::AgentWarmPool;
pub use query::AgentQueryPool;
pub use run::{
    new_ids, run_once, serve_delegate_prompts, DelegatePrompt, DelegateUserWait, RunOnceParams,
};
pub use warm::warm_agent;

/// Paging helpers — used by unit tests (`acp_tests`).
pub use history::{
    list_sessions_page_done, LIST_SESSIONS_BUDGET, LIST_SESSIONS_MAX, LIST_SESSIONS_MAX_PAGES,
};

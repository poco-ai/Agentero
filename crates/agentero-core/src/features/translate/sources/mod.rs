pub mod azure;
pub mod cnki;
pub mod deepl;
pub mod google_cloud;
pub mod hunyuan_mt;
pub mod huoshanweb;
pub mod index_translate;
pub mod openai_compatible;
pub mod tencent_transmart;

pub(crate) use super::{http_err, lang_base, optional_endpoint, read_body, required_api_key};

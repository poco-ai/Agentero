//! PDF metadata recognition: probe → recognizer → resolve.

pub mod pdf_recognize;

pub use pdf_recognize::{
    apply_probe_fields, canonical_base_id, meta_from_recognize, recognize_and_resolve,
    recognize_pdf, PdfIdentProbe, RecognizeAuthor, RecognizeHit,
};

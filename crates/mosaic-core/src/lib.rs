//! Mosaic core: the only code that touches a vault. The app, CLI and MCP server are thin front ends over it.

pub mod api;
pub mod error;
pub mod index;
pub mod kind;
pub mod links;
pub mod parse;
pub mod settings;
pub mod vault;

pub use api::Workspace;
pub use error::{Error, Result};
pub use kind::FileKind;
pub use vault::{Entry, FileContent, Vault, Written};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

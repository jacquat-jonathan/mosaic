//! Mosaic core: the only code that touches a vault. The app, CLI and MCP server are thin front ends over it.

pub mod agents;
pub mod api;
pub mod chat;
pub mod days;
pub mod error;
pub mod history;
pub mod index;
pub mod kind;
pub mod links;
pub mod parse;
pub mod query;
pub mod render;
pub mod review;
pub mod route;
pub mod settings;
pub mod timing;
pub mod validate;
pub mod vault;
pub mod watch;

pub use api::Workspace;
pub use error::{Error, Result};
pub use kind::FileKind;
pub use vault::{Entry, FileContent, Vault, Written};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

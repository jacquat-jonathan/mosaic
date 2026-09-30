use serde::Serialize;

pub type Result<T> = std::result::Result<T, Error>;

/// Every failure a front end (app, CLI, MCP) can see. `code()` is stable and machine-readable.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("already exists: {0}")]
    AlreadyExists(String),
    #[error("file changed since it was read: {path} (current hash {current_hash})")]
    Conflict { path: String, current_hash: String },
    #[error("invalid path: {0}")]
    InvalidPath(String),
    #[error("not a text file: {0}")]
    NotText(String),
    #[error("{0}")]
    Invalid(String),
    #[error("io error on {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
}

impl Error {
    pub fn code(&self) -> &'static str {
        match self {
            Error::NotFound(_) => "not_found",
            Error::AlreadyExists(_) => "already_exists",
            Error::Conflict { .. } => "conflict",
            Error::InvalidPath(_) => "invalid_path",
            Error::NotText(_) => "not_text",
            Error::Invalid(_) => "invalid",
            Error::Io { .. } => "io",
        }
    }

    pub(crate) fn io(path: impl Into<String>, source: std::io::Error) -> Self {
        let path = path.into();
        match source.kind() {
            std::io::ErrorKind::NotFound => Error::NotFound(path),
            std::io::ErrorKind::AlreadyExists => Error::AlreadyExists(path),
            _ => Error::Io { path, source },
        }
    }
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("Error", 3)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        let hash = match self {
            Error::Conflict { current_hash, .. } => Some(current_hash.as_str()),
            _ => None,
        };
        st.serialize_field("current_hash", &hash)?;
        st.end()
    }
}

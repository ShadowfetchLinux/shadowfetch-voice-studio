//! The error type every command returns to the frontend.
//!
//! It mirrors the worker protocol's `error` object (docs/PROTOCOL.md) so the UI
//! has exactly one error shape to switch on, whether the failure happened in the
//! Python worker or in the shell itself.

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Stable error codes. The protocol codes live in `backend/shadowfetch_worker/protocol.py`;
/// the shell adds `WORKER_DOWN` (worker not running / died mid-request) and `BUSY`.
pub mod codes {
    pub const WORKER_DOWN: &str = "WORKER_DOWN";
    pub const BUSY: &str = "BUSY";
    pub const INVALID_PARAMS: &str = "INVALID_PARAMS";
    pub const NOT_FOUND: &str = "NOT_FOUND";
    pub const PERMISSION_DENIED: &str = "PERMISSION_DENIED";
    pub const INTERNAL: &str = "INTERNAL";
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerError {
    pub code: String,
    pub message: String,
    #[serde(default = "empty_object")]
    pub details: Value,
    #[serde(default = "default_true")]
    pub recoverable: bool,
}

fn empty_object() -> Value {
    json!({})
}

fn default_true() -> bool {
    true
}

impl WorkerError {
    /// A recoverable error with empty details.
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            details: json!({}),
            recoverable: true,
        }
    }

    /// Attach structured details.
    pub fn with_details(mut self, details: Value) -> Self {
        self.details = details;
        self
    }

    /// Mark the error as not recoverable by a plain retry.
    pub fn unrecoverable(mut self) -> Self {
        self.recoverable = false;
        self
    }

    /// The worker is not running (or died while the request was in flight).
    /// `stopped` tells the UI whether the supervisor gave up (needs an explicit restart).
    pub fn worker_down(message: impl Into<String>, stopped: bool) -> Self {
        Self::new(codes::WORKER_DOWN, message).with_details(json!({ "stopped": stopped }))
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(codes::INVALID_PARAMS, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(codes::NOT_FOUND, message)
    }

    pub fn denied(message: impl Into<String>) -> Self {
        Self::new(codes::PERMISSION_DENIED, message).unrecoverable()
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(codes::INTERNAL, message)
    }

    /// Build from the protocol's `error` object; tolerant of missing fields.
    pub fn from_protocol(value: &Value) -> Self {
        serde_json::from_value(value.clone()).unwrap_or_else(|_| {
            Self::internal(format!("malformed error object from worker: {value}"))
        })
    }
}

impl fmt::Display for WorkerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for WorkerError {}

impl From<std::io::Error> for WorkerError {
    fn from(e: std::io::Error) -> Self {
        let code = match e.kind() {
            std::io::ErrorKind::NotFound => codes::NOT_FOUND,
            std::io::ErrorKind::PermissionDenied => codes::PERMISSION_DENIED,
            _ => codes::INTERNAL,
        };
        Self::new(code, e.to_string())
    }
}

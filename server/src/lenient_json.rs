//! A JSON request body that does not insist on `Content-Type: application/json`.
//!
//! axum's `Json` rejects any other label with 415 before a handler sees the request.  The
//! desktop client's builds up to 1.0.6 post several of their JSON bodies with libcurl's
//! default label, `application/x-www-form-urlencoded`, so every checkpoint, restore, comment
//! and new-sheet-doc request from those builds died at the door with a generic "could not be
//! created".  The bytes are what matter: accept the body whatever the label says, and answer a
//! 400 naming the parse error when it is not JSON.

use axum::body::Bytes;
use axum::extract::{FromRequest, Request};
use serde::de::DeserializeOwned;

use crate::error::AppError;

pub struct LenientJson<T>(pub T);

impl<S, T> FromRequest<S> for LenientJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = AppError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let bytes = Bytes::from_request(req, state)
            .await
            .map_err(|e| AppError::BadRequest(format!("unreadable request body: {e}")))?;
        let value = serde_json::from_slice(&bytes)
            .map_err(|e| AppError::BadRequest(format!("invalid json body: {e}")))?;
        Ok(LenientJson(value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Named {
        name: String,
    }

    fn request(content_type: Option<&str>, body: &'static str) -> Request {
        let mut builder = Request::builder().method("POST").uri("/api/x");
        if let Some(ct) = content_type {
            builder = builder.header("content-type", ct);
        }
        builder.body(Body::from(body)).unwrap()
    }

    #[tokio::test]
    async fn accepts_a_json_body_under_the_form_label_old_clients_send() {
        let req = request(Some("application/x-www-form-urlencoded"), r#"{"name":"before layout"}"#);
        let LenientJson(v) = LenientJson::<Named>::from_request(req, &()).await.unwrap();
        assert_eq!(v.name, "before layout");
    }

    #[tokio::test]
    async fn accepts_a_json_body_with_no_label_at_all() {
        let req = request(None, r#"{"name":"v2"}"#);
        let LenientJson(v) = LenientJson::<Named>::from_request(req, &()).await.unwrap();
        assert_eq!(v.name, "v2");
    }

    #[tokio::test]
    async fn still_accepts_properly_labelled_json() {
        let req = request(Some("application/json; charset=utf-8"), r#"{"name":"v3"}"#);
        let LenientJson(v) = LenientJson::<Named>::from_request(req, &()).await.unwrap();
        assert_eq!(v.name, "v3");
    }

    #[tokio::test]
    async fn rejects_a_body_that_is_not_json_as_a_bad_request() {
        let req = request(Some("application/json"), "name=v4");
        match LenientJson::<Named>::from_request(req, &()).await {
            Err(AppError::BadRequest(msg)) => assert!(msg.contains("invalid json body"), "{msg}"),
            Err(other) => panic!("wrong rejection: {other}"),
            Ok(_) => panic!("form data must not parse as json"),
        }
    }
}

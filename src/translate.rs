use std::{convert::Infallible, time::Duration};

use anyhow::{Context, Result};
use axum::{
    extract::State,
    http::{header, HeaderName},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse,
    },
    Json,
};
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct TranslateRequest {
    pub text: String,
    pub target_lang: String,
    #[serde(default)]
    pub source_lang: Option<String>,
    /// Recent conversation history, oldest first.
    #[serde(default)]
    pub context: Vec<ContextPair>,
}

#[derive(Debug, Deserialize)]
pub struct ContextPair {
    pub source: String,
    #[serde(default)]
    pub translation: String,
}

/// POST /api/translate — streams the translation back as Server-Sent Events
/// over the POST response body (works through Cloudflare, unlike WebSockets
/// on some plans; keep-alive comments prevent proxy idle timeouts).
pub async fn api_translate(
    State(state): State<AppState>,
    Json(req): Json<TranslateRequest>,
) -> impl IntoResponse {
    let (tx, rx) = mpsc::channel::<Event>(64);
    tokio::spawn(async move {
        if let Err(err) = stream_translation(&state, &req, &tx).await {
            tracing::error!("translation stream failed: {err:#}");
            let payload = json!({ "type": "error", "message": format!("{err:#}") });
            let _ = tx.send(Event::default().data(payload.to_string())).await;
        }
    });

    let stream = ReceiverStream::new(rx).map(Ok::<_, Infallible>);
    (
        [
            (header::CACHE_CONTROL, "no-cache"),
            (HeaderName::from_static("x-accel-buffering"), "no"),
        ],
        Sse::new(stream).keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(15))
                .text("keep-alive"),
        ),
    )
}

async fn stream_translation(
    state: &AppState,
    req: &TranslateRequest,
    tx: &mpsc::Sender<Event>,
) -> Result<()> {
    let llm = &state.cfg.llm;

    let mut system = format!(
        "You are a professional real-time interpreter. Translate each user message into {}.",
        req.target_lang
    );
    if let Some(source) = req.source_lang.as_deref().filter(|s| !s.is_empty()) {
        system.push_str(&format!(" The speaker's language is {source}."));
    }
    system.push_str(
        " Preserve the meaning, tone, and register of the original. \
         Output only the translation - no explanations, no quotation marks, no notes.",
    );

    let mut messages = vec![json!({ "role": "system", "content": system })];
    // Prior utterances become user/assistant turns so the model keeps
    // terminology and pronouns consistent across sentences.
    let skip = req.context.len().saturating_sub(llm.context_messages);
    for pair in &req.context[skip..] {
        if pair.source.trim().is_empty() || pair.translation.trim().is_empty() {
            continue;
        }
        messages.push(json!({ "role": "user", "content": pair.source }));
        messages.push(json!({ "role": "assistant", "content": pair.translation }));
    }
    messages.push(json!({ "role": "user", "content": req.text }));

    let mut body = json!({
        "model": llm.model,
        "messages": messages,
        "stream": true,
    });
    if let Some(temperature) = llm.temperature {
        body["temperature"] = json!(temperature);
    }

    let url = format!("{}/chat/completions", llm.endpoint.trim_end_matches('/'));
    let resp = state
        .http
        .post(&url)
        .bearer_auth(&llm.api_key)
        .json(&body)
        .send()
        .await
        .context("LLM request failed")?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("LLM endpoint returned {status}: {body}");
    }

    let mut upstream = resp.bytes_stream();
    // Buffer raw bytes and split on newlines (ASCII), so multi-byte UTF-8
    // characters split across network chunks are never corrupted.
    let mut buf: Vec<u8> = Vec::new();
    'outer: while let Some(chunk) = upstream.next().await {
        let chunk = chunk.context("error reading LLM stream")?;
        buf.extend_from_slice(&chunk);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            let Some(data) = line.trim().strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data == "[DONE]" {
                break 'outer;
            }
            let Ok(value) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            if let Some(delta) = value["choices"][0]["delta"]["content"].as_str() {
                if delta.is_empty() {
                    continue;
                }
                let payload = json!({ "type": "delta", "text": delta });
                if tx
                    .send(Event::default().data(payload.to_string()))
                    .await
                    .is_err()
                {
                    // Client disconnected; stop reading from the LLM.
                    return Ok(());
                }
            }
        }
    }

    let _ = tx
        .send(Event::default().data(json!({ "type": "done" }).to_string()))
        .await;
    Ok(())
}

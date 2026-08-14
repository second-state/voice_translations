//! The vendored Silero VAD + onnxruntime-web assets, compiled into the
//! binary.
//!
//! Enabled by the `embed-assets` feature. A crate that depends on this one
//! has no access to this source tree at runtime, so it mounts
//! [`vendor_router`] and ships a single self-contained executable:
//!
//! ```no_run
//! # use axum::Router;
//! let app: Router = Router::new().nest("/vendor", voice_translations::assets::vendor_router());
//! ```
//!
//! The browser-side loader expects these exact filenames under the mount
//! point, so mount the router at whatever path is passed to the VAD as
//! `baseAssetPath` / `onnxWASMBasePath`.

use axum::{
    extract::Path,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};

/// Filename, bytes, content type. Roughly 15 MB in total, dominated by the
/// onnxruntime WebAssembly module.
const VENDOR: &[(&str, &[u8], &str)] = &[
    (
        "bundle.min.js",
        include_bytes!("../static/vendor/bundle.min.js"),
        "application/javascript; charset=utf-8",
    ),
    (
        "vad.worklet.bundle.min.js",
        include_bytes!("../static/vendor/vad.worklet.bundle.min.js"),
        "application/javascript; charset=utf-8",
    ),
    (
        "ort.wasm.min.js",
        include_bytes!("../static/vendor/ort.wasm.min.js"),
        "application/javascript; charset=utf-8",
    ),
    (
        "ort-wasm-simd-threaded.mjs",
        include_bytes!("../static/vendor/ort-wasm-simd-threaded.mjs"),
        "text/javascript; charset=utf-8",
    ),
    (
        "ort-wasm-simd-threaded.wasm",
        include_bytes!("../static/vendor/ort-wasm-simd-threaded.wasm"),
        "application/wasm",
    ),
    (
        "silero_vad_v5.onnx",
        include_bytes!("../static/vendor/silero_vad_v5.onnx"),
        "application/octet-stream",
    ),
    (
        "silero_vad_legacy.onnx",
        include_bytes!("../static/vendor/silero_vad_legacy.onnx"),
        "application/octet-stream",
    ),
];

/// Router serving the embedded assets, to be nested under a mount point.
///
/// Generic over the surrounding app's state type (these routes need no state)
/// so it can be nested directly into a stateful router.
pub fn vendor_router<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new().route("/{*file}", get(serve))
}

/// Look one asset up by name. Useful for apps that build their own routes.
pub fn vendor_asset(name: &str) -> Option<(&'static [u8], &'static str)> {
    VENDOR
        .iter()
        .find(|(file, _, _)| *file == name)
        .map(|(_, bytes, mime)| (*bytes, *mime))
}

async fn serve(Path(file): Path<String>) -> Response {
    match vendor_asset(&file) {
        Some((bytes, mime)) => (
            [
                (header::CONTENT_TYPE, mime),
                // Versioned vendor blobs that only change with a rebuild.
                (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
            ],
            bytes,
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "unknown vendor asset").into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::{vendor_asset, VENDOR};

    #[test]
    fn every_asset_is_present_and_non_empty() {
        assert_eq!(VENDOR.len(), 7);
        for (name, bytes, _) in VENDOR {
            assert!(!bytes.is_empty(), "{name} is empty");
        }
    }

    #[test]
    fn wasm_is_served_with_the_mime_streaming_instantiation_needs() {
        let (bytes, mime) = vendor_asset("ort-wasm-simd-threaded.wasm").expect("wasm asset");
        assert_eq!(mime, "application/wasm");
        assert_eq!(&bytes[..4], b"\0asm");
        assert!(vendor_asset("../../etc/passwd").is_none());
    }
}

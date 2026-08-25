# @deepseek-ai/dsh-client-userdoc-upload

English | [中文](README.zh.md)

Shared browser-only uploader used by the conversation composer and document manager. It sends the `resumable-v1` user-document protocol in bounded XHR chunks, computes per-chunk and final SHA-256 digests, retries transient network failures, and stores opaque session metadata so the same selected file can resume after a page reload.

The package has no Cordis service or UI surface. Host-specific clients provide their relative route, JSON request helper, and network-error adapter; the uploader keeps file bytes in the browser and persists only opaque session metadata in IndexedDB (with a localStorage fallback), never document bytes.

## Model Experience

None, as this browser transport only moves document bytes and returns a stored reference; prompt assembly and model requests belong to the consuming Host packages.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **One active file per call** — the host UI owns multi-file sequencing and cancellation; this package deliberately keeps one resumable state machine per selected file.
- **Browser storage is best-effort** — private-mode or quota-restricted browsers may lose the session metadata, after which the server still retains the session until its configured expiry but the user must select the file again without a local session id.
- **Host adapters own authentication and route availability** — the uploader only maps the callbacks supplied by its consumer and cannot refresh credentials or discover an unavailable document service.

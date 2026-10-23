# Katab RAG Service (in-repo copy)

This directory is the **canonical, versioned copy** of the local retrieval service that powers
Katab's Knowledge Base. It runs as a systemd user unit (`katabai-rag.service`) from
`~/.local/share/katabai/rag-service/` and listens on `127.0.0.1:11435`.

The extension never launches the service itself; it only talks HTTP to the configured
`rag-service-url`.

## Layout

| File | Purpose |
|---|---|
| `server.py` | FastAPI app: chunking, embedding, ChromaDB storage, hybrid search, rerank, maintenance |
| `requirements.txt` | Python dependencies |
| `tests/test_server.py` | stdlib `unittest` suite (no network required) |

## What it stores

- **ChromaDB** at `~/.local/share/katabai/chroma/`.
- **Collections**: `conversations`, `documents`, `research_cache`.
- **Embeddings** from Ollama's `/api/embed` (`rag-embedding-model`, default `nomic-embed-text`).
- Collections use **cosine** distance; legacy L2 collections are migrated at startup by copying
  embeddings verbatim (no re-embedding).
- BM25 indexes are in memory and rebuilt lazily from ChromaDB.

## Install and run

The recommended path is **Preferences → Tools → Knowledge Base → Set Up & Start**, which creates the
venv, installs dependencies, writes the unit file, and starts the service. Manually:

```bash
# 1. Put the source where the unit expects it
mkdir -p ~/.local/share/katabai/rag-service
cp server.py requirements.txt ~/.local/share/katabai/rag-service/

# 2. Create the venv and install dependencies
cd ~/.local/share/katabai/rag-service
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# 3. Pull the embedding model (once)
ollama pull nomic-embed-text

# 4. Run in the foreground (Ctrl+C to stop)
.venv/bin/python3 server.py
```

### systemd user unit

```ini
[Unit]
Description=Katabai RAG Service
After=network.target

[Service]
Type=simple
ExecStart=%h/.local/share/katabai/rag-service/.venv/bin/python3 %h/.local/share/katabai/rag-service/server.py
WorkingDirectory=%h/.local/share/katabai/rag-service
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now katabai-rag.service
systemctl --user status katabai-rag.service
curl http://127.0.0.1:11435/health
```

## Updating the deployed copy

```bash
make sync-rag-server                    # cp rag-service/server.py → ~/.local/share/katabai/rag-service/
systemctl --user restart katabai-rag
```

## Tests

```bash
make test-rag-server                    # uses the deployed venv when present
python -m unittest discover -s rag-service/tests -p 'test_*.py'
```

CI runs the same suite in the `rag-server-tests` job.

## API summary

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Service status, collection counts, storage limits, embedding/reranker/BM25 diagnostics |
| `POST` | `/index` | Chunk, embed, and store texts (up to 1000 per request; `replace_ids`, caps, auto-prune) |
| `POST` | `/search` | Dense search + optional BM25 fusion + optional batched reranking |
| `POST` | `/delete` | Delete by `ids`, `prefixes`, and/or `source_ids` |
| `DELETE` | `/collection/{name}` | Drop one collection |
| `POST` | `/clear` | Drop all collections |
| `GET` | `/export` | Page out all chunks as JSON (`offset`/`limit`) |

The full request/response shapes are documented in
[`Documentation/Technical/API_REFERENCE.md`](../Documentation/Technical/API_REFERENCE.md#rag-service).

## Notes

- The service is expected to be reachable only on loopback. Do not expose it to a network.
- When Ollama is unreachable, `/health` reports `embedding.ok = false` and `/search` answers `503`.
- The optional reranker (`bge-reranker-v2-m3`) and `rank-bm25` are optional but recommended; the
  service degrades to dense-only search without them.

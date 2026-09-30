# Katabai RAG Service (in-repo copy)

This directory is the **canonical, versioned copy** of the local RAG service
that runs at `~/.local/share/katabai/rag-service/server.py` as the
`katabai-rag.service` systemd user unit.

- Edit here, then: `make sync-rag-server` → `systemctl --user restart katabai-rag`
- Tests: `make test-rag-server` (stdlib unittest; uses the service venv for imports)
- Dependencies: see `requirements.txt` (chromadb, ollama, fastapi, uvicorn, rank-bm25)

The deployed copy keeps its own virtualenv at
`~/.local/share/katabai/rag-service/.venv`; this repo copy is source-only.

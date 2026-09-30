"""
Katabai Local RAG Service
=========================
FastAPI server wrapping ChromaDB + Ollama /api/embed for local semantic search.

Endpoints:
  POST /index       – chunk + embed + store texts into a named collection
  POST /search      – embed query + cosine similarity search (with optional BM25 hybrid & reranking)
  GET  /health      – service health & collection stats
  DELETE /collection/{name} – drop a named collection

Usage:
  cd ~/.local/share/katabai/rag-service
  pip install -r requirements.txt rank-bm25
  python server.py

The server listens on 127.0.0.1:11435 by default.
"""

import json
import logging
import math
import os
import re
import threading
import time
from collections import defaultdict
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, Optional

import chromadb
import httpx
import ollama
import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from chromadb.api import ClientAPI

# Optional BM25 dependency — installed alongside requirements.
# The TYPE_CHECKING-only import gives the type checker the real class for
# annotations; the runtime import below is what actually gets called.
if TYPE_CHECKING:
    from rank_bm25 import BM25Okapi as _BM25OkapiType  # noqa: F401

try:
    from rank_bm25 import BM25Okapi

    _BM25_AVAILABLE = True
except ImportError:
    _BM25_AVAILABLE = False
    BM25Okapi = None  # type: ignore[assignment]

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

CHROMADB_PATH = os.path.expanduser("~/.local/share/katabai/chroma")
DEFAULT_EMBEDDING_MODEL = "nomic-embed-text"
DEFAULT_CHUNK_SIZE = 800
DEFAULT_CHUNK_OVERLAP = 120
MAX_BATCH_SIZE = 100  # max texts per /api/embed call
SERVER_HOST = "127.0.0.1"
SERVER_PORT = 11435

# ── Guardrails ────────────────────────────────────────────────────────────
DEFAULT_MAX_CHUNKS_PER_COLLECTION = 10000  # hard cap; 0 = unlimited
DEFAULT_MAX_TOTAL_SIZE_MB = 500  # estimated disk cap; 0 = unlimited
MAX_CHARS_PER_INDEX_TEXT = 100_000  # reject individual texts longer than this
MAX_TEXTS_PER_INDEX_REQUEST = 1000  # reject batches larger than this
EXPORT_PAGE_SIZE = 2000  # chunks per export page

# ── Phase 3: Advanced Retrieval ──────────────────────────────────────────
RRF_K = 60  # reciprocal rank fusion constant
DEFAULT_RERANK_MODEL = "bge-reranker-v2-m3"
RERANK_BATCH_PROMPT_TEMPLATE = (
    "You are a relevance scorer. Given a search query and numbered document "
    "chunks, rate how relevant each chunk is to the query on a scale from 0 "
    "to 1 (0 = irrelevant, 1 = perfectly relevant).\n\n"
    'Reply ONLY with JSON in this exact shape: {{"scores": [ ... ]}} — one '
    "score per document, in the same order.\n\n"
    "Query: {query}\n\nDocuments:\n{documents}"
)
RERANK_BATCH_SIZE = 10  # max documents per reranker call

# ── Embedding space & migration ──────────────────────────────────────────
# All collections use cosine distance so `score = 1 - distance` is a true
# cosine similarity (the extension's relevance thresholds assume this).
# Existing L2 collections are migrated once at startup; stored embeddings are
# copied verbatim (cosine distance is scale-invariant, no re-embedding needed).
EMBEDDING_SPACE = "cosine"
MIGRATION_META_KEY = "katabai_space"
MIGRATION_BATCH_SIZE = 500

# Ollama keep-alive for embedding calls — keeps the embedding model resident
# between searches so cold model loads don't dominate query latency.
EMBED_KEEP_ALIVE = os.environ.get("KATAB_EMBED_KEEP_ALIVE", "30m")

# Bounded Ollama client timeouts so an unreachable or wedged Ollama (e.g. a
# remote AI PC whose TCP connects black-hole, or a model stuck loading) can
# never block a request handler for the OS-default ~2 minutes.  Connect bounds
# stay short everywhere; read bounds differ by operation (probe fast,
# embeddings and rerank generation generous).
OLLAMA_PROBE_TIMEOUT = httpx.Timeout(connect=4.0, read=6.0, write=5.0, pool=5.0)
OLLAMA_EMBED_TIMEOUT = httpx.Timeout(connect=4.0, read=240.0, write=30.0, pool=10.0)
OLLAMA_CHAT_TIMEOUT = httpx.Timeout(connect=4.0, read=180.0, write=30.0, pool=10.0)

# Per-collection BM25 indices (lazy-built, populated during indexing)
_bm25_indices: dict[str, Optional["_BM25OkapiType"]] = {}
_bm25_corpora: dict[str, list[str]] = defaultdict(list)
_bm25_id_maps: dict[str, list[str]] = defaultdict(list)  # corpus index → chroma id
_bm25_metas: dict[str, list] = defaultdict(list)  # corpus index → metadata

# Collections whose BM25 corpus is stale because chunks were deleted,
# replaced, or evicted.  The next hybrid search rebuilds them from ChromaDB —
# the single source of truth.  rank_bm25 cannot delete documents, so without
# this the corpus would serve deleted content forever (and grow unbounded).
_bm25_dirty: set[str] = set()
_bm25_lock = threading.Lock()

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="[katab-rag] %(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("katab-rag")

# ---------------------------------------------------------------------------
# Chunking
# ---------------------------------------------------------------------------


def _overlap_tail(text: str, overlap: int) -> str:
    """Return the trailing `overlap` characters of `text`, snapped forward to a
    word boundary so the next chunk does not start mid-word."""
    if overlap <= 0 or not text:
        return ""
    if len(text) <= overlap:
        return text
    cut = len(text) - overlap
    space = text.find(" ", cut)
    if space != -1 and space - cut < 40:
        cut = space + 1
    return text[cut:]


def chunk_text(
    text: str,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    chunk_overlap: int = DEFAULT_CHUNK_OVERLAP,
) -> list[str]:
    """Split text into overlapping chunks at paragraph and sentence boundaries.

    The overlap is applied whenever a new chunk starts: it is seeded with the
    tail of the previous chunk so information spanning a boundary stays
    retrievable from both sides.  The overlap is clamped to half the size.
    """
    if not text or not text.strip():
        return []

    chunk_size = max(50, int(chunk_size or DEFAULT_CHUNK_SIZE))
    chunk_overlap = max(0, min(int(chunk_overlap or 0), chunk_size // 2))

    # Phase 1: split into segments that are each <= chunk_size
    segments: list[str] = []
    for para in re.split(r"\n\s*\n", text.strip()):
        para = para.strip()
        if not para:
            continue

        if len(para) <= chunk_size:
            segments.append(para)
            continue

        # Split paragraph into sentence-boundary segments
        current = ""
        for sentence in re.split(r"(?<=[.!?])\s+", para):
            sentence = sentence.strip()
            if not sentence:
                continue
            if len(current) + len(sentence) + 1 <= chunk_size:
                current = (current + " " + sentence).strip() if current else sentence
            else:
                if current:
                    segments.append(current)
                    current = ""
                # If a single sentence exceeds chunk_size, hard-split it with
                # an overlapping stride (also gives overlap between the pieces
                # of one very long sentence).
                if len(sentence) > chunk_size:
                    step = max(1, chunk_size - chunk_overlap)
                    pos = 0
                    while pos < len(sentence):
                        piece = sentence[pos : pos + chunk_size].strip()
                        if piece:
                            segments.append(piece)
                        if pos + chunk_size >= len(sentence):
                            break
                        pos += step
                else:
                    current = sentence
        if current:
            segments.append(current)

    # Phase 2: merge segments into chunks, seeding each new chunk with the
    # overlapping tail of the previous one.
    chunks: list[str] = []
    current = ""
    for seg in segments:
        if not current:
            current = seg
            continue
        if len(current) + 1 + len(seg) <= chunk_size:
            current = f"{current} {seg}"
            continue
        chunks.append(current)
        tail = _overlap_tail(current, chunk_overlap)
        candidate = f"{tail} {seg}".strip() if tail else seg
        current = candidate if len(candidate) <= chunk_size else seg
    if current:
        chunks.append(current)

    return chunks


# ---------------------------------------------------------------------------
# Embedding helper
# ---------------------------------------------------------------------------


def generate_embeddings(
    texts: list[str],
    model: str = DEFAULT_EMBEDDING_MODEL,
    ollama_url: str = "http://localhost:11434",
) -> list[list[float]]:
    """Generate L2-normalized embeddings via Ollama /api/embed.

    Uses an explicit Ollama host so embeddings can come from a remote
    AI PC rather than requiring a local Ollama installation.
    """
    client = ollama.Client(host=ollama_url, timeout=OLLAMA_EMBED_TIMEOUT)
    all_embeddings: list[list[float]] = []

    for i in range(0, len(texts), MAX_BATCH_SIZE):
        batch = texts[i : i + MAX_BATCH_SIZE]
        log.info(
            "Embedding batch %d–%d of %d texts via %s",
            i,
            i + len(batch),
            len(texts),
            ollama_url,
        )
        try:
            resp = client.embed(model=model, input=batch, keep_alive=EMBED_KEEP_ALIVE)
        except TypeError:
            # Older ollama clients don't accept keep_alive on embed()
            resp = client.embed(model=model, input=batch)

        if not resp or not resp.get("embeddings"):
            raise RuntimeError(
                f"Ollama /api/embed returned no embeddings for model '{model}'"
            )

        for j, emb in enumerate(resp["embeddings"]):
            # Zero-vector validation
            magnitude = math.sqrt(sum(v * v for v in emb))
            if magnitude == 0.0:
                raise RuntimeError(
                    f"Zero-vector returned by embedding model '{model}' "
                    f"for text[{i + j}]: '{batch[j][:80]}...'"
                )
            all_embeddings.append(emb)

    return all_embeddings


def _ollama_model_names(models) -> set[str]:
    """Normalize the `ollama.Client.list()` result across client versions.

    Older ollama clients return a plain dict (`{"models": [{"name": ...}]}`),
    while newer clients return a `ListResponse` pydantic model whose entries
    are objects with `.model` / `.name` attributes.  Return the set of
    available model name strings for either shape.
    """
    if isinstance(models, dict):
        entries = models.get("models", []) or []
        names = set()
        for entry in entries:
            if isinstance(entry, dict):
                names.add(str(entry.get("name") or entry.get("model") or ""))
        return names

    entries = getattr(models, "models", None) or []
    return {
        str(getattr(m, "model", "") or getattr(m, "name", "") or "") for m in entries
    }


def ensure_embedding_model(
    model: str, ollama_url: str = "http://localhost:11434"
) -> None:
    """Check if the embedding model is available; attempt pull if missing."""
    client = ollama.Client(host=ollama_url, timeout=OLLAMA_EMBED_TIMEOUT)
    try:
        model_names = _ollama_model_names(client.list())
        # Also check short names (some APIs return "nomic-embed-text:latest")
        if any(model == mn or mn.startswith(f"{model}:") for mn in model_names):
            log.info("Embedding model '%s' is available", model)
            return
    except Exception:
        log.warning("Could not list Ollama models; attempting pull of '%s'", model)

    log.info("Pulling embedding model '%s' from %s...", model, ollama_url)
    try:
        client.pull(model)
        log.info("Successfully pulled '%s'", model)
    except Exception as exc:
        raise RuntimeError(
            f"Failed to pull embedding model '{model}'. "
            f"Run 'ollama pull {model}' manually. Error: {exc}"
        )


def _compute_storage_size_mb() -> float:
    """Actual on-disk size estimate (expensive — walks the ChromaDB dir)."""
    try:
        total_bytes = 0
        for dirpath, _dirnames, filenames in os.walk(CHROMADB_PATH):
            for fname in filenames:
                try:
                    total_bytes += os.path.getsize(os.path.join(dirpath, fname))
                except OSError:
                    continue
        return max(total_bytes, 0) / (1024 * 1024)
    except Exception:
        pass

    # Fallback: count all chunks × rough per-chunk estimate (~2KB for
    # 384-dim vector + metadata + document text)
    try:
        client = get_chroma()
        total_chunks = 0
        col_names = _collection_names(client)
        for name in col_names:
            try:
                col = client.get_collection(name=name)
                total_chunks += col.count()
            except Exception:
                continue
        return (total_chunks * 2048) / (1024 * 1024)
    except Exception:
        return 0.0


# TTL cache for the storage-size estimate.  The directory walk is expensive and
# the cap is a soft limit, so a slightly stale value is fine — this removes a
# full walk from every delta /index request (the main per-message cost before).
_storage_size_cache: dict = {"value": 0.0, "ts": 0.0}
STORAGE_SIZE_CACHE_TTL_S = 60


def estimate_storage_size_mb(force: bool = False) -> float:
    """Cached on-disk size estimate used by the storage-cap check."""
    now = time.monotonic()
    if (
        not force
        and _storage_size_cache["ts"] > 0
        and (now - _storage_size_cache["ts"]) < STORAGE_SIZE_CACHE_TTL_S
    ):
        return _storage_size_cache["value"]
    value = _compute_storage_size_mb()
    _storage_size_cache["value"] = value
    _storage_size_cache["ts"] = now
    return value


def _warm_embedding_model(
    model: str, ollama_url: str = "http://localhost:11434"
) -> None:
    """Pre-load the embedding model so the first user search isn't a cold start.

    Runs in a background thread at startup.  Uses the default local URL/model —
    per-request URL/model come from client settings and are warmed on first use
    via the embedding keep-alive.  Failures are non-fatal (Ollama may be down).
    """
    try:
        generate_embeddings(["warmup"], model, ollama_url=ollama_url)
        log.info("Embedding model '%s' warmed up", model)
    except Exception as exc:
        log.info("Embedding warm-up skipped: %s", exc)


# ---------------------------------------------------------------------------
# Phase 3: BM25 Index Management
# ---------------------------------------------------------------------------


def _tokenize(text: str) -> list[str]:
    """Simple whitespace + punctuation tokenizer for BM25."""
    return re.findall(r"[a-zA-Z0-9]+", str(text).lower())


def _collection_names(client: ClientAPI) -> list[str]:
    """Return collection names as plain strings across chromadb versions.

    Modern chromadb returns ``Collection`` objects (with a ``.name``
    attribute); older versions returned plain name strings.  Normalize
    both to ``list[str]``.
    """
    return [str(getattr(col, "name", col)) for col in client.list_collections()]


def _build_bm25_index(col_name: str) -> Optional["_BM25OkapiType"]:
    """Build a BM25 index from all chunks in a ChromaDB collection."""
    if not _BM25_AVAILABLE:
        return None

    try:
        client = get_chroma()
        col = client.get_collection(name=col_name)
        data = col.get(include=["documents", "metadatas"])
        docs = data.get("documents", []) or []
        ids = data.get("ids", []) or []
        metas = data.get("metadatas", []) or []

        if not docs:
            _bm25_corpora[col_name] = []
            _bm25_id_maps[col_name] = []
            _bm25_metas[col_name] = []
            _bm25_indices[col_name] = None
            return None

        tokenized = [_tokenize(d) for d in docs]
        _bm25_corpora[col_name] = docs
        _bm25_id_maps[col_name] = ids
        _bm25_metas[col_name] = metas
        assert BM25Okapi is not None  # guaranteed by the _BM25_AVAILABLE guard above
        _bm25_indices[col_name] = BM25Okapi(tokenized)
        log.info("BM25 index built for '%s': %d documents", col_name, len(docs))
        return _bm25_indices[col_name]
    except Exception as exc:
        log.warning("Failed to build BM25 index for '%s': %s", col_name, exc)
        return None


def _add_to_bm25(
    col_name: str, chunk_ids: list[str], chunk_docs: list[str], chunk_metas: list[dict]
) -> None:
    """Add newly-indexed chunks to the BM25 corpus (docs, ids, metadata)."""
    if not _BM25_AVAILABLE or not chunk_docs:
        return

    _bm25_corpora[col_name].extend(chunk_docs)
    _bm25_id_maps[col_name].extend(chunk_ids)
    _bm25_metas[col_name].extend(chunk_metas)

    # Rebuild the BM25 index for this collection
    tokenized = [_tokenize(d) for d in _bm25_corpora[col_name]]
    if tokenized:
        assert BM25Okapi is not None  # guaranteed by the _BM25_AVAILABLE guard above
        _bm25_indices[col_name] = BM25Okapi(tokenized)
    else:
        _bm25_indices[col_name] = None


def _mark_bm25_dirty(col_name: str) -> None:
    """Invalidate a collection's BM25 corpus (chunks were deleted/replaced)."""
    with _bm25_lock:
        _bm25_dirty.add(col_name)


def _ensure_bm25_fresh(col_name: str) -> None:
    """Rebuild a collection's BM25 corpus from ChromaDB when it is missing or
    stale.  ChromaDB is the single source of truth."""
    with _bm25_lock:
        needs_build = col_name in _bm25_dirty or col_name not in _bm25_indices
        if not needs_build:
            return
    _build_bm25_index(col_name)
    with _bm25_lock:
        _bm25_dirty.discard(col_name)


def _clear_bm25(col_name: str) -> None:
    """Drop all in-memory BM25 state for a collection (deleted/cleared)."""
    with _bm25_lock:
        _bm25_dirty.discard(col_name)
        _bm25_indices.pop(col_name, None)
        _bm25_corpora.pop(col_name, None)
        _bm25_id_maps.pop(col_name, None)
        _bm25_metas.pop(col_name, None)


def _evict_oldest_chunks(collection, count: int) -> int:
    """Delete the `count` chunks with the oldest `indexed_at` metadata.

    ChromaDB has no ORDER BY, so fetch ids+metadatas once and sort client-side —
    eviction must follow indexing time, not an assumed insertion order.
    """
    if count <= 0:
        return 0
    try:
        data = collection.get(include=["metadatas"])
        ids = data.get("ids") or []
        metas = data.get("metadatas") or []
        if not ids:
            return 0
        ranked = sorted(
            zip(ids, metas),
            key=lambda pair: (pair[1] or {}).get("indexed_at", 0.0),
        )
        targets = [cid for cid, _ in ranked[:count]]
        if targets:
            collection.delete(ids=targets)
        return len(targets)
    except Exception as exc:
        log.warning("Eviction failed: %s", exc)
        return 0


def _bm25_search(
    query: str, col_name: str, k: int
) -> list[tuple[str, str, dict, float]]:
    """Keyword search via BM25. Returns [(id, content, metadata, score), ...]."""
    if not _BM25_AVAILABLE:
        return []

    # Rebuild from ChromaDB if the corpus was invalidated by deletes/eviction.
    _ensure_bm25_fresh(col_name)

    index = _bm25_indices.get(col_name)
    if index is None:
        return []

    tokenized_query = _tokenize(query)
    scores = index.get_scores(tokenized_query)
    corpus = _bm25_corpora.get(col_name, [])
    id_map = _bm25_id_maps.get(col_name, [])
    meta_map = _bm25_metas.get(col_name, [])

    # Pair (idx, score), sort by score descending, take top k
    ranked = sorted(enumerate(scores), key=lambda x: x[1], reverse=True)
    results = []
    for idx, score in ranked[:k]:
        if score <= 0:
            continue
        base_meta = dict(meta_map[idx]) if idx < len(meta_map) and meta_map[idx] else {}
        base_meta.setdefault("source", f"bm25:{col_name}")
        base_meta["retrieval"] = "bm25"
        results.append(
            (
                id_map[idx] if idx < len(id_map) else f"bm25_{col_name}_{idx}",
                corpus[idx] if idx < len(corpus) else "",
                base_meta,
                min(score / max(scores) if max(scores) > 0 else 0.0, 1.0),
            )
        )
    return results


def _reciprocal_rank_fusion(
    results_a: list[tuple[str, str, dict, float]],
    results_b: list[tuple[str, str, dict, float]],
    k_rrf: int = RRF_K,
) -> dict[str, tuple[str, str, dict, float]]:
    """Merge two ranked result lists via reciprocal rank fusion.

    Returns a dict keyed by id, with the best (content, metadata) from either list
    and an RRF score. The score is not a traditional similarity — it's a fusion rank.
    """
    fused: dict[str, tuple[str, str, dict, float]] = {}

    # Score from list A (BM25 or dense)
    for rank, (rid, content, meta, _score) in enumerate(results_a):
        rrf = 1.0 / (k_rrf + rank + 1)
        fused[rid] = (rid, content, meta, rrf)

    # Score from list B (the other)
    for rank, (rid, content, meta, _score) in enumerate(results_b):
        rrf = 1.0 / (k_rrf + rank + 1)
        if rid in fused:
            _, existing_content, existing_meta, existing_rrf = fused[rid]
            # Use the content/metadata from the higher-confidence source (dense = cosine)
            # and sum the RRF scores
            fused[rid] = (
                rid,
                content or existing_content,
                meta or existing_meta,
                existing_rrf + rrf,
            )
        else:
            fused[rid] = (rid, content, meta, rrf)

    return fused


# ---------------------------------------------------------------------------
# Phase 3: Cross-Encoder Reranking
# ---------------------------------------------------------------------------


def _parse_rerank_scores(answer: str, expected: int) -> Optional[list[float]]:
    """Parse the reranker's JSON reply into `expected` scores.

    Accepts {"scores": [...]} or a bare JSON array, possibly wrapped in prose.
    Returns None when unparseable or the wrong length (callers then keep the
    original dense/BM25 scores for that batch).
    """
    if not answer:
        return None
    text = str(answer).strip()
    data = None
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        match = re.search(r"\{.*\}|\[.*\]", text, re.DOTALL)
        if match:
            try:
                data = json.loads(match.group(0))
            except (ValueError, TypeError):
                data = None
    if isinstance(data, dict):
        data = data.get("scores")
    if not isinstance(data, list) or len(data) != expected:
        return None
    try:
        return [max(0.0, min(1.0, float(v))) for v in data]
    except (ValueError, TypeError):
        return None


def _rerank_results(
    query: str,
    candidates: list[tuple[str, str, dict, float]],
    model: str = DEFAULT_RERANK_MODEL,
    ollama_url: str = "http://localhost:11434",
) -> tuple[list[tuple[str, str, dict, float]], bool]:
    """Rerank candidate chunks with a batched scoring call per 10 candidates.

    Returns (results, applied).  `applied` is False when the model is not
    available or scoring failed entirely — the caller must not claim reranking
    happened.  Unparseable batch replies keep the original dense/BM25 scores.
    """
    if not candidates:
        return [], False

    client = ollama.Client(host=ollama_url, timeout=OLLAMA_CHAT_TIMEOUT)

    # Check if reranker model is available
    try:
        model_names = _ollama_model_names(client.list())
        if not any(model == mn or mn.startswith(f"{model}:") for mn in model_names):
            log.warning(
                "Reranker model '%s' not available — returning un-reranked results",
                model,
            )
            return candidates, False
    except Exception:
        log.warning("Could not list models for reranker check — proceeding anyway")

    reranked: list[tuple[str, str, dict, float]] = []

    for i in range(0, len(candidates), RERANK_BATCH_SIZE):
        batch = candidates[i : i + RERANK_BATCH_SIZE]
        docs_text = "\n\n".join(
            f"[{j}] {content[:1200]}"
            for j, (_rid, content, _m, _s) in enumerate(batch)
            if content
        )
        prompt = RERANK_BATCH_PROMPT_TEMPLATE.format(query=query, documents=docs_text)
        scores: Optional[list[float]] = None
        try:
            resp = client.chat(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                format="json",
                options={"temperature": 0.0, "num_predict": 32 + 12 * len(batch)},
                keep_alive="10m",
            )
            answer = (resp.get("message", {}).get("content", "") or "").strip()
            scores = _parse_rerank_scores(answer, len(batch))
        except Exception as exc:
            log.warning(
                "Reranker call failed for batch %d: %s", i // RERANK_BATCH_SIZE, exc
            )
        if scores is None:
            # Unparseable reply — keep the original scores for this batch so a
            # chatty model can't corrupt the result set.
            log.warning(
                "Reranker returned no parsable scores for batch %d — keeping original scores",
                i // RERANK_BATCH_SIZE,
            )
            reranked.extend(batch)
        else:
            for (rid, content, meta, _score), score in zip(batch, scores):
                reranked.append((rid, content, meta, score))

    # Sort by reranker score descending
    reranked.sort(key=lambda x: x[3], reverse=True)
    return reranked, True


# Pydantic models
# ---------------------------------------------------------------------------


class IndexText(BaseModel):
    id: str
    content: str
    metadata: dict = Field(default_factory=dict)


class IndexRequest(BaseModel):
    texts: list[IndexText]
    collection: str = "documents"
    chunk_size: Optional[int] = None
    chunk_overlap: Optional[int] = None
    embedding_model: Optional[str] = None
    ollama_url: str = "http://localhost:11434"
    max_chunks_per_collection: int = DEFAULT_MAX_CHUNKS_PER_COLLECTION
    max_total_size_mb: int = DEFAULT_MAX_TOTAL_SIZE_MB
    auto_prune: bool = True
    replace_ids: Optional[list[str]] = None


class IndexResponse(BaseModel):
    indexed: int
    chunks: int
    model: str
    rejected: int = 0
    reason: str = ""


class SearchRequest(BaseModel):
    query: str
    collection: Optional[str] = None  # None = search all
    k: int = 5
    embedding_model: Optional[str] = None
    ollama_url: str = "http://localhost:11434"
    # Phase 3: advanced retrieval
    rerank: bool = False
    rerank_model: str = DEFAULT_RERANK_MODEL
    rerank_k: int = 20  # how many candidates to fetch before reranking
    hybrid: bool = False


class SearchResult(BaseModel):
    id: str
    content: str
    metadata: dict
    score: float


class SearchResponse(BaseModel):
    results: list[SearchResult]
    query: str
    model: str
    # Distance space the scores follow — "cosine" means `score` is a true
    # cosine similarity in [0, 1].  Clients use this to calibrate thresholds.
    score_space: str = "cosine"
    # Retrieval modes the service ACTUALLY applied (e.g. "dense+bm25"), so
    # clients don't have to guess from request flags.
    mode: str = ""


class HealthResponse(BaseModel):
    ok: bool
    version: str
    collections: dict[str, int]
    embedding: dict = Field(default_factory=dict)
    limits: dict = Field(
        default_factory=lambda: {
            "max_chunks_per_collection": DEFAULT_MAX_CHUNKS_PER_COLLECTION,
            "max_total_size_mb": DEFAULT_MAX_TOTAL_SIZE_MB,
            "estimated_size_mb": 0.0,
            "total_chunks": 0,
        }
    )


# ---------------------------------------------------------------------------
# ChromaDB client (lazy init)
# ---------------------------------------------------------------------------

_chroma_client: Optional[ClientAPI] = None


def get_chroma() -> ClientAPI:
    global _chroma_client
    if _chroma_client is None:
        os.makedirs(CHROMADB_PATH, exist_ok=True)
        _chroma_client = chromadb.PersistentClient(path=CHROMADB_PATH)
        log.info("ChromaDB initialized at %s", CHROMADB_PATH)
    return _chroma_client


# ---------------------------------------------------------------------------
# Collection helpers + cosine migration
# ---------------------------------------------------------------------------


def _get_or_create_collection(client: ClientAPI, name: str):
    """Fetch a collection, creating it in the cosine space when missing."""
    try:
        return client.get_collection(name=name)
    except Exception:
        return client.create_collection(
            name=name,
            metadata={
                "hnsw:space": EMBEDDING_SPACE,
                MIGRATION_META_KEY: EMBEDDING_SPACE,
            },
        )


def _collection_space(col) -> str:
    """Best-effort read of a collection's HNSW distance space ('cosine'/'l2')."""
    try:
        cfg = col.configuration
        if isinstance(cfg, dict):
            hnsw = cfg.get("hnsw") or {}
            if isinstance(hnsw, dict) and hnsw.get("space"):
                return str(hnsw["space"])
        else:
            hnsw = getattr(cfg, "hnsw", None)
            space = getattr(hnsw, "space", None)
            if space:
                return str(space)
    except Exception:
        pass
    try:
        meta = col.metadata or {}
        if meta.get(MIGRATION_META_KEY) == EMBEDDING_SPACE:
            return EMBEDDING_SPACE
        if meta.get("hnsw:space") == EMBEDDING_SPACE:
            return EMBEDDING_SPACE
    except Exception:
        pass
    return "unknown"


def _recover_interrupted_migrations(client: ClientAPI) -> None:
    """Repair a migration that crashed between its rename steps.

    Migration renames:  X → X__l2old, X__cos → X, then deletes X__l2old.
    A crash can leave: (a) both X and X__l2old (old copy leftover) → drop the
    old copy; (b) only X__l2old → restore it; (c) only X__cos → restore the
    original if it still exists, otherwise promote the copy.
    """
    names = set(_collection_names(client))
    for name in sorted(names):
        if name.endswith("__l2old"):
            base = name[: -len("__l2old")]
            if base in names:
                # Base collection is live — the L2 copy is redundant.  It may
                # already be gone if an earlier recovery step consumed it.
                try:
                    client.delete_collection(name)
                    log.info("Migration recovery: removed leftover L2 copy '%s'", name)
                except Exception:
                    pass
            else:
                try:
                    client.get_collection(name).modify(name=base)
                    names.add(base)
                    names.discard(name)
                    log.info(
                        "Migration recovery: restored collection '%s' from '%s'",
                        base,
                        name,
                    )
                except Exception as exc:
                    log.warning("Migration recovery failed for '%s': %s", name, exc)
        elif name.endswith("__cos"):
            base = name[: -len("__cos")]
            if base in names:
                try:
                    client.delete_collection(name)
                    log.info("Migration recovery: removed stale cosine copy '%s'", name)
                except Exception as exc:
                    log.warning("Migration recovery failed for '%s': %s", name, exc)
            elif f"{base}__l2old" in names:
                try:
                    client.get_collection(f"{base}__l2old").modify(name=base)
                    names.add(base)
                    client.delete_collection(name)
                    log.info(
                        "Migration recovery: restored '%s' and dropped incomplete copy",
                        base,
                    )
                except Exception as exc:
                    log.warning("Migration recovery failed for '%s': %s", name, exc)
            else:
                try:
                    client.get_collection(name).modify(name=base)
                    names.add(base)
                    names.discard(name)
                    log.info("Migration recovery: promoted cosine copy to '%s'", base)
                except Exception as exc:
                    log.warning("Migration recovery failed for '%s': %s", name, exc)


def migrate_collections_to_cosine(client: ClientAPI) -> None:
    """One-off migration of L2 collections to cosine space.

    Stored embeddings are copied verbatim — cosine distance is scale-invariant,
    so no re-embedding is needed.  The original collection is only deleted
    after the copied collection's count is verified.
    """
    for name in _collection_names(client):
        if name.endswith("__cos") or name.endswith("__l2old"):
            continue
        try:
            col = client.get_collection(name=name)
            space = _collection_space(col)
            if space == EMBEDDING_SPACE:
                continue
            count = col.count()
            if count == 0:
                client.delete_collection(name)
                client.create_collection(
                    name=name,
                    metadata={
                        "hnsw:space": EMBEDDING_SPACE,
                        MIGRATION_META_KEY: EMBEDDING_SPACE,
                    },
                )
                log.info("Migrated empty collection '%s' to cosine space", name)
                continue

            log.info(
                "Migrating collection '%s' to cosine space (%d chunks, space=%s)…",
                name,
                count,
                space,
            )
            data = col.get(include=["documents", "metadatas", "embeddings"])
            ids = data.get("ids") or []
            docs = data.get("documents") or []
            metas = data.get("metadatas") or []
            embs = data.get("embeddings")
            if hasattr(embs, "tolist"):
                embs = embs.tolist()

            tmp_name = f"{name}__cos"
            try:
                client.delete_collection(tmp_name)
            except Exception:
                pass
            tmp = client.create_collection(
                name=tmp_name,
                metadata={
                    "hnsw:space": EMBEDDING_SPACE,
                    MIGRATION_META_KEY: EMBEDDING_SPACE,
                },
            )
            for i in range(0, len(ids), MIGRATION_BATCH_SIZE):
                tmp.add(
                    ids=ids[i : i + MIGRATION_BATCH_SIZE],
                    documents=docs[i : i + MIGRATION_BATCH_SIZE] if docs else None,
                    metadatas=metas[i : i + MIGRATION_BATCH_SIZE] if metas else None,
                    embeddings=(
                        embs[i : i + MIGRATION_BATCH_SIZE] if embs is not None else None
                    ),
                )
            copied = tmp.count()
            if copied != count:
                raise RuntimeError(
                    f"copy verification failed: expected {count}, got {copied}"
                )

            col.modify(name=f"{name}__l2old")
            tmp.modify(name=name)
            client.delete_collection(f"{name}__l2old")
            log.info("Migrated '%s' to cosine space (%d chunks copied)", name, copied)
        except Exception as exc:
            log.warning("Cosine migration failed for '%s': %s", name, exc)
            # If the original was already renamed, restore it so nothing is lost.
            try:
                names = set(_collection_names(client))
                if name not in names and f"{name}__l2old" in names:
                    client.get_collection(f"{name}__l2old").modify(name=name)
                    log.info(
                        "Restored original collection '%s' after failed migration", name
                    )
            except Exception as restore_exc:
                log.error(
                    "Could not restore '%s' after failed migration: %s",
                    name,
                    restore_exc,
                )


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup: ensure ChromaDB path exists, pull embedding model, rebuild BM25 indices."""
    log.info("Katabai RAG service starting on %s:%d", SERVER_HOST, SERVER_PORT)
    os.makedirs(CHROMADB_PATH, exist_ok=True)

    # Attempt to ensure the embedding model is available
    try:
        ensure_embedding_model(DEFAULT_EMBEDDING_MODEL)
    except Exception as exc:
        log.warning("Embedding model not available at startup: %s", exc)

    # Migrate any L2 collections to cosine space (client relevance thresholds
    # assume true cosine similarity).  Embeddings are copied verbatim.
    try:
        client = get_chroma()
        _recover_interrupted_migrations(client)
        migrate_collections_to_cosine(client)
    except Exception as exc:
        log.warning("Collection migration failed: %s", exc)

    # Phase 3: rebuild BM25 indices from existing ChromaDB collections
    if _BM25_AVAILABLE:
        try:
            client = get_chroma()
            col_names = _collection_names(client)
            rebuilt = 0
            for name in col_names:
                idx = _build_bm25_index(name)
                if idx is not None:
                    rebuilt += 1
            log.info("BM25 indices rebuilt for %d collection(s)", rebuilt)
        except Exception as exc:
            log.warning("BM25 rebuild failed at startup: %s", exc)

    # Warm up the embedding model in the background so the first /search isn't
    # a cold model load (the dominant latency source on this hardware).
    # Non-fatal: Ollama may be down or remote.
    threading.Thread(
        target=_warm_embedding_model, args=(DEFAULT_EMBEDDING_MODEL,), daemon=True
    ).start()

    yield

    log.info("Katabai RAG service shutting down")


app = FastAPI(
    title="Katabai Local RAG",
    version="1.3.0",
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# POST /index
# ---------------------------------------------------------------------------


@app.post("/index", response_model=IndexResponse)
def index_texts(req: IndexRequest):
    """Chunk, embed, and store texts into a ChromaDB collection.

    Enforces per-collection and total-storage caps to prevent unbounded
    growth.  When auto_prune is enabled and a collection is at capacity,
    the oldest chunks are evicted to make room.
    """
    # ── Input-size guardrails ────────────────────────────────────────────
    if len(req.texts) > MAX_TEXTS_PER_INDEX_REQUEST:
        raise HTTPException(
            status_code=413,
            detail=f"Too many texts in one request ({len(req.texts)}). "
            f"Maximum is {MAX_TEXTS_PER_INDEX_REQUEST}.",
        )

    oversized = [t.id for t in req.texts if len(t.content) > MAX_CHARS_PER_INDEX_TEXT]
    if oversized:
        raise HTTPException(
            status_code=413,
            detail=f"Text(s) exceed the {MAX_CHARS_PER_INDEX_TEXT:,}-character "
            f"per-document limit: {', '.join(oversized[:5])}",
        )

    chunk_size = req.chunk_size or DEFAULT_CHUNK_SIZE
    chunk_overlap = req.chunk_overlap or DEFAULT_CHUNK_OVERLAP
    model = req.embedding_model or DEFAULT_EMBEDDING_MODEL
    max_chunks = req.max_chunks_per_collection
    max_mb = req.max_total_size_mb

    t0 = time.monotonic()

    # Chunk all texts
    all_chunks: list[dict] = []  # {id, content, metadata}
    for text in req.texts:
        chunks = chunk_text(text.content, chunk_size, chunk_overlap)
        for ci, chunk in enumerate(chunks):
            chunk_id = f"{text.id}_chunk{ci}" if len(chunks) > 1 else text.id
            all_chunks.append(
                {
                    "id": chunk_id,
                    "content": chunk,
                    "metadata": {
                        **text.metadata,
                        "source_id": text.id,
                        "indexed_at": time.time(),
                    },
                }
            )

    if not all_chunks:
        return IndexResponse(indexed=len(req.texts), chunks=0, model=model)

    # ── Collection cap check ─────────────────────────────────────────────
    client = get_chroma()
    collection = client.get_or_create_collection(name=req.collection)

    # ── Replace old chunks (for re-indexing) ──────────────────────────────
    if req.replace_ids:
        old_deleted = 0
        prefixes = [str(p) for p in req.replace_ids if p]
        to_delete: list[str] = []
        filter_ok = False
        if prefixes:
            try:
                # Fast path: every chunk stores its parent document id in
                # metadata.source_id, so ONE filtered lookup finds all old
                # chunks without scanning the whole collection — this runs on
                # every delta conversation index request.
                found = collection.get(
                    where={"source_id": {"$in": prefixes}}, include=[]
                )
                to_delete = list(found.get("ids") or [])
                filter_ok = True
            except Exception as exc:
                log.warning(
                    "replace_ids metadata filter failed — falling back to full scan: %s",
                    exc,
                )
        if prefixes and not filter_ok:
            # Fallback (legacy rows without source_id): full scan + prefix match
            # on chunk ids (`id`, `id_chunk0`) and source_id (`id#part-0`).
            try:
                existing = collection.get(include=["metadatas"])
                all_ids = existing.get("ids") or []
                all_metas = existing.get("metadatas") or []
                for i, cid in enumerate(all_ids):
                    source_id = ""
                    if i < len(all_metas) and all_metas[i]:
                        source_id = str(all_metas[i].get("source_id") or "")
                    for prefix in prefixes:
                        if (
                            cid == prefix
                            or cid.startswith(prefix + "_")
                            or cid.startswith(prefix + "#")
                            or source_id == prefix
                            or source_id.startswith(prefix + "#")
                        ):
                            to_delete.append(cid)
                            break
            except Exception as exc:
                log.warning(
                    "Replace fallback scan failed for %s: %s", req.replace_ids[:3], exc
                )
        try:
            if to_delete:
                collection.delete(ids=to_delete)
                old_deleted = len(to_delete)
        except Exception as exc:
            log.warning("Replace delete failed for %s: %s", req.replace_ids[:3], exc)
        if old_deleted > 0:
            _mark_bm25_dirty(req.collection)
            log.info("Replaced %d old chunk(s) before indexing", old_deleted)

    current_count = collection.count()
    rejected = 0
    reason = ""

    if max_chunks > 0 and current_count >= max_chunks:
        if req.auto_prune:
            # LRU-style eviction: remove the oldest chunks to make room
            overflow = current_count + len(all_chunks) - max_chunks
            if overflow > 0:
                evict_count = min(overflow, current_count)
                log.info(
                    "Collection '%s' at cap (%d/%d chunks) — evicting %d oldest",
                    req.collection,
                    current_count,
                    max_chunks,
                    evict_count,
                )
                evicted = _evict_oldest_chunks(collection, evict_count)
                if evicted > 0:
                    _mark_bm25_dirty(req.collection)
                    log.info("Evicted %d chunks from '%s'", evicted, req.collection)
        else:
            # Hard reject when auto-prune is off and the collection is full.
            # `indexed` stays 0 so clients can't mistake this for success.
            rejected = len(all_chunks)
            reason = (
                f"Collection '{req.collection}' is at its cap of {max_chunks} chunks "
                f"and auto-pruning is disabled. Clear some space or enable auto-prune."
            )
            log.warning("Rejected %d chunks — %s", rejected, reason)
            return IndexResponse(
                indexed=0,
                chunks=0,
                model=model,
                rejected=rejected,
                reason=reason,
            )

    # ── Total storage cap check ───────────────────────────────────────────
    if max_mb > 0:
        est_mb = estimate_storage_size_mb()
        if est_mb >= max_mb:
            if req.auto_prune:
                log.info(
                    "Total storage at %.1f MB (cap %d MB) — attempting eviction",
                    est_mb,
                    max_mb,
                )
                # Evict ~20% of the oldest chunks across all collections
                for cname in _collection_names(client):
                    try:
                        col = client.get_collection(name=cname)
                        to_evict = max(1, int(col.count() * 0.2))
                        evicted = _evict_oldest_chunks(col, to_evict)
                        if evicted > 0:
                            _mark_bm25_dirty(cname)
                            log.info(
                                "Storage eviction: removed %d from '%s'",
                                evicted,
                                cname,
                            )
                    except Exception as exc:
                        log.warning("Storage eviction failed for '%s': %s", cname, exc)
            else:
                rejected = len(all_chunks)
                reason = (
                    f"Total storage estimated at {est_mb:.0f} MB exceeds the "
                    f"{max_mb} MB cap and auto-pruning is disabled. "
                    "Clear some space or enable auto-prune."
                )
                log.warning("Rejected %d chunks — %s", rejected, reason)
                return IndexResponse(
                    indexed=0,
                    chunks=0,
                    model=model,
                    rejected=rejected,
                    reason=reason,
                )

    # Generate embeddings (structured 503 when the embedding backend is down)
    chunk_texts = [c["content"] for c in all_chunks]
    t_embed = time.monotonic()
    try:
        embeddings = generate_embeddings(chunk_texts, model, ollama_url=req.ollama_url)
    except Exception as exc:
        log.warning("Index embedding failed: %s", exc)
        raise HTTPException(
            status_code=503,
            detail=f"Embedding backend unavailable: {exc}",
        )
    embed_s = time.monotonic() - t_embed

    # Store in ChromaDB
    collection.add(
        ids=[c["id"] for c in all_chunks],
        documents=chunk_texts,
        metadatas=[c["metadata"] for c in all_chunks],
        embeddings=embeddings,  # type: ignore[reportArgumentType]
    )

    # Phase 3: also add to BM25 index (with per-chunk metadata)
    _add_to_bm25(
        req.collection,
        [c["id"] for c in all_chunks],
        chunk_texts,
        [c["metadata"] for c in all_chunks],
    )

    elapsed = time.monotonic() - t0
    log.info(
        "Indexed %d documents → %d chunks into '%s' in %.2fs (embed %.2fs, model=%s)",
        len(req.texts),
        len(all_chunks),
        req.collection,
        elapsed,
        embed_s,
        model,
    )

    return IndexResponse(indexed=len(req.texts), chunks=len(all_chunks), model=model)


# ---------------------------------------------------------------------------
# POST /search
# ---------------------------------------------------------------------------


@app.post("/search", response_model=SearchResponse)
def search_texts(req: SearchRequest):
    """Embed a query and perform semantic search with optional BM25 hybrid and reranking."""
    model = req.embedding_model or DEFAULT_EMBEDDING_MODEL
    k = max(1, min(req.k, 50))
    collections_to_search: list[str] = []

    if req.collection:
        collections_to_search = [req.collection]
    else:
        client = get_chroma()
        collections_to_search = _collection_names(client)

    if not collections_to_search:
        return SearchResponse(results=[], query=req.query, model=model)

    t0 = time.monotonic()
    mode_parts = ["dense"]
    stage_s = {"embed": 0.0, "dense": 0.0, "bm25": 0.0, "rerank": 0.0}

    # ── Determine fetch sizes ──────────────────────────────────────────
    if req.hybrid:
        dense_k = k * 2  # fetch more for fusion
        bm25_k = k * 2
    elif req.rerank:
        dense_k = max(k, min(req.rerank_k, 50))
        bm25_k = 0
    else:
        dense_k = k
        bm25_k = 0

    # ── Dense retrieval (always) ───────────────────────────────────────
    t_embed = time.monotonic()
    try:
        embeddings = generate_embeddings([req.query], model, ollama_url=req.ollama_url)
    except Exception as exc:
        log.warning("Search embedding failed: %s", exc)
        raise HTTPException(
            status_code=503,
            detail=f"Embedding backend unavailable: {exc}",
        )
    query_embedding = embeddings[0]
    stage_s["embed"] = time.monotonic() - t_embed

    client = get_chroma()
    dense_results: list[tuple[str, str, dict, float]] = (
        []
    )  # (id, content, metadata, score)

    for col_name in collections_to_search:
        try:
            col = client.get_collection(name=col_name)
            result = col.query(
                query_embeddings=[query_embedding],
                n_results=dense_k,
                include=["documents", "metadatas", "distances"],
            )

            ids = (result.get("ids") or [[]])[0]
            docs = (result.get("documents") or [[]])[0]
            metas = (result.get("metadatas") or [[]])[0]
            distances = (result.get("distances") or [[]])[0]

            for i in range(len(ids)):
                score = (
                    1.0 - float(distances[i])
                    if distances and i < len(distances)
                    else 0.0
                )
                raw_meta = metas[i] if metas and i < len(metas) else None
                meta = dict(raw_meta) if raw_meta else {}
                meta["retrieval"] = "dense"
                dense_results.append(
                    (
                        ids[i],
                        docs[i] if docs and i < len(docs) else "",
                        meta,
                        score,
                    )
                )
        except Exception as exc:
            log.warning("Error querying collection '%s': %s", col_name, exc)
            continue

    stage_s["dense"] = time.monotonic() - t_embed - stage_s["embed"]

    # Per-id similarity scores (0–1) so hybrid fusion can still report a
    # comparable score to the client instead of the tiny RRF rank value.
    dense_scores: dict[str, float] = {
        rid: min(1.0, max(0.0, score)) for rid, _c, _m, score in dense_results
    }
    # BM25 scores are only populated on the hybrid path; initialize here so
    # the fusion fallback below never reads an unbound name.
    bm25_scores: dict[str, float] = {}

    # ── BM25 retrieval (if hybrid) ─────────────────────────────────────
    all_results: list[tuple[str, str, dict, float]] = []
    t_bm25 = time.monotonic()

    if req.hybrid and bm25_k > 0:
        mode_parts.append("bm25")

        # BM25 indices are built/refreshed lazily by _bm25_search (it rebuilds
        # any collection whose corpus was invalidated by deletes/eviction).
        bm25_results: list[tuple[str, str, dict, float]] = []
        for col_name in collections_to_search:
            bm25_results.extend(_bm25_search(req.query, col_name, bm25_k))

        bm25_scores = {
            rid: min(1.0, max(0.0, score)) for rid, _c, _m, score in bm25_results
        }

        # Reciprocal rank fusion
        fused = _reciprocal_rank_fusion(bm25_results, dense_results)
        all_results = list(fused.values())
        log.info(
            "Hybrid search '%s': %d BM25 + %d dense → %d fused",
            req.query[:80],
            len(bm25_results),
            len(dense_results),
            len(all_results),
        )
    else:
        all_results = dense_results

    stage_s["bm25"] = time.monotonic() - t_bm25

    # Sort by score, take top candidates
    all_results.sort(key=lambda r: r[3], reverse=True)

    # ── Reranking (if enabled) ─────────────────────────────────────────
    reranked = False
    t_rerank = time.monotonic()
    if req.rerank:
        rerank_k = max(k, min(req.rerank_k, 50))
        candidates_for_rerank = all_results[:rerank_k]

        if len(candidates_for_rerank) >= k:
            all_results, applied = _rerank_results(
                req.query,
                candidates_for_rerank,
                model=req.rerank_model,
                ollama_url=req.ollama_url,
            )
            reranked = applied
            if applied:
                mode_parts.append("reranked")
            log.info(
                "Reranking '%s': %d candidates → %d scored (applied=%s)",
                req.query[:80],
                len(candidates_for_rerank),
                len(all_results),
                applied,
            )
        else:
            log.info(
                "Reranking skipped for '%s': only %d candidates (need ≥%d)",
                req.query[:80],
                len(candidates_for_rerank),
                k,
            )

    stage_s["rerank"] = time.monotonic() - t_rerank

    # Take top k
    final = all_results[:k]

    # When hybrid fusion produced RRF rank scores (tiny, ~0.016–0.05), replace
    # them with a comparable 0–1 similarity (dense cosine, falling back to the
    # normalized BM25 score) so client-side coverage/confidence thresholds and
    # the UI percentage remain meaningful.  Reranked results already carry 0–1
    # cross-encoder scores, so leave those untouched.
    if req.hybrid and not reranked:
        final = [
            (
                rid,
                content,
                meta,
                min(1.0, max(0.0, dense_scores.get(rid, bm25_scores.get(rid, 0.0)))),
            )
            for rid, content, meta, _rrf in final
        ]

    # Convert to SearchResult objects (scores clamped to [0, 1])
    results = [
        SearchResult(
            id=rid,
            content=content,
            metadata=meta,
            score=round(min(1.0, max(0.0, score)), 4),
        )
        for rid, content, meta, score in final
    ]

    elapsed = time.monotonic() - t0
    mode_str = "+".join(mode_parts)
    log.info(
        "Search '%s' → %d results (%s) across %d collections in %.2fs "
        "(embed %.2f + dense %.2f + bm25 %.2f + rerank %.2f, model=%s)",
        req.query[:80],
        len(results),
        mode_str,
        len(collections_to_search),
        elapsed,
        stage_s["embed"],
        stage_s["dense"],
        stage_s["bm25"],
        stage_s["rerank"],
        model,
    )

    return SearchResponse(
        results=results,
        query=req.query,
        model=model,
        score_space=EMBEDDING_SPACE,
        mode=mode_str,
    )


# ---------------------------------------------------------------------------
# GET /health
# ---------------------------------------------------------------------------


@app.get("/health", response_model=HealthResponse)
def health_check(
    ollama_url: str = "http://localhost:11434",
    embedding_model: str = DEFAULT_EMBEDDING_MODEL,
):
    """Return service health, collection stats, storage limits, and feature availability.

    Probes the Ollama embedding backend so clients can distinguish "RAG service
    down" from "embeddings unavailable" without waiting for a search timeout.
    """
    try:
        client = get_chroma()
        col_names = _collection_names(client)

        collections = {}
        total_chunks = 0
        for name in col_names:
            try:
                col = client.get_collection(name=name)
                collections[name] = col.count()
                total_chunks += col.count()
            except Exception:
                collections[name] = -1

        est_mb = estimate_storage_size_mb()

        # Embedding backend probe (same URL/model that /search and /index use).
        # One model-list fetch is shared between the embedding and reranker
        # probes — halves the health latency when Ollama is unreachable.
        embedding_status: dict = {
            "ok": False,
            "model": embedding_model,
            "url": ollama_url,
            "error": "",
        }
        model_names: list = []
        try:
            ollama_client = ollama.Client(host=ollama_url, timeout=OLLAMA_PROBE_TIMEOUT)
            model_names = _ollama_model_names(ollama_client.list())
        except Exception as exc:
            embedding_status["error"] = f"Ollama unreachable at {ollama_url}: {exc}"

        if not embedding_status["error"]:
            found = any(
                embedding_model == mn or mn.startswith(f"{embedding_model}:")
                for mn in model_names
            )
            if found:
                embedding_status["ok"] = True
            else:
                embedding_status["error"] = (
                    f"model '{embedding_model}' not found on {ollama_url}"
                )

        # Reranker availability uses the same model list against the configured
        # Ollama host (not hard-coded localhost — it may be a remote AI PC).
        reranker_available = any(
            DEFAULT_RERANK_MODEL == mn or mn.startswith(f"{DEFAULT_RERANK_MODEL}:")
            for mn in model_names
        )

        return HealthResponse(
            ok=True,
            version="1.3.0",
            collections=collections,
            embedding=embedding_status,
            limits={
                "max_chunks_per_collection": DEFAULT_MAX_CHUNKS_PER_COLLECTION,
                "max_total_size_mb": DEFAULT_MAX_TOTAL_SIZE_MB,
                "estimated_size_mb": round(est_mb, 2),
                "total_chunks": total_chunks,
                # Phase 3
                "reranker_available": reranker_available,
                "bm25_available": _BM25_AVAILABLE,
                "bm25_collections": sum(
                    1 for idx in _bm25_indices.values() if idx is not None
                ),
                "score_space": EMBEDDING_SPACE,
            },
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# DELETE /collection/{name}
# ---------------------------------------------------------------------------


@app.delete("/collection/{name}")
def delete_collection(name: str):
    """Delete a named ChromaDB collection."""
    try:
        client = get_chroma()
        client.delete_collection(name=name)
        _clear_bm25(name)
        log.info("Deleted collection '%s'", name)
        return {"ok": True, "collection": name}
    except Exception as exc:
        log.warning("Failed to delete collection '%s': %s", name, exc)
        raise HTTPException(status_code=404, detail=str(exc))


# ---------------------------------------------------------------------------
# POST /delete – delete chunks by id, id prefix, or source_id
# ---------------------------------------------------------------------------


class DeleteRequest(BaseModel):
    collection: Optional[str] = None  # None = all collections
    ids: Optional[list[str]] = None  # exact chunk ids
    prefixes: Optional[list[str]] = None  # id/source_id prefixes (e.g. conv id)
    source_ids: Optional[list[str]] = None  # metadata.source_id values


@app.post("/delete")
def delete_chunks(req: DeleteRequest):
    """Delete chunks by exact id, id prefix, or source_id.

    Used to purge a conversation's memory when the user deletes it from the
    history, and by client maintenance flows.  Affected collections have their
    BM25 corpus invalidated (rebuilt lazily on the next hybrid search).
    """
    client = get_chroma()
    targets = [req.collection] if req.collection else _collection_names(client)
    ids = [str(i) for i in (req.ids or []) if i]
    prefixes = [str(p) for p in (req.prefixes or []) if p]
    source_ids = [str(s) for s in (req.source_ids or []) if s]

    if not ids and not prefixes and not source_ids:
        raise HTTPException(
            status_code=400, detail="No ids, prefixes, or source_ids provided."
        )

    deleted = 0
    for name in targets:
        try:
            col = client.get_collection(name=name)
        except Exception:
            continue
        try:
            to_delete: set[str] = set()
            if ids:
                found = col.get(ids=ids, include=[])
                to_delete.update(found.get("ids") or [])
            if source_ids:
                try:
                    found = col.get(
                        where={"source_id": {"$in": source_ids}}, include=[]
                    )
                    to_delete.update(found.get("ids") or [])
                except Exception:
                    pass
            if prefixes:
                existing = col.get(include=["metadatas"])
                all_ids = existing.get("ids") or []
                all_metas = existing.get("metadatas") or []
                for i, cid in enumerate(all_ids):
                    source_id = ""
                    if i < len(all_metas) and all_metas[i]:
                        source_id = str(all_metas[i].get("source_id") or "")
                    for prefix in prefixes:
                        if (
                            cid == prefix
                            or cid.startswith(prefix + "_")
                            or cid.startswith(prefix + "#")
                            or source_id == prefix
                            or source_id.startswith(prefix + "#")
                        ):
                            to_delete.add(cid)
                            break
            if to_delete:
                col.delete(ids=list(to_delete))
                deleted += len(to_delete)
                _mark_bm25_dirty(name)
                log.info("Deleted %d chunk(s) from '%s'", len(to_delete), name)
        except Exception as exc:
            log.warning("Delete failed for '%s': %s", name, exc)
            raise HTTPException(
                status_code=500, detail=f"Delete failed for '{name}': {exc}"
            )

    return {"ok": True, "deleted": deleted}


# ---------------------------------------------------------------------------
# GET /export – dump all indexed data as JSON
# ---------------------------------------------------------------------------


class ExportResponse(BaseModel):
    collections: dict[str, list[dict]]  # { collection_name: [{id, content, metadata}] }
    has_more: bool = False
    next_offset: int = 0
    total_chunks: int = 0


@app.get("/export", response_model=ExportResponse)
def export_data(offset: int = 0, limit: int = EXPORT_PAGE_SIZE):
    """Dump indexed chunks from every collection as structured JSON.

    Supports pagination via offset/limit query parameters.  Each page
    returns up to `limit` chunks across all collections, with `has_more`
    and `next_offset` for paginating through large knowledge bases.

    Useful for backup, migration, or inspection.
    """
    limit = max(1, min(limit, EXPORT_PAGE_SIZE))
    offset = max(0, offset)

    client = get_chroma()
    col_names = _collection_names(client)

    # First pass: count total chunks for pagination info
    total_chunks = 0
    for name in col_names:
        try:
            col = client.get_collection(name=name)
            total_chunks += col.count()
        except Exception:
            continue

    # Second pass: fetch a page of data
    result: dict[str, list[dict]] = {}
    collected = 0
    skipped = 0
    has_more = False

    for name in col_names:
        if collected >= limit:
            has_more = True
            break

        try:
            col = client.get_collection(name=name)
            col_total = col.count()
            if col_total == 0:
                result[name] = []
                continue

            # Calculate how many to fetch from this collection
            remaining_in_page = limit - collected
            fetch_start = max(0, offset - skipped) if offset > skipped else 0
            fetch_count = min(remaining_in_page, col_total - fetch_start)

            if fetch_count <= 0:
                skipped += col_total
                continue

            # ChromaDB doesn't have native offset — we fetch from start and
            # slice in Python.  For very large collections this is a known
            # limitation; the page size cap keeps it bounded.
            data = col.get(
                limit=min(fetch_start + fetch_count, col_total),
                include=["documents", "metadatas"],
            )
            ids = data.get("ids", [])[fetch_start : fetch_start + fetch_count]
            docs = (data.get("documents", []) or [])[
                fetch_start : fetch_start + fetch_count
            ]
            metas = (data.get("metadatas", []) or [])[
                fetch_start : fetch_start + fetch_count
            ]

            entries = []
            for i in range(len(ids)):
                entries.append(
                    {
                        "id": ids[i] if i < len(ids) else "",
                        "content": docs[i] if i < len(docs) else "",
                        "metadata": metas[i] if i < len(metas) else {},
                    }
                )

            if entries:
                result[name] = entries
                collected += len(entries)
                log.info("Exported %d entries from collection '%s'", len(entries), name)

            skipped += col_total
        except Exception as exc:
            log.warning("Error exporting collection '%s': %s", name, exc)
            result[name] = []

    next_offset = offset + collected if collected > 0 else offset
    has_more = has_more or (offset + collected) < total_chunks

    return ExportResponse(
        collections=result,
        has_more=has_more,
        next_offset=next_offset,
        total_chunks=total_chunks,
    )


# ---------------------------------------------------------------------------
# POST /clear – drop ALL collections at once
# ---------------------------------------------------------------------------


class ClearResponse(BaseModel):
    ok: bool
    dropped: list[str]


@app.post("/clear", response_model=ClearResponse)
def clear_all():
    """Drop every ChromaDB collection, wiping the entire knowledge base.

    This is irreversible.  Callers should confirm with the user first.
    """
    client = get_chroma()
    col_names = _collection_names(client)

    dropped = []
    for name in col_names:
        try:
            client.delete_collection(name=name)
            dropped.append(name)
            _clear_bm25(name)
            log.info("Cleared collection '%s'", name)
        except Exception as exc:
            log.warning("Failed to clear collection '%s': %s", name, exc)

    return ClearResponse(ok=True, dropped=dropped)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    uvicorn.run(
        "server:app",
        host=SERVER_HOST,
        port=SERVER_PORT,
        log_level="info",
    )

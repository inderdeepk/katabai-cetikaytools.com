# Unit tests for the Katabai RAG service (stdlib unittest — no extra deps).
#
# Run from the repo root with the service venv:
#   ~/.local/share/katabai/rag-service/.venv/bin/python -m unittest discover -s rag-service/tests -p 'test_*.py'
# or: make test-rag-server

import json
import os
import re
import sys
import time
import unittest

from fastapi import HTTPException

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import server  # noqa: E402  (after sys.path insertion)


class ChunkTextTests(unittest.TestCase):
    def test_empty_and_whitespace(self):
        self.assertEqual(server.chunk_text(""), [])
        self.assertEqual(server.chunk_text("   \n\n  "), [])

    def test_short_text_is_single_chunk(self):
        self.assertEqual(server.chunk_text("hello world", 800, 120), ["hello world"])

    def test_paragraph_overlap_between_chunks(self):
        # Two paragraphs, each too large to merge together.
        para1 = ("alpha " * 100).strip()
        para2 = ("beta " * 100).strip()
        chunks = server.chunk_text(f"{para1}\n\n{para2}", 800, 120)
        self.assertGreaterEqual(len(chunks), 2)
        # The second chunk is seeded with the (word-snapped) tail of the first.
        self.assertTrue(chunks[1].startswith("alpha"), chunks[1][:40])
        self.assertIn("beta", chunks[1])
        for c in chunks:
            self.assertLessEqual(len(c), 800)

    def test_overlap_clamped_no_crash(self):
        para1 = ("alpha " * 100).strip()
        para2 = ("beta " * 100).strip()
        # overlap > chunk_size must be clamped (previously a ValueError path)
        chunks = server.chunk_text(f"{para1}\n\n{para2}", 800, 100000)
        self.assertGreaterEqual(len(chunks), 2)
        for c in chunks:
            self.assertLessEqual(len(c), 800)

    def test_long_sentence_hard_split_overlaps(self):
        text = ("word " * 500).strip()  # ~2499 chars, one "sentence"
        chunks = server.chunk_text(text, 800, 120)
        self.assertGreater(len(chunks), 3)
        for c in chunks:
            self.assertLessEqual(len(c), 800)
        # Consecutive hard-split pieces share the 120-char overlap region.
        self.assertIn(chunks[1][:100], chunks[0])

    def test_overlap_tail_snaps_to_word_boundary(self):
        text = "alpha beta gamma delta"
        self.assertEqual(server._overlap_tail(text, 8), "delta")
        self.assertEqual(server._overlap_tail(text, 0), "")
        self.assertEqual(server._overlap_tail("tiny", 10), "tiny")


class CollectionSpaceTests(unittest.TestCase):
    class _Col:
        def __init__(self, configuration=None, metadata=None):
            self.configuration = configuration
            self.metadata = metadata

    def test_reads_cosine_from_configuration_dict(self):
        col = self._Col(configuration={"hnsw": {"space": "cosine"}})
        self.assertEqual(server._collection_space(col), "cosine")

    def test_reads_l2_from_configuration_dict(self):
        col = self._Col(configuration={"hnsw": {"space": "l2"}})
        self.assertEqual(server._collection_space(col), "l2")

    def test_falls_back_to_metadata(self):
        col = self._Col(configuration=None, metadata={"hnsw:space": "cosine"})
        self.assertEqual(server._collection_space(col), "cosine")

    def test_unknown_when_unreadable(self):
        col = self._Col(configuration={}, metadata=None)
        self.assertEqual(server._collection_space(col), "unknown")


class _FakeCol:
    def __init__(self, registry, name):
        self.registry = registry
        self.name = name

    def modify(self, name=None, metadata=None, configuration=None):
        if name and name != self.name:
            self.registry.collections[name] = self.registry.collections.pop(self.name)
            self.name = name


class _FakeClient:
    """Minimal stand-in for chromadb.PersistentClient rename/delete flows."""

    def __init__(self, names):
        self.collections = {n: _FakeCol(self, n) for n in names}

    def list_collections(self):
        return list(self.collections.values())

    def get_collection(self, name):
        if name not in self.collections:
            raise ValueError(f"missing {name}")
        return self.collections[name]

    def delete_collection(self, name):
        if name not in self.collections:
            raise ValueError(f"missing {name}")
        del self.collections[name]

    def create_collection(self, name, metadata=None):
        col = _FakeCol(self, name)
        self.collections[name] = col
        return col


class MigrationRecoveryTests(unittest.TestCase):
    def test_both_base_and_l2old_drops_old_copy(self):
        client = _FakeClient(["conversations", "conversations__l2old"])
        server._recover_interrupted_migrations(client)
        self.assertEqual(set(client.collections), {"conversations"})

    def test_only_l2old_restores_original(self):
        client = _FakeClient(["conversations__l2old"])
        server._recover_interrupted_migrations(client)
        self.assertEqual(set(client.collections), {"conversations"})

    def test_only_cos_promotes_copy(self):
        client = _FakeClient(["conversations__cos"])
        server._recover_interrupted_migrations(client)
        self.assertEqual(set(client.collections), {"conversations"})

    def test_cos_and_l2old_prefers_original_restore(self):
        client = _FakeClient(["conversations__cos", "conversations__l2old"])
        server._recover_interrupted_migrations(client)
        self.assertEqual(set(client.collections), {"conversations"})

    def test_untouched_when_nothing_to_recover(self):
        client = _FakeClient(["conversations"])
        server._recover_interrupted_migrations(client)
        self.assertEqual(set(client.collections), {"conversations"})


class _FakeEvictCol:
    def __init__(self, rows):
        self._rows = list(rows)  # [(id, metadata)]
        self.deleted = []

    def get(self, include=None):
        return {
            "ids": [i for i, _ in self._rows],
            "metadatas": [m for _, m in self._rows],
        }

    def delete(self, ids):
        self.deleted.extend(ids)
        drop = set(ids)
        self._rows = [r for r in self._rows if r[0] not in drop]


class EvictOldestTests(unittest.TestCase):
    def test_evicts_lowest_indexed_at(self):
        col = _FakeEvictCol(
            [
                ("a", {"indexed_at": 30}),
                ("b", {"indexed_at": 10}),
                ("c", {"indexed_at": 20}),
            ]
        )
        n = server._evict_oldest_chunks(col, 2)
        self.assertEqual(n, 2)
        self.assertEqual(sorted(col.deleted), ["b", "c"])

    def test_noop_for_zero_count(self):
        col = _FakeEvictCol([("a", {"indexed_at": 1})])
        self.assertEqual(server._evict_oldest_chunks(col, 0), 0)
        self.assertEqual(col.deleted, [])


class Bm25FreshnessTests(unittest.TestCase):
    def test_dirty_flag_triggers_rebuild_once(self):
        calls = []
        orig_build = server._build_bm25_index
        server._build_bm25_index = lambda name: calls.append(name)
        try:
            server._bm25_dirty.discard("zz_test")
            server._bm25_indices.pop("zz_test", None)
            server._bm25_dirty.add("zz_test")

            def fake_build(name):
                calls.append(name)
                server._bm25_indices[name] = "built"

            server._build_bm25_index = fake_build
            server._ensure_bm25_fresh("zz_test")
            self.assertEqual(calls, ["zz_test"])
            self.assertNotIn("zz_test", server._bm25_dirty)

            # Second call is a no-op (fresh + present)
            server._ensure_bm25_fresh("zz_test")
            self.assertEqual(calls, ["zz_test"])
        finally:
            server._build_bm25_index = orig_build
            server._bm25_dirty.discard("zz_test")
            server._bm25_indices.pop("zz_test", None)


class RerankScoreParseTests(unittest.TestCase):
    def test_object_shape(self):
        self.assertEqual(
            server._parse_rerank_scores('{"scores": [0.1, 0.9]}', 2), [0.1, 0.9]
        )

    def test_bare_array(self):
        self.assertEqual(server._parse_rerank_scores("[0.5, 0.25]", 2), [0.5, 0.25])

    def test_json_wrapped_in_prose(self):
        text = 'Here you go: {"scores": [0.7, 0.2]} — done.'
        self.assertEqual(server._parse_rerank_scores(text, 2), [0.7, 0.2])

    def test_wrong_length_returns_none(self):
        self.assertIsNone(server._parse_rerank_scores('{"scores": [0.1]}', 2))

    def test_clamps_out_of_range(self):
        self.assertEqual(
            server._parse_rerank_scores('{"scores": [2, -1]}', 2), [1.0, 0.0]
        )

    def test_garbage_returns_none(self):
        self.assertIsNone(server._parse_rerank_scores("no json here", 2))
        self.assertIsNone(server._parse_rerank_scores("", 2))


class StorageSizeCacheTests(unittest.TestCase):
    def test_cache_ttl_and_force(self):
        calls = []
        orig = server._compute_storage_size_mb
        server._compute_storage_size_mb = lambda: (calls.append(1), 42.0)[1]
        try:
            server._storage_size_cache = {"value": 0.0, "ts": 0.0}
            self.assertEqual(server.estimate_storage_size_mb(), 42.0)
            self.assertEqual(server.estimate_storage_size_mb(), 42.0)
            self.assertEqual(len(calls), 1, "second call must hit the cache")
            self.assertEqual(server.estimate_storage_size_mb(force=True), 42.0)
            self.assertEqual(len(calls), 2, "force must recompute")
            # Expired TTL recomputes
            server._storage_size_cache["ts"] = time.monotonic() - 1000
            server.estimate_storage_size_mb()
            self.assertEqual(len(calls), 3)
        finally:
            server._compute_storage_size_mb = orig
            server._storage_size_cache = {"value": 0.0, "ts": 0.0}


class RerankBatchTests(unittest.TestCase):
    class _FakeClient:
        """Stub ollama client — counts chat calls and returns batched JSON."""

        model_available = True
        chat_calls = 0

        def __init__(self, host=None, timeout=None):
            pass

        def list(self):
            if RerankBatchTests._FakeClient.model_available:
                return {"models": [{"name": server.DEFAULT_RERANK_MODEL + ":latest"}]}
            return {"models": []}

        def chat(self, **kwargs):
            RerankBatchTests._FakeClient.chat_calls += 1
            prompt = kwargs["messages"][0]["content"]
            count = len(re.findall(r"\[\d+\]", prompt))
            return {"message": {"content": json.dumps({"scores": [0.5] * count})}}

    def setUp(self):
        self._orig_client = server.ollama.Client
        server.ollama.Client = self._FakeClient
        RerankBatchTests._FakeClient.chat_calls = 0
        RerankBatchTests._FakeClient.model_available = True

    def tearDown(self):
        server.ollama.Client = self._orig_client

    def _candidates(self, n):
        return [(f"id{i}", f"content {i} " * 5, {}, 0.9 - i * 0.01) for i in range(n)]

    def test_batches_ten_candidates_per_call(self):
        results, applied = server._rerank_results(
            "q",
            self._candidates(12),
            model=server.DEFAULT_RERANK_MODEL,
            ollama_url="http://x",
        )
        self.assertTrue(applied)
        self.assertEqual(len(results), 12)
        self.assertEqual(
            RerankBatchTests._FakeClient.chat_calls,
            2,
            "12 candidates must use 2 batched calls",
        )

    def test_missing_model_reports_not_applied(self):
        RerankBatchTests._FakeClient.model_available = False
        candidates = self._candidates(4)
        results, applied = server._rerank_results(
            "q", candidates, model=server.DEFAULT_RERANK_MODEL, ollama_url="http://x"
        )
        self.assertFalse(applied)
        self.assertEqual(results, candidates, "must return the original candidates")
        self.assertEqual(RerankBatchTests._FakeClient.chat_calls, 0)


class _DeleteFakeCol:
    def __init__(self, name, rows):
        self.name = name
        self._rows = dict(rows)  # id -> metadata

    def get(self, ids=None, where=None, include=None):
        if ids is not None:
            return {"ids": [i for i in ids if i in self._rows]}
        if where is not None:
            wanted = set((where.get("source_id") or {}).get("$in") or [])
            return {
                "ids": [
                    i
                    for i, m in self._rows.items()
                    if (m or {}).get("source_id") in wanted
                ]
            }
        ids_out = list(self._rows.keys())
        if include and "metadatas" in include:
            return {"ids": ids_out, "metadatas": [self._rows[i] for i in ids_out]}
        return {"ids": ids_out}

    def delete(self, ids):
        for i in ids:
            self._rows.pop(i, None)


class _DeleteFakeClient:
    def __init__(self, collections):
        self.collections = {
            name: _DeleteFakeCol(name, rows) for name, rows in collections.items()
        }

    def list_collections(self):
        return list(self.collections.values())

    def get_collection(self, name):
        if name not in self.collections:
            raise ValueError(f"missing {name}")
        return self.collections[name]


class DeleteEndpointTests(unittest.TestCase):
    def setUp(self):
        self._orig_get_chroma = server.get_chroma
        self.client = _DeleteFakeClient(
            {
                "conversations": {
                    "conv_a": {"source_id": "conv_a"},
                    "conv_a_chunk0": {"source_id": "conv_a"},
                    "conv_b#msg-1": {"source_id": "conv_b#msg-1"},
                    "update_prefs": {"source_id": "update_prefs"},
                },
                "research_cache": {"res_1": {"source_id": "res_1"}},
            }
        )
        server.get_chroma = lambda: self.client
        server._bm25_dirty.clear()

    def tearDown(self):
        server.get_chroma = self._orig_get_chroma
        server._bm25_dirty.clear()

    def test_delete_by_prefix_deletes_conversation_chunks(self):
        resp = server.delete_chunks(server.DeleteRequest(prefixes=["conv_a"]))
        self.assertEqual(resp["deleted"], 2)
        self.assertIn("conversations", server._bm25_dirty)
        # Unrelated rows survive
        self.assertIn("conv_b#msg-1", self.client.collections["conversations"]._rows)

    def test_delete_by_source_id_removes_memory(self):
        resp = server.delete_chunks(
            server.DeleteRequest(
                collection="conversations", source_ids=["update_prefs"]
            )
        )
        self.assertEqual(resp["deleted"], 1)
        self.assertNotIn("update_prefs", self.client.collections["conversations"]._rows)

    def test_delete_by_exact_ids_scans_all_collections(self):
        resp = server.delete_chunks(server.DeleteRequest(ids=["res_1"]))
        self.assertEqual(resp["deleted"], 1)
        self.assertIn("research_cache", server._bm25_dirty)

    def test_delete_requires_a_selector(self):
        with self.assertRaises(HTTPException) as ctx:
            server.delete_chunks(server.DeleteRequest())
        self.assertEqual(ctx.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()

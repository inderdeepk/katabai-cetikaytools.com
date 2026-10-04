// tests/ragTools.test.js — Tests for the local RAG / knowledge base tools.

import { assert, assertEqual, assertDeepEqual, createMockSettings, runTests } from './testUtils.js';

import {
    RAG_TOOL_NAME,
    RAG_TOOL_COMMAND,
    parseRagCommand,
    computeRagCoverageScore,
    buildRagResultBlock,
    buildRagToolSchema,
    readRagConfig,
    RagError,
    RagRuntime,
} from '../src/tools/ragTools.js';

const tests = [
    [
        'RAG_TOOL_NAME constants',
        () => {
            assertEqual(RAG_TOOL_NAME, 'knowledge_search');
            assertEqual(RAG_TOOL_COMMAND, '/kb');
        },
    ],

    [
        'parseRagCommand prefix',
        () => {
            const r = parseRagCommand('/kb what is the meaning of life?');
            assertEqual(r.isCommand, true);
            assertEqual(r.query, 'what is the meaning of life?');
        },
    ],

    [
        'parseRagCommand case-insensitive + trim',
        () => {
            const r = parseRagCommand('  /KB   hello world  ');
            assertEqual(r.isCommand, true);
            assertEqual(r.query, 'hello world');
        },
    ],

    [
        'parseRagCommand non-command',
        () => {
            const r = parseRagCommand('tell me about kb');
            assertEqual(r.isCommand, false);
            assertEqual(r.query, '');
        },
    ],

    [
        'parseRagCommand bare /kb is a command with empty query',
        () => {
            // Recognized so the caller can show the "Add a query after /kb" hint
            // instead of sending a literal "/kb" message to the model.
            const r = parseRagCommand('/kb');
            assertEqual(r.isCommand, true);
            assertEqual(r.query, '');
        },
    ],

    [
        'computeRagCoverageScore empty/null',
        () => {
            assertEqual(computeRagCoverageScore([]), 0.0);
            assertEqual(computeRagCoverageScore(null), 0.0);
        },
    ],

    [
        'computeRagCoverageScore top-3 average',
        () => {
            const results = [{ score: 0.9 }, { score: 0.6 }, { score: 0.3 }, { score: 0.1 }];
            assertEqual(computeRagCoverageScore(results), 0.6);
        },
    ],

    [
        'computeRagCoverageScore clamps at 1.0',
        () => {
            const results = [{ score: 2 }, { score: 3 }, { score: 4 }];
            assertEqual(computeRagCoverageScore(results), 1.0);
        },
    ],

    [
        'buildRagResultBlock empty results',
        () => {
            const out = buildRagResultBlock('q', { results: [] });
            assert(out.includes('returned no results'), 'should mention no results');
        },
    ],

    [
        'buildRagResultBlock renders missing score safely',
        () => {
            const out = buildRagResultBlock('q', {
                results: [{ id: 'x', content: 'hello world', metadata: { source: 'document' } }],
            });
            assert(!out.includes('NaN'), 'must not render NaN%');
            assert(out.includes('[Score: 0%]'), 'missing score becomes 0%');
        },
    ],

    [
        'buildRagResultBlock includes guard + metadata',
        () => {
            const out = buildRagResultBlock('q', {
                results: [
                    {
                        id: 'x',
                        content: 'the answer',
                        metadata: {
                            source: 'conversation',
                            title: 'T',
                            url: 'https://e.com',
                            timestamp: '2026-01-01',
                        },
                        score: 0.75,
                    },
                ],
            });
            assert(out.includes('IMPORTANT'), 'guard should be present');
            assert(out.includes('[Score: 75%]'));
            assert(out.includes('"T"'));
            assert(out.includes('URL: https://e.com'));
        },
    ],

    [
        'readRagConfig falls back to main ollama-url',
        () => {
            const settings = createMockSettings({
                'rag-enabled': true,
                'ollama-url': 'http://192.168.1.50:11434',
            });
            const cfg = readRagConfig(settings);
            assertEqual(cfg.enabled, true);
            assertEqual(cfg.ollamaUrl, 'http://192.168.1.50:11434');
        },
    ],

    [
        'readRagConfig fallback defaults match schema',
        () => {
            // A settings object whose getters THROW for missing keys exercises the
            // readRagConfig fallbacks (the path taken when the schema is stale).
            const settings = {
                get_boolean: (key) => {
                    if (key === 'rag-enabled') return true;
                    throw new Error('missing');
                },
                get_string: (key) => {
                    if (key === 'rag-ollama-url') return 'http://localhost:11434';
                    throw new Error('missing');
                },
                get_int: () => {
                    throw new Error('missing');
                },
                get_double: () => {
                    throw new Error('missing');
                },
            };
            const cfg = readRagConfig(settings);
            assertEqual(cfg.indexConversations, true);
            assertEqual(cfg.hybridEnabled, true);
            assertEqual(cfg.embeddingModel, 'nomic-embed-text');
        },
    ],

    [
        'readRagConfig honors explicit overrides',
        () => {
            const settings = createMockSettings({
                'rag-enabled': true,
                'rag-index-conversations': false,
                'rag-hybrid-enabled': false,
                'rag-embedding-model': 'other-embed',
                'rag-top-k': 9,
                'rag-fallback-threshold': 0.5,
            });
            const cfg = readRagConfig(settings);
            assertEqual(cfg.indexConversations, false);
            assertEqual(cfg.hybridEnabled, false);
            assertEqual(cfg.embeddingModel, 'other-embed');
            assertEqual(cfg.topK, 9);
            assertEqual(cfg.fallbackThreshold, 0.5);
        },
    ],

    [
        'RagRuntime.search shapes payload + mode',
        async () => {
            const runtime = new RagRuntime({ session: {}, timeoutSeconds: 5 });
            let captured = null;
            runtime._request = async (method, url, body) => {
                captured = { method, url, body };
                return { status: 200, body: { results: [] } };
            };
            const cfg = {
                serviceUrl: 'http://localhost:11435/',
                topK: 5,
                embeddingModel: 'nomic-embed-text',
                ollamaUrl: 'http://localhost:11434',
                rerankEnabled: false,
                rerankModel: 'bge-reranker-v2-m3',
                rerankCandidateMultiplier: 4,
                hybridEnabled: true,
            };
            const out = await runtime.search('  hello world  ', cfg);
            assertEqual(captured.method, 'POST');
            assertEqual(captured.url, 'http://localhost:11435/search');
            assertEqual(captured.body.query, 'hello world');
            assertEqual(captured.body.k, 5);
            assertEqual(captured.body.hybrid, true);
            assertEqual(out.mode, 'dense+bm25');
        },
    ],

    [
        'RagRuntime.search caches identical queries',
        async () => {
            const runtime = new RagRuntime({ session: {}, timeoutSeconds: 5 });
            let calls = 0;
            runtime._request = async () => {
                calls++;
                // The service reports plain "dense" (e.g. hybrid requested but the
                // BM25 index is unavailable) — the cached hit must keep that mode,
                // not the flags-based guess computed by the client.
                return { status: 200, body: { results: [{ id: 'a', score: 0.5 }], mode: 'dense' } };
            };
            const cfg = {
                serviceUrl: 'http://localhost:11435',
                topK: 5,
                embeddingModel: 'm',
                ollamaUrl: 'http://localhost:11434',
                rerankEnabled: false,
                rerankModel: 'r',
                rerankCandidateMultiplier: 4,
                hybridEnabled: true,
            };
            const first = await runtime.search('cache me', cfg);
            const second = await runtime.search('cache me', cfg);
            assertEqual(calls, 1, 'second identical query must hit the cache');
            assertEqual(first.mode, 'dense');
            assertEqual(second.mode, 'dense', 'cached hit must keep the service-reported mode');
        },
    ],

    [
        'RagRuntime.index passes replace_ids',
        async () => {
            const runtime = new RagRuntime({ session: {}, timeoutSeconds: 5 });
            let captured = null;
            runtime._request = async (_m, _u, body) => {
                captured = body;
                return { status: 200, body: { indexed: 1, chunks: 2 } };
            };
            const out = await runtime.index(
                [{ id: 'doc1', content: 'text', metadata: { source: 'document' } }],
                'documents',
                {
                    serviceUrl: 'http://localhost:11435',
                    chunkSize: 800,
                    chunkOverlap: 120,
                    embeddingModel: 'm',
                    ollamaUrl: 'http://localhost:11434',
                },
                null,
            );
            assertEqual(out.indexed, 1);
            assertEqual(out.chunks, 2);
            assertDeepEqual(captured.replace_ids, ['doc1']);
            assertEqual(captured.collection, 'documents');
        },
    ],

    [
        'RagRuntime.index empty input is a no-op',
        async () => {
            const runtime = new RagRuntime({ session: {}, timeoutSeconds: 5 });
            let called = false;
            runtime._request = async () => {
                called = true;
            };
            const out = await runtime.index([], 'documents', { serviceUrl: 'http://x' }, null);
            assertEqual(out.indexed, 0);
            assertEqual(called, false);
        },
    ],

    [
        'RagRuntime.index surfaces rejected + clears search cache',
        async () => {
            const runtime = new RagRuntime({ session: {}, timeoutSeconds: 5 });
            runtime._searchCache.set('seed', {
                results: [],
                mode: 'dense',
                expires: Date.now() + 60000,
            });
            runtime._request = async () => ({
                status: 200,
                body: { indexed: 0, chunks: 0, rejected: 4, reason: 'at cap' },
            });
            const out = await runtime.index(
                [{ id: 'x', content: 'y' }],
                'conversations',
                { serviceUrl: 'http://x' },
                null,
            );
            assertEqual(out.chunks, 0);
            assertEqual(out.rejected, 4);
            assertEqual(out.reason, 'at cap');
            assertEqual(runtime._searchCache.size, 0, 'indexing must invalidate cached searches');
        },
    ],

    [
        'RagRuntime.search reports score_space',
        async () => {
            const runtime = new RagRuntime({ session: {}, timeoutSeconds: 5 });
            runtime._request = async () => ({
                status: 200,
                body: { results: [], score_space: 'cosine' },
            });
            const out = await runtime.search('q', {
                serviceUrl: 'http://x',
                topK: 5,
                embeddingModel: 'm',
                ollamaUrl: 'http://o',
                rerankEnabled: false,
                rerankModel: 'r',
                rerankCandidateMultiplier: 4,
                hybridEnabled: false,
            });
            assertEqual(out.scoreSpace, 'cosine');
        },
    ],

    [
        'RagRuntime.health probes the embedding backend',
        async () => {
            const runtime = new RagRuntime({ session: {}, timeoutSeconds: 5 });
            let capturedUrl = '';
            runtime._request = async (_m, url) => {
                capturedUrl = url;
                return {
                    status: 200,
                    body: {
                        ok: true,
                        collections: {},
                        embedding: { ok: false, error: 'no ollama' },
                    },
                };
            };
            const out = await runtime.health({
                serviceUrl: 'http://localhost:11435/',
                ollamaUrl: 'http://localhost:11434',
                embeddingModel: 'nomic-embed-text',
            });
            assert(
                capturedUrl.startsWith('http://localhost:11435/health?'),
                'health URL keeps query params',
            );
            assert(
                capturedUrl.includes('ollama_url=http%3A%2F%2Flocalhost%3A11434'),
                'includes encoded ollama_url',
            );
            assert(
                capturedUrl.includes('embedding_model=nomic-embed-text'),
                'includes embedding model',
            );
            assertEqual(out.embedding.ok, false);
        },
    ],

    [
        'RagRuntime.deleteData posts selectors + clears cache',
        async () => {
            const runtime = new RagRuntime({ session: {}, timeoutSeconds: 5 });
            runtime._searchCache.set('seed', {
                results: [],
                mode: 'dense',
                expires: Date.now() + 60000,
            });
            let captured = null;
            runtime._request = async (_m, url, body) => {
                captured = { url, body };
                return { status: 200, body: { ok: true, deleted: 3 } };
            };
            const out = await runtime.deleteData(
                { prefixes: ['conv_1'] },
                { serviceUrl: 'http://localhost:11435' },
            );
            assertEqual(out.deleted, 3);
            assertEqual(captured.url, 'http://localhost:11435/delete');
            assertDeepEqual(captured.body.prefixes, ['conv_1']);
            assertEqual(captured.body.collection, null);
            assertDeepEqual(captured.body.source_ids, []);
            assertEqual(runtime._searchCache.size, 0, 'delete must invalidate cached searches');
        },
    ],

    [
        'RagRuntime.search prefers the service-reported mode',
        async () => {
            const runtime = new RagRuntime({ session: {}, timeoutSeconds: 5 });
            runtime._request = async () => ({
                status: 200,
                // Flags ask for hybrid + rerank, but the service reports dense only
                // (e.g. reranker model missing) — the service answer must win.
                body: { results: [], mode: 'dense' },
            });
            const out = await runtime.search('q', {
                serviceUrl: 'http://x',
                topK: 5,
                embeddingModel: 'm',
                ollamaUrl: 'http://o',
                rerankEnabled: true,
                rerankModel: 'r',
                rerankCandidateMultiplier: 4,
                hybridEnabled: true,
            });
            assertEqual(out.mode, 'dense');
        },
    ],

    [
        'buildRagResultBlock labels memory updates + message roles',
        () => {
            const out = buildRagResultBlock('q', {
                results: [
                    {
                        id: 'u1',
                        content: 'fact',
                        metadata: { source: 'knowledge_update', title: 'Prefs' },
                        score: 0.8,
                    },
                    {
                        id: 'm1',
                        content: 'chat',
                        metadata: { source: 'conversation', role: 'assistant', messageIndex: 12 },
                        score: 0.6,
                    },
                ],
            });
            assert(out.includes('(source: memory update)'), 'update labelled');
            assert(out.includes('(source: conversation · assistant #12)'), 'role + index labelled');
        },
    ],

    [
        'buildRagToolSchema exposes optional collection filter',
        () => {
            const schema = buildRagToolSchema({ provider: 'openai' });
            const props = schema.function.parameters.properties;
            assert(props.collection !== undefined, 'collection param present');
            assertDeepEqual(props.collection.enum, [
                'conversations',
                'documents',
                'research_cache',
            ]);
            const anthropic = buildRagToolSchema({ provider: 'anthropic' });
            assert(
                anthropic.input_schema.properties.collection !== undefined,
                'anthropic shape too',
            );
        },
    ],

    [
        'RagRuntime.search forwards collection + separates cache',
        async () => {
            const runtime = new RagRuntime({ session: {}, timeoutSeconds: 5 });
            let calls = 0;
            let lastBody = null;
            runtime._request = async (_m, _u, body) => {
                calls++;
                lastBody = body;
                return { status: 200, body: { results: [] } };
            };
            const cfg = {
                serviceUrl: 'http://x',
                topK: 5,
                embeddingModel: 'm',
                ollamaUrl: 'http://o',
                rerankEnabled: false,
                rerankModel: 'r',
                rerankCandidateMultiplier: 4,
                hybridEnabled: false,
            };
            await runtime.search('filtered', { ...cfg, collection: 'documents' });
            assertEqual(lastBody.collection, 'documents');
            await runtime.search('filtered', { ...cfg, collection: 'conversations' });
            assertEqual(calls, 2, 'collection is part of the cache key');
            assertEqual(lastBody.collection, 'conversations');
        },
    ],

    [
        'RagError prototype chain',
        () => {
            const e = new RagError('boom', { code: 'x', detail: 'd' });
            assert(e instanceof Error, 'RagError should be an Error');
            assertEqual(e.name, 'RagError');
            assertEqual(e.code, 'x');
        },
    ],
];

await runTests(tests);

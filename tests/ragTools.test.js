// tests/ragTools.test.js — Tests for the local RAG / knowledge base tools.

import {
    assert,
    assertEqual,
    assertDeepEqual,
    createMockSettings,
    runTests,
} from './testUtils.js';

import {
    RAG_TOOL_NAME,
    RAG_TOOL_COMMAND,
    parseRagCommand,
    computeRagCoverageScore,
    buildRagResultBlock,
    readRagConfig,
    RagError,
    RagRuntime,
} from '../src/tools/ragTools.js';

const tests = [
    ['RAG_TOOL_NAME constants', () => {
        assertEqual(RAG_TOOL_NAME, 'knowledge_search');
        assertEqual(RAG_TOOL_COMMAND, '/kb');
    }],

    ['parseRagCommand prefix', () => {
        const r = parseRagCommand('/kb what is the meaning of life?');
        assertEqual(r.isCommand, true);
        assertEqual(r.query, 'what is the meaning of life?');
    }],

    ['parseRagCommand case-insensitive + trim', () => {
        const r = parseRagCommand('  /KB   hello world  ');
        assertEqual(r.isCommand, true);
        assertEqual(r.query, 'hello world');
    }],

    ['parseRagCommand non-command', () => {
        const r = parseRagCommand('tell me about kb');
        assertEqual(r.isCommand, false);
        assertEqual(r.query, '');
    }],

    ['parseRagCommand bare /kb is not a command', () => {
        const r = parseRagCommand('/kb');
        assertEqual(r.isCommand, false);
    }],

    ['computeRagCoverageScore empty/null', () => {
        assertEqual(computeRagCoverageScore([]), 0.0);
        assertEqual(computeRagCoverageScore(null), 0.0);
    }],

    ['computeRagCoverageScore top-3 average', () => {
        const results = [{ score: 0.9 }, { score: 0.6 }, { score: 0.3 }, { score: 0.1 }];
        assertEqual(computeRagCoverageScore(results), 0.6);
    }],

    ['computeRagCoverageScore clamps at 1.0', () => {
        const results = [{ score: 2 }, { score: 3 }, { score: 4 }];
        assertEqual(computeRagCoverageScore(results), 1.0);
    }],

    ['buildRagResultBlock empty results', () => {
        const out = buildRagResultBlock('q', { results: [] });
        assert(out.includes('returned no results'), 'should mention no results');
    }],

    ['buildRagResultBlock renders missing score safely', () => {
        const out = buildRagResultBlock('q', {
            results: [{ id: 'x', content: 'hello world', metadata: { source: 'document' } }],
        });
        assert(!out.includes('NaN'), 'must not render NaN%');
        assert(out.includes('[Score: 0%]'), 'missing score becomes 0%');
    }],

    ['buildRagResultBlock includes guard + metadata', () => {
        const out = buildRagResultBlock('q', {
            results: [{
                id: 'x',
                content: 'the answer',
                metadata: { source: 'conversation', title: 'T', url: 'https://e.com', timestamp: '2026-01-01' },
                score: 0.75,
            }],
        });
        assert(out.includes('IMPORTANT'), 'guard should be present');
        assert(out.includes('[Score: 75%]'));
        assert(out.includes('"T"'));
        assert(out.includes('URL: https://e.com'));
    }],

    ['readRagConfig falls back to main ollama-url', () => {
        const settings = createMockSettings({
            'rag-enabled': true,
            'ollama-url': 'http://192.168.1.50:11434',
        });
        const cfg = readRagConfig(settings);
        assertEqual(cfg.enabled, true);
        assertEqual(cfg.ollamaUrl, 'http://192.168.1.50:11434');
    }],

    ['readRagConfig fallback defaults match schema', () => {
        // A settings object whose getters THROW for missing keys exercises the
        // readRagConfig fallbacks (the path taken when the schema is stale).
        const settings = {
            get_boolean: key => {
                if (key === 'rag-enabled') return true;
                throw new Error('missing');
            },
            get_string: key => {
                if (key === 'rag-ollama-url') return 'http://localhost:11434';
                throw new Error('missing');
            },
            get_int: () => { throw new Error('missing'); },
            get_double: () => { throw new Error('missing'); },
        };
        const cfg = readRagConfig(settings);
        assertEqual(cfg.indexConversations, true);
        assertEqual(cfg.hybridEnabled, true);
        assertEqual(cfg.embeddingModel, 'nomic-embed-text');
    }],

    ['readRagConfig honors explicit overrides', () => {
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
    }],

    ['RagRuntime.search shapes payload + mode', async () => {
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
    }],

    ['RagRuntime.search caches identical queries', async () => {
        const runtime = new RagRuntime({ session: {}, timeoutSeconds: 5 });
        let calls = 0;
        runtime._request = async () => {
            calls++;
            return { status: 200, body: { results: [{ id: 'a', score: 0.5 }] } };
        };
        const cfg = {
            serviceUrl: 'http://localhost:11435',
            topK: 5,
            embeddingModel: 'm',
            ollamaUrl: 'http://localhost:11434',
            rerankEnabled: false,
            rerankModel: 'r',
            rerankCandidateMultiplier: 4,
            hybridEnabled: false,
        };
        await runtime.search('cache me', cfg);
        await runtime.search('cache me', cfg);
        assertEqual(calls, 1, 'second identical query must hit the cache');
    }],

    ['RagRuntime.index passes replace_ids', async () => {
        const runtime = new RagRuntime({ session: {}, timeoutSeconds: 5 });
        let captured = null;
        runtime._request = async (_m, _u, body) => {
            captured = body;
            return { status: 200, body: { indexed: 1, chunks: 2 } };
        };
        const out = await runtime.index(
            [{ id: 'doc1', content: 'text', metadata: { source: 'document' } }],
            'documents',
            { serviceUrl: 'http://localhost:11435', chunkSize: 800, chunkOverlap: 120, embeddingModel: 'm', ollamaUrl: 'http://localhost:11434' },
            null
        );
        assertEqual(out.indexed, 1);
        assertEqual(out.chunks, 2);
        assertDeepEqual(captured.replace_ids, ['doc1']);
        assertEqual(captured.collection, 'documents');
    }],

    ['RagRuntime.index empty input is a no-op', async () => {
        const runtime = new RagRuntime({ session: {}, timeoutSeconds: 5 });
        let called = false;
        runtime._request = async () => { called = true; };
        const out = await runtime.index([], 'documents', { serviceUrl: 'http://x' }, null);
        assertEqual(out.indexed, 0);
        assertEqual(called, false);
    }],

    ['RagError prototype chain', () => {
        const e = new RagError('boom', { code: 'x', detail: 'd' });
        assert(e instanceof Error, 'RagError should be an Error');
        assertEqual(e.name, 'RagError');
        assertEqual(e.code, 'x');
    }],
];

await runTests(tests);

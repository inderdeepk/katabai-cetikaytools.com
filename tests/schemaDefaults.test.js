// schemaDefaults.test.js — Guards against drift between GSettings schema
// defaults and the fallback values hardcoded in the shared tool modules.
//
// When a default exists in both places (e.g. crawl4ai-llm-provider), editing
// one and forgetting the other silently changes behavior depending on whether
// the setting was ever written. This suite parses the schema XML and asserts
// the module fallbacks still agree with the schema defaults.
import GLib from 'gi://GLib';
import { assert, assertEqual, runTests, createMockSettings } from './testUtils.js';
import { readCrawl4AIConfig } from '../src/tools/crawl4aiTools.js';
import { readRagConfig } from '../src/tools/ragTools.js';

function resolveSchemaPath() {
    const candidates = [];
    try {
        if (import.meta && import.meta.url) {
            const [modulePath] = GLib.filename_from_uri(import.meta.url);
            const repoRoot = GLib.path_get_dirname(GLib.path_get_dirname(modulePath));
            candidates.push(GLib.build_filenamev([
                repoRoot, 'schemas', 'org.gnome.shell.extensions.katabai.gschema.xml',
            ]));
        }
    } catch (_e) {
        // Fall through to the cwd-based candidate.
    }
    candidates.push(GLib.build_filenamev([
        GLib.get_current_dir(), 'schemas', 'org.gnome.shell.extensions.katabai.gschema.xml',
    ]));
    for (const candidate of candidates) {
        if (GLib.file_test(candidate, GLib.FileTest.EXISTS)) {
            return candidate;
        }
    }
    return candidates[0];
}

const SCHEMA_PATH = resolveSchemaPath();

function readSchemaXml() {
    const [ok, bytes] = GLib.file_get_contents(SCHEMA_PATH);
    if (!ok) {
        throw new Error(`Could not read schema file: ${SCHEMA_PATH}`);
    }
    return new TextDecoder('utf-8').decode(bytes);
}

const SCHEMA_XML = readSchemaXml();

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extract the <default> value for a schema key (string defaults are single-quoted). */
function schemaDefault(key) {
    const pattern = new RegExp(`<key name="${escapeRegExp(key)}"[^>]*>[\\s\\S]*?<default>([\\s\\S]*?)</default>`);
    const match = SCHEMA_XML.match(pattern);
    if (!match) {
        throw new Error(`Schema key not found (or has no default): ${key}`);
    }
    let value = match[1].trim();
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1);
    }
    return value
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function assertStringMatches(actual, schemaKey) {
    assertEqual(actual, schemaDefault(schemaKey), `${schemaKey}: module fallback matches schema default`);
}

function assertIntMatches(actual, schemaKey) {
    assertEqual(actual, Number(schemaDefault(schemaKey)), `${schemaKey}: module fallback matches schema default`);
}

function assertDoubleMatches(actual, schemaKey) {
    const expected = Number(schemaDefault(schemaKey));
    assert(Math.abs(actual - expected) < 1e-9, `${schemaKey}: module fallback ${actual} != schema default ${expected}`);
}

// The crawl4ai reader applies `||` fallbacks when getters return empty values,
// so an empty (non-throwing) mock exercises exactly the duplicated defaults.
const emptySettings = createMockSettings();
const crawl = readCrawl4AIConfig(emptySettings);

// The rag reader applies fallbacks in its try/catch blocks, so the settings
// mock must throw to exercise the duplicated defaults.
const throwingSettings = {
    get_string: () => { throw new Error('unset'); },
    get_boolean: () => { throw new Error('unset'); },
    get_int: () => { throw new Error('unset'); },
    get_double: () => { throw new Error('unset'); },
};
const rag = readRagConfig(throwingSettings);

const tests = [
    ['schema file is readable and contains expected keys', () => {
        assert(SCHEMA_XML.includes('crawl4ai-llm-provider'), 'schema contains crawl4ai keys');
        assert(SCHEMA_XML.includes('rag-service-url'), 'schema contains rag keys');
    }],

    // ── Crawl4AI: reader fallbacks vs schema defaults ──────────────────────

    ['crawl4ai: string fallbacks match schema defaults', () => {
        assertStringMatches(crawl.fitMarkdownMode, 'crawl4ai-fit-markdown-mode');
        assertStringMatches(crawl.cacheMode, 'crawl4ai-cache-mode');
        assertStringMatches(crawl.extractionMode, 'crawl4ai-extraction-mode');
        assertStringMatches(crawl.llmProvider, 'crawl4ai-llm-provider');
        assertStringMatches(crawl.llmInstruction, 'crawl4ai-llm-instruction');
        assertStringMatches(crawl.llmSchemaJson, 'crawl4ai-llm-schema-json');
    }],

    ['crawl4ai: numeric fallbacks match schema defaults', () => {
        assertIntMatches(crawl.wordCountThreshold, 'crawl4ai-word-count-threshold');
        assertIntMatches(crawl.pageTimeout, 'crawl4ai-page-timeout');
        assertIntMatches(crawl.maxChars, 'crawl4ai-max-chars');
        assertIntMatches(crawl.jobPollMs, 'crawl4ai-job-poll-ms');
        assertIntMatches(crawl.llmChunkTokenThreshold, 'crawl4ai-llm-chunk-token-threshold');
        assertDoubleMatches(crawl.llmOverlapRate, 'crawl4ai-llm-overlap-rate');
    }],

    // ── RAG: reader fallbacks vs schema defaults ───────────────────────────

    ['rag: string fallbacks match schema defaults', () => {
        assertStringMatches(rag.serviceUrl, 'rag-service-url');
        assertStringMatches(rag.ollamaUrl, 'rag-ollama-url');
        assertStringMatches(rag.embeddingModel, 'rag-embedding-model');
        assertStringMatches(rag.rerankModel, 'rag-rerank-model');
    }],

    ['rag: numeric fallbacks match schema defaults', () => {
        assertIntMatches(rag.chunkSize, 'rag-chunk-size');
        assertIntMatches(rag.chunkOverlap, 'rag-chunk-overlap');
        assertIntMatches(rag.topK, 'rag-top-k');
        assertIntMatches(rag.maxChunksPerCollection, 'rag-max-chunks-per-collection');
        assertIntMatches(rag.maxTotalSizeMb, 'rag-max-total-size-mb');
        assertIntMatches(rag.rerankCandidateMultiplier, 'rag-rerank-candidate-multiplier');
        assertDoubleMatches(rag.fallbackThreshold, 'rag-fallback-threshold');
    }],

    // ── Parser self-check ──────────────────────────────────────────────────

    ['schema parser throws for a missing key', () => {
        let threw = false;
        try {
            schemaDefault('definitely-not-a-key');
        } catch (_e) {
            threw = true;
        }
        assert(threw, 'missing key must throw');
    }],
];

await runTests(tests);

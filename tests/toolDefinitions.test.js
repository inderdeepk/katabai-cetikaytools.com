// toolDefinitions.test.js — Tests for concrete tool definitions registration
//
// Importing toolDefinitions.js triggers side-effect registration of all
// 6 tools into the shared registry.  We verify each tool is registered
// with the correct metadata.

import {
    lookupTool,
    getAllToolNames,
    getToolsByDanger,
    clearRegistry,
    DANGER_READ_ONLY,
    DANGER_POTENTIALLY_UNSAFE,
} from '../src/tools/toolRegistry.js';
import { assert, assertEqual, assertDeepEqual, runTests } from './testUtils.js';

// IMPORTANT: Import triggers registration — must be after clearRegistry
// to avoid leftover state from other test files.
clearRegistry();

// Now import — this triggers the side-effect registerTool() calls
await import('../src/tools/toolDefinitions.js');

const tests = [
    // ── Tool count ─────────────────────────────────────────────────────────

    ['toolDefinitions: all expected tools registered', () => {
        const names = getAllToolNames();
        // toolDefinitions.js registers: web_search, read_url, crawl_url, document,
        // deep_research, knowledge_search. Additionally, ragTools.js may register
        // update_knowledge if imported transitively.
        const expected = ['web_search', 'read_url', 'crawl_url', 'document', 'deep_research', 'knowledge_search'];
        for (const name of expected) {
            assert(names.includes(name), `${name} is registered`);
        }
        assert(names.length >= 6, 'at least 6 tools');
    }],

    // ── Individual tool verification ───────────────────────────────────────

    ['toolDefinitions: web_search', () => {
        const tool = lookupTool('web_search');
        assert(tool !== undefined, 'web_search exists');
        assertEqual(tool.dangerLevel, DANGER_READ_ONLY, 'read_only');
        assertEqual(tool.isMeta, false, 'not meta');
        assertEqual(tool.uiLabel, 'Search', 'ui label');
        assertEqual(tool.command, '/search', 'slash command');
        assert(tool.parameters !== null, 'has parameters');
        assert(tool.parameters.required.includes('query'), 'requires query');
    }],

    ['toolDefinitions: read_url', () => {
        const tool = lookupTool('read_url');
        assert(tool !== undefined, 'read_url exists');
        assertEqual(tool.dangerLevel, DANGER_READ_ONLY, 'read_only');
        assertEqual(tool.command, null, 'no slash command');
        assert(tool.parameters.required.includes('url'), 'requires url');
    }],

    ['toolDefinitions: crawl_url', () => {
        const tool = lookupTool('crawl_url');
        assert(tool !== undefined, 'crawl_url exists');
        assertEqual(tool.dangerLevel, DANGER_READ_ONLY, 'read_only');
        assertEqual(tool.uiLabel, 'Scrape', 'ui label');
        assertEqual(tool.command, '/crawl', 'slash command');
        assert(tool.parameters.required.includes('url'), 'requires url');
    }],

    ['toolDefinitions: document', () => {
        const tool = lookupTool('document');
        assert(tool !== undefined, 'document exists');
        assertEqual(tool.dangerLevel, DANGER_POTENTIALLY_UNSAFE, 'potentially_unsafe');
        assertEqual(tool.parameters, null, 'no API schema (pre-send tool)');
        assertEqual(tool.uiLabel, 'Docs', 'ui label');
        assertEqual(tool.command, '/doc', 'slash command');
    }],

    ['toolDefinitions: deep_research', () => {
        const tool = lookupTool('deep_research');
        assert(tool !== undefined, 'deep_research exists');
        assertEqual(tool.dangerLevel, DANGER_READ_ONLY, 'read_only');
        assertEqual(tool.isMeta, true, 'is meta tool');
        assertEqual(tool.parameters, null, 'no API schema (meta tool)');
        assertEqual(tool.uiLabel, 'Research', 'ui label');
        assertEqual(tool.command, '/research', 'slash command');
    }],

    ['toolDefinitions: knowledge_search (RAG)', () => {
        const tool = lookupTool('knowledge_search');
        assert(tool !== undefined, 'knowledge_search exists');
        assertEqual(tool.dangerLevel, DANGER_READ_ONLY, 'read_only');
        assertEqual(tool.isMeta, false, 'not meta');
        assert(tool.parameters !== null, 'has parameters');
        assert(tool.parameters.required.includes('query'), 'requires query');
        assertEqual(tool.uiLabel, 'Knowledge', 'ui label');
    }],

    // ── Danger level partitioning ──────────────────────────────────────────

    ['toolDefinitions: danger level partitioning', () => {
        const readOnly = getToolsByDanger(DANGER_READ_ONLY);
        const unsafe = getToolsByDanger(DANGER_POTENTIALLY_UNSAFE);

        assertEqual(readOnly.length, 5, '5 read_only tools');
        // document + update_knowledge are potentially_unsafe
        assertEqual(unsafe.length, 2, '2 potentially_unsafe tools');
        const unsafeNames = unsafe.map(t => t.name);
        assert(unsafeNames.includes('document'), 'document is unsafe');
        assert(unsafeNames.includes('update_knowledge'), 'update_knowledge is unsafe');
    }],

    // ── No duplicate names ────────────────────────────────────────────────

    ['toolDefinitions: no duplicate tool names', () => {
        const names = getAllToolNames();
        const unique = new Set(names);
        assertEqual(names.length, unique.size, 'all names unique');
    }],

    // ── Schema completeness ────────────────────────────────────────────────

    ['toolDefinitions: all non-meta, non-document tools have parameters', () => {
        const toolNames = getAllToolNames();
        for (const name of toolNames) {
            const tool = lookupTool(name);
            if (tool.isMeta) continue;      // meta tools don't need schemas
            if (name === 'document') continue; // pre-send tool, no API schema
            assert(tool.parameters !== null, `${name} has parameters`);
            assert(tool.parameters.type === 'object', `${name} params is object type`);
        }
    }],

    ['toolDefinitions: all tools have uiLabel and uiIcon', () => {
        const toolNames = getAllToolNames();
        for (const name of toolNames) {
            const tool = lookupTool(name);
            // update_knowledge intentionally has null uiLabel/uiIcon (not shown in chat footer)
            if (name === 'update_knowledge') continue;
            assert(typeof tool.uiLabel === 'string' && tool.uiLabel.length > 0, `${name} has uiLabel`);
            assert(typeof tool.uiIcon === 'string' && tool.uiIcon.length > 0, `${name} has uiIcon`);
        }
    }],
];

runTests(tests);

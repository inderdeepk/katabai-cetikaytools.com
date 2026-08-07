// toolRegistry.test.js — Tests for declarative tool registry
import {
    registerTool,
    lookupTool,
    getAllToolNames,
    getAllTools,
    getToolsByDanger,
    buildAllToolSchemas,
    buildToolSchemasFor,
    clearRegistry,
    createNotReadyHandler,
    DANGER_READ_ONLY,
    DANGER_POTENTIALLY_UNSAFE,
} from '../src/tools/toolRegistry.js';
import { assert, assertEqual, assertDeepEqual, assertThrows, runTests } from './testUtils.js';

// Clean registry before each test that needs isolation
function freshRegistry() {
    clearRegistry();
}

const tests = [
    // ── registerTool ───────────────────────────────────────────────────────

    ['registerTool: valid definition', () => {
        freshRegistry();
        const def = {
            name: 'test_tool',
            description: 'A test tool',
            parameters: { type: 'object', properties: {} },
            dangerLevel: DANGER_READ_ONLY,
            handler: async () => 'result',
            uiLabel: 'Test',
            uiIcon: 'test-symbolic',
            command: '/test',
            resultTruncationKey: 'search',
            isMeta: false,
            providerScoped: false,
        };
        registerTool(def);
        const found = lookupTool('test_tool');
        assertEqual(found.name, 'test_tool', 'tool registered');
        assertEqual(found.dangerLevel, DANGER_READ_ONLY, 'danger level correct');
    }],

    ['registerTool: missing name throws', () => {
        freshRegistry();
        assertThrows(() => registerTool({}), 'must have a name', 'missing name');
        assertThrows(() => registerTool(null), 'must have a name', 'null def');
    }],

    ['registerTool: registered tool is frozen', () => {
        freshRegistry();
        registerTool({
            name: 'frozen_tool',
            description: 'test',
            parameters: null,
            dangerLevel: DANGER_READ_ONLY,
            handler: async () => 'ok',
            uiLabel: 'Frozen',
            uiIcon: 'test-symbolic',
            command: null,
            resultTruncationKey: null,
            isMeta: false,
            providerScoped: false,
        });
        const tool = lookupTool('frozen_tool');
        // Object.freeze means we can't add new properties
        assertThrows(() => { tool.newProp = 'bad'; }, '', 'frozen object rejects mutation');
    }],

    // ── lookupTool ─────────────────────────────────────────────────────────

    ['lookupTool: found and not found', () => {
        freshRegistry();
        registerTool({
            name: 'findable',
            description: 'test',
            parameters: null,
            dangerLevel: DANGER_READ_ONLY,
            handler: async () => 'ok',
            uiLabel: 'Find',
            uiIcon: 'test-symbolic',
            command: null,
            resultTruncationKey: null,
            isMeta: false,
            providerScoped: false,
        });
        assertEqual(lookupTool('findable').name, 'findable', 'found');
        assertEqual(lookupTool('nonexistent'), undefined, 'not found');
    }],

    // ── getAllToolNames / getAllTools ──────────────────────────────────────

    ['getAllToolNames and getAllTools', () => {
        freshRegistry();
        registerTool({
            name: 'tool_a', description: 'a', parameters: null,
            dangerLevel: DANGER_READ_ONLY, handler: async () => 'a',
            uiLabel: 'A', uiIcon: 'a', command: null,
            resultTruncationKey: null, isMeta: false, providerScoped: false,
        });
        registerTool({
            name: 'tool_b', description: 'b', parameters: null,
            dangerLevel: DANGER_POTENTIALLY_UNSAFE, handler: async () => 'b',
            uiLabel: 'B', uiIcon: 'b', command: null,
            resultTruncationKey: null, isMeta: false, providerScoped: false,
        });

        const names = getAllToolNames();
        assertEqual(names.length, 2, 'two names');
        assert(names.includes('tool_a'), 'tool_a present');
        assert(names.includes('tool_b'), 'tool_b present');

        const tools = getAllTools();
        assertEqual(tools.length, 2, 'two tools');
    }],

    // ── getToolsByDanger ──────────────────────────────────────────────────

    ['getToolsByDanger: filters correctly', () => {
        freshRegistry();
        registerTool({
            name: 'safe', description: 'safe', parameters: null,
            dangerLevel: DANGER_READ_ONLY, handler: async () => 'safe',
            uiLabel: 'Safe', uiIcon: 'safe', command: null,
            resultTruncationKey: null, isMeta: false, providerScoped: false,
        });
        registerTool({
            name: 'unsafe', description: 'unsafe', parameters: null,
            dangerLevel: DANGER_POTENTIALLY_UNSAFE, handler: async () => 'unsafe',
            uiLabel: 'Unsafe', uiIcon: 'unsafe', command: null,
            resultTruncationKey: null, isMeta: false, providerScoped: false,
        });

        const readOnly = getToolsByDanger(DANGER_READ_ONLY);
        assertEqual(readOnly.length, 1, 'one read_only');
        assertEqual(readOnly[0].name, 'safe', 'safe tool matched');

        const unsafe = getToolsByDanger(DANGER_POTENTIALLY_UNSAFE);
        assertEqual(unsafe.length, 1, 'one potentially_unsafe');

        const none = getToolsByDanger('nonexistent');
        assertEqual(none.length, 0, 'no match returns empty');
    }],

    // ── buildAllToolSchemas ────────────────────────────────────────────────

    ['buildAllToolSchemas: openai format', () => {
        freshRegistry();
        registerTool({
            name: 'search_test',
            description: 'Search the web',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string' } },
                required: ['query'],
            },
            dangerLevel: DANGER_READ_ONLY,
            handler: async () => 'ok',
            uiLabel: 'Search',
            uiIcon: 'search',
            command: '/search',
            resultTruncationKey: 'search',
            isMeta: false,
            providerScoped: false,
        });

        const schemas = buildAllToolSchemas('openai');
        assertEqual(schemas.length, 1, 'one schema');
        assertEqual(schemas[0].type, 'function', 'openai type');
        assertEqual(schemas[0].function.name, 'search_test', 'function name');
        assertEqual(schemas[0].function.description, 'Search the web', 'description');
        assertDeepEqual(schemas[0].function.parameters.required, ['query'], 'required params');
    }],

    ['buildAllToolSchemas: anthropic format', () => {
        freshRegistry();
        registerTool({
            name: 'search_test',
            description: 'Search the web',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string' } },
                required: ['query'],
            },
            dangerLevel: DANGER_READ_ONLY,
            handler: async () => 'ok',
            uiLabel: 'Search',
            uiIcon: 'search',
            command: '/search',
            resultTruncationKey: 'search',
            isMeta: false,
            providerScoped: false,
        });

        const schemas = buildAllToolSchemas('anthropic');
        assertEqual(schemas.length, 1, 'one schema');
        assertEqual(schemas[0].name, 'search_test', 'anthropic name field');
        assertEqual(schemas[0].input_schema.type, 'object', 'input_schema');
        assertEqual(schemas[0].type, undefined, 'no type field for anthropic');
    }],

    ['buildAllToolSchemas: skips meta tools and tools without parameters', () => {
        freshRegistry();
        registerTool({
            name: 'meta_tool', description: 'meta', parameters: null,
            dangerLevel: DANGER_READ_ONLY, handler: async () => 'ok',
            uiLabel: 'Meta', uiIcon: 'meta', command: null,
            resultTruncationKey: null, isMeta: true, providerScoped: false,
        });
        registerTool({
            name: 'no_params', description: 'no params', parameters: null,
            dangerLevel: DANGER_READ_ONLY, handler: async () => 'ok',
            uiLabel: 'NoParams', uiIcon: 'np', command: null,
            resultTruncationKey: null, isMeta: false, providerScoped: false,
        });
        registerTool({
            name: 'has_params', description: 'has params',
            parameters: { type: 'object', properties: {} },
            dangerLevel: DANGER_READ_ONLY, handler: async () => 'ok',
            uiLabel: 'HasParams', uiIcon: 'hp', command: null,
            resultTruncationKey: null, isMeta: false, providerScoped: false,
        });

        const schemas = buildAllToolSchemas(); // default openai
        assertEqual(schemas.length, 1, 'only has_params included');
        assertEqual(schemas[0].function.name, 'has_params', 'correct tool');
    }],

    // ── buildToolSchemasFor ────────────────────────────────────────────────

    ['buildToolSchemasFor: subset filtering', () => {
        freshRegistry();
        registerTool({
            name: 'tool_one', description: 'one',
            parameters: { type: 'object', properties: {} },
            dangerLevel: DANGER_READ_ONLY, handler: async () => '1',
            uiLabel: 'One', uiIcon: 'one', command: null,
            resultTruncationKey: null, isMeta: false, providerScoped: false,
        });
        registerTool({
            name: 'tool_two', description: 'two',
            parameters: { type: 'object', properties: {} },
            dangerLevel: DANGER_READ_ONLY, handler: async () => '2',
            uiLabel: 'Two', uiIcon: 'two', command: null,
            resultTruncationKey: null, isMeta: false, providerScoped: false,
        });

        const schemas = buildToolSchemasFor(['tool_one']);
        assertEqual(schemas.length, 1, 'only tool_one');
        assertEqual(schemas[0].function.name, 'tool_one', 'correct');

        const none = buildToolSchemasFor(['nonexistent']);
        assertEqual(none.length, 0, 'nonexistent skipped');
    }],

    ['buildToolSchemasFor: skips meta tools in subset', () => {
        freshRegistry();
        registerTool({
            name: 'meta', description: 'meta', parameters: null,
            dangerLevel: DANGER_READ_ONLY, handler: async () => 'ok',
            uiLabel: 'Meta', uiIcon: 'm', command: null,
            resultTruncationKey: null, isMeta: true, providerScoped: false,
        });
        registerTool({
            name: 'real', description: 'real',
            parameters: { type: 'object', properties: {} },
            dangerLevel: DANGER_READ_ONLY, handler: async () => 'ok',
            uiLabel: 'Real', uiIcon: 'r', command: null,
            resultTruncationKey: null, isMeta: false, providerScoped: false,
        });

        const schemas = buildToolSchemasFor(['meta', 'real']);
        assertEqual(schemas.length, 1, 'meta skipped, real included');
        assertEqual(schemas[0].function.name, 'real', 'correct');
    }],

    // ── clearRegistry ──────────────────────────────────────────────────────

    ['clearRegistry: empties the registry', () => {
        freshRegistry();
        registerTool({
            name: 'temp', description: 'temp', parameters: null,
            dangerLevel: DANGER_READ_ONLY, handler: async () => 'ok',
            uiLabel: 'T', uiIcon: 't', command: null,
            resultTruncationKey: null, isMeta: false, providerScoped: false,
        });
        assertEqual(lookupTool('temp').name, 'temp', 'tool exists');
        clearRegistry();
        assertEqual(lookupTool('temp'), undefined, 'tool gone after clear');
        assertEqual(getAllToolNames().length, 0, 'registry empty');
    }],

    // ── createNotReadyHandler ──────────────────────────────────────────────

    ['createNotReadyHandler: returns async function with error message', async () => {
        const handler = createNotReadyHandler('test_tool');
        assertEqual(typeof handler, 'function', 'returns function');
        // Call it and check the result
        const result = await handler(null, null);
        assert(typeof result === 'string', 'returns string');
        assert(result.includes('test_tool'), 'contains tool name');
        assert(result.includes('not yet wired'), 'contains error message');
    }],
];

await runTests(tests);

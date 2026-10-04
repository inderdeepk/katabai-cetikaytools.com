// chatRequest.test.js — Tests for the streaming request dialect helpers.
import {
    buildOllamaOptions,
    normalizeOllamaKeepAlive,
} from '../src/providers/chatRequest.js';
import { assert, assertEqual, runTests } from './testUtils.js';

function makeGetOpt(values = {}) {
    return (prop, _type) => (prop in values ? values[prop] : null);
}

const tests = [
    ['ollama options: builds the full sampling/context set', () => {
        const options = buildOllamaOptions(makeGetOpt({
            'temperature': 0.7,
            'num-ctx': 8192,
            'num-predict': -1,
            'num-keep': 0,
            'use-mmap': true,
            'use-mlock': false,
            'num-gpu': -1,
            'num-thread': 4,
            'top-k': 40,
            'top-p': 0.9,
            'min-p': 0.05,
            'tfs-z': 1.0,
            'mirostat': 0,
            'mirostat-tau': 5.0,
            'mirostat-eta': 0.1,
            'repeat-last-n': 64,
            'repeat-penalty': 1.1,
            'presence-penalty': 0.0,
            'frequency-penalty': 0.0,
        }));
        assertEqual(Object.keys(options).length, 19, 'all 19 keys present');
        assertEqual(options.temperature, 0.7, 'temperature');
        assertEqual(options.num_ctx, 8192, 'num_ctx');
        assertEqual(options.use_mmap, true, 'use_mmap');
        assertEqual(options.repeat_last_n, 64, 'repeat_last_n unchanged');
    }],

    ['ollama options: null/undefined entries are pruned', () => {
        const options = buildOllamaOptions(makeGetOpt({ 'temperature': 0.5 }));
        assertEqual(Object.keys(options).join(','), 'temperature', 'only set keys remain');
        assert(!('num_ctx' in options), 'unset key removed');
    }],

    ['ollama options: repeat_last_n = -1 translates to num_ctx', () => {
        const options = buildOllamaOptions(makeGetOpt({
            'repeat-last-n': -1,
            'num-ctx': 4096,
        }));
        assertEqual(options.repeat_last_n, 4096, 'translated to num_ctx');
    }],

    ['ollama options: repeat_last_n = -1 falls back to 64 without a usable num_ctx', () => {
        assertEqual(buildOllamaOptions(makeGetOpt({ 'repeat-last-n': -1 })).repeat_last_n, 64, 'no num_ctx');
        assertEqual(buildOllamaOptions(makeGetOpt({ 'repeat-last-n': -1, 'num-ctx': 0 })).repeat_last_n, 64, 'zero num_ctx');
    }],

    ['ollama options: non-negative repeat_last_n preserved (including 0)', () => {
        assertEqual(buildOllamaOptions(makeGetOpt({ 'repeat-last-n': 0, 'num-ctx': 4096 })).repeat_last_n, 0, 'zero kept');
        assertEqual(buildOllamaOptions(makeGetOpt({ 'repeat-last-n': 128 })).repeat_last_n, 128, 'value kept');
    }],

    ['keep_alive: empty and -1 map to the indefinite duration, others pass through', () => {
        assertEqual(normalizeOllamaKeepAlive(''), '999999h', 'empty → indefinite');
        assertEqual(normalizeOllamaKeepAlive('-1'), '999999h', '-1 → indefinite');
        assertEqual(normalizeOllamaKeepAlive(null), '999999h', 'null → indefinite');
        assertEqual(normalizeOllamaKeepAlive('5m'), '5m', 'duration kept');
        assertEqual(normalizeOllamaKeepAlive('999999h'), '999999h', 'indefinite kept');
    }],
];

await runTests(tests);

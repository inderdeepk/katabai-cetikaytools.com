// testUtils.js — Shared test helpers for Katabai extension unit tests
//
// Provides assertion functions, mock factories, and temp-directory helpers so
// every test file can import a single module rather than copying
// assert/assertEqual boilerplate.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// ── Assertions ──────────────────────────────────────────────────────────────

export function assert(condition, message = 'assertion failed') {
    if (!condition) throw new Error(message);
}

export function assertEqual(actual, expected, message = 'assertEqual') {
    if (actual !== expected) {
        throw new Error(
            `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
        );
    }
}

export function assertDeepEqual(actual, expected, message = 'assertDeepEqual') {
    const difference = firstDifference(actual, expected, 'value');
    if (difference) {
        throw new Error(
            `${message}: ${difference}\n  expected: ${stringify(expected)}\n  actual:   ${stringify(actual)}`,
        );
    }
}

// Recursive structural comparison. Chosen over JSON.stringify because stringify
// is key-order sensitive, drops `undefined` properties (so {a: undefined} looked
// equal to {}), and maps NaN/Infinity to null.
function firstDifference(actual, expected, path) {
    if (Object.is(actual, expected)) return '';

    if (typeof actual !== typeof expected) {
        return `${path}: type mismatch (${typeof actual} vs ${typeof expected})`;
    }

    if (actual === null || expected === null || typeof actual !== 'object') {
        return `${path}: expected ${stringify(expected)}, got ${stringify(actual)}`;
    }

    if (Array.isArray(actual) !== Array.isArray(expected)) {
        return `${path}: array/object mismatch`;
    }

    if (Array.isArray(actual)) {
        if (actual.length !== expected.length) {
            return `${path}: array length ${actual.length} vs ${expected.length}`;
        }
        for (let i = 0; i < actual.length; i++) {
            const difference = firstDifference(actual[i], expected[i], `${path}[${i}]`);
            if (difference) return difference;
        }
        return '';
    }

    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = Object.keys(expected).sort();
    if (actualKeys.join('\u0000') !== expectedKeys.join('\u0000')) {
        return `${path}: keys [${actualKeys.join(', ')}] vs [${expectedKeys.join(', ')}]`;
    }
    for (const key of actualKeys) {
        const difference = firstDifference(actual[key], expected[key], `${path}.${key}`);
        if (difference) return difference;
    }
    return '';
}

function stringify(value) {
    try {
        return JSON.stringify(value);
    } catch (_error) {
        return String(value);
    }
}

export function assertThrows(fn, expectedSubstring = '', message = 'assertThrows') {
    let threw = false;
    try {
        fn();
    } catch (e) {
        threw = true;
        if (expectedSubstring && !String(e.message || e).includes(expectedSubstring)) {
            throw new Error(
                `${message}: exception did not contain "${expectedSubstring}". Got: ${e.message || e}`,
            );
        }
    }
    if (!threw) throw new Error(`${message}: expected exception but none was thrown`);
}

// ── Temp directories ─────────────────────────────────────────────────────────

/**
 * Create a unique throwaway directory for filesystem-backed tests. Suites must
 * point their module path seam at this directory and remove it at the end so
 * concurrent runs never share state.
 *
 * @param {string} [prefix]
 * @returns {string} absolute path to the new directory
 */
export function makeTempDir(prefix = 'katabai-test-XXXXXX') {
    const dir = GLib.dir_make_tmp(prefix);
    if (!dir) throw new Error('GLib.dir_make_tmp() returned null');
    return dir;
}

/** Recursively delete a directory created by makeTempDir(). Never throws. */
export function removeTempDir(dirPath) {
    if (!dirPath) return;
    const dir = Gio.File.new_for_path(dirPath);
    const children = [];
    try {
        const enumerator = dir.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE,
            null,
        );
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            children.push([info.get_name(), info.get_file_type()]);
        }
        enumerator.close(null);
    } catch (_e) {
        return;
    }
    for (const [name, fileType] of children) {
        const child = dir.get_child(name);
        if (fileType === Gio.FileType.DIRECTORY) {
            removeTempDir(child.get_path());
        } else {
            try {
                child.delete(null);
            } catch (_e) {
                /* best effort */
            }
        }
    }
    try {
        dir.delete(null);
    } catch (_e) {
        /* best effort */
    }
}

/** Read a UTF-8 text file, returning '' when it does not exist or is unreadable. */
export function readTextFile(filePath) {
    try {
        const [, bytes] = Gio.File.new_for_path(filePath).load_contents(null);
        return new TextDecoder('utf-8').decode(bytes);
    } catch (_e) {
        return '';
    }
}

// ── Mock Factories ───────────────────────────────────────────────────────────

/**
 * Create a mock Gio.Settings-compatible object for testing functions that read
 * from GSettings.  Supports get_string, get_boolean, get_int, get_double.
 * connect() is a no-op (needed by signal wiring but irrelevant for pure tests).
 *
 * @param {Object} overrides — key → value mapping to use as the settings store.
 * @returns {{ get_string, get_boolean, get_int, get_double, connect }}
 */
export function createMockSettings(overrides = {}) {
    const store = { ...overrides };

    const read = (key, fallback) => {
        if (key in store) return store[key];
        if (fallback !== undefined) return fallback;
        return '';
    };

    return {
        get_string: (key) => read(key, ''),
        get_boolean: (key) => read(key, false),
        get_int: (key) => read(key, 0),
        get_double: (key) => read(key, 0.0),
        set_string: (key, val) => {
            store[key] = val;
        },
        set_boolean: (key, val) => {
            store[key] = val;
        },
        set_int: (key, val) => {
            store[key] = val;
        },
        set_double: (key, val) => {
            store[key] = val;
        },
        connect: () => 0,
        // Expose store for direct inspection
        _store: store,
    };
}

/**
 * Create a mock llmCall async function that returns pre-canned responses.
 * Each call consumes the next entry from the `responses` array.
 * If `responses` is empty or exhausted, returns a default response.
 *
 * @param {string[]} responses — successive LLM responses to return.
 * @returns {Function} async (messages, opts) => string
 */
export function createMockLlmCall(responses = []) {
    let index = 0;
    return async (_messages, _opts) => {
        if (index < responses.length) {
            return responses[index++];
        }
        return JSON.stringify([{ claim: 'Default fallback claim.', url: 'https://example.com' }]);
    };
}

/**
 * Run a list of named test cases and report PASS/FAIL.
 *
 * @param {Array<[string, Function]>} tests — [name, () => void] pairs
 */
export async function runTests(tests) {
    let passed = 0;
    let failed = 0;
    for (const [name, run] of tests) {
        try {
            const result = run();
            // Await async tests so their assertions actually run. Previously an
            // async test that threw was counted as PASS because its rejection
            // was never observed by the synchronous try/catch.
            if (result && typeof result.then === 'function') {
                await result;
            }
            console.log(`PASS ${name}`);
            passed++;
        } catch (e) {
            console.log(`FAIL ${name}: ${e.message}`);
            failed++;
        }
    }
    console.log(`${passed} passed, ${failed} failed, ${tests.length} total`);
    if (failed > 0) {
        // GJS: non-zero exit via thrown error
        throw new Error(`${failed} test(s) failed`);
    }
}

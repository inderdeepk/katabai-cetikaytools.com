// testUtils.js — Shared test helpers for Katabai extension unit tests
//
// Provides assertion functions and mock factories so every test file can
// import a single module rather than copying assert/assertEqual boilerplate.

// ── Assertions ──────────────────────────────────────────────────────────────

export function assert(condition, message = 'assertion failed') {
    if (!condition) throw new Error(message);
}

export function assertEqual(actual, expected, message = 'assertEqual') {
    if (actual !== expected) {
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

export function assertDeepEqual(actual, expected, message = 'assertDeepEqual') {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
        throw new Error(`${message}: expected ${b}, got ${a}`);
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
                `${message}: exception did not contain "${expectedSubstring}". Got: ${e.message || e}`
            );
        }
    }
    if (!threw) throw new Error(`${message}: expected exception but none was thrown`);
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
        get_string: key => read(key, ''),
        get_boolean: key => read(key, false),
        get_int: key => read(key, 0),
        get_double: key => read(key, 0.0),
        set_string: (key, val) => { store[key] = val; },
        set_boolean: (key, val) => { store[key] = val; },
        set_int: (key, val) => { store[key] = val; },
        set_double: (key, val) => { store[key] = val; },
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
export function runTests(tests) {
    let passed = 0;
    let failed = 0;
    for (const [name, run] of tests) {
        try {
            run();
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

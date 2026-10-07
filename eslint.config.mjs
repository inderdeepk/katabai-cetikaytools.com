// ESLint flat config for the Katab GNOME Shell extension.
//
// The codebase runs in GJS (not Node/browser), so the global set below is the
// GJS runtime surface used across shell, preferences, and test files.  The
// rule set is deliberately conservative — correctness rules only; stylistic
// concerns belong to Prettier, and `eslint-config-prettier` (last) turns off
// everything that could conflict with the formatter.
import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';

const gjsGlobals = {
    // GJS console helpers.
    log: 'readonly',
    logError: 'readonly',
    print_exception: 'readonly',
    printerr: 'readonly',
    print: 'readonly',
    // GJS legacy import machinery (still referenced in comments/tests).
    imports: 'readonly',
    // Environment.
    global: 'readonly',
    console: 'readonly',
    TextDecoder: 'readonly',
    TextEncoder: 'readonly',
    URL: 'readonly',
    URLSearchParams: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    setInterval: 'readonly',
    clearInterval: 'readonly',
};

export default [
    {
        ignores: [
            'node_modules/**',
            'schemas/**',
            'icons/**',
            'sprites/**',
            'Documentation/**',
            'rag-service/**',
        ],
    },
    {
        files: [
            'extension.js',
            'prefs.js',
            'src/**/*.js',
            'scripts/**/*.js',
            'scripts/**/*.mjs',
            'tests/**/*.js',
        ],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: gjsGlobals,
        },
        rules: {
            ...js.configs.recommended.rules,
            eqeqeq: ['error', 'always', { null: 'ignore' }],
            'no-unused-vars': [
                'error',
                {
                    args: 'none',
                    caughtErrors: 'none',
                    ignoreRestSiblings: true,
                },
            ],
            'no-redeclare': 'error',
            'no-empty': ['error', { allowEmptyCatch: true }],
            'no-constant-condition': ['error', { checkLoops: false }],
        },
    },
    {
        // Node-only check scripts (not part of the GJS runtime).
        files: [
            'scripts/check-css.mjs',
            'scripts/i18n-extract.mjs',
            'scripts/audits/**/*.js',
            'scripts/audits/**/*.mjs',
        ],
        languageOptions: {
            globals: { process: 'readonly', console: 'readonly' },
        },
    },
    prettierConfig,
];

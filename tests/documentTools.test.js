// documentTools.test.js — Tests for document command parsing & prompt builders
import {
    parseDocumentCommand,
    resolveDocumentPath,
    buildDocumentPromptBlock,
    buildMissingDocumentPromptBlock,
    buildMissingImagePromptBlock,
    buildVisionAnalysisPromptBlock,
    getDocumentToolCapabilities,
    DOCUMENT_TOOL_COMMAND,
    DOCUMENT_TOOL_MAX_CHARS,
} from '../src/tools/documentTools.js';
import { assert, assertEqual, assertThrows, runTests } from './testUtils.js';

const tests = [
    // ── parseDocumentCommand ───────────────────────────────────────────────

    ['parseDocumentCommand: /doc alone opens picker', () => {
        const result = parseDocumentCommand('/doc');
        assert(result.isCommand, 'is command');
        assert(result.needsPicker, 'needs picker');
        assertEqual(result.filePath, null, 'no file path');
        assertEqual(result.promptText, '', 'no prompt text');
    }],

    ['parseDocumentCommand: /doc "path/to/file"', () => {
        const result = parseDocumentCommand('/doc "/home/user/file.txt"');
        assert(result.isCommand, 'is command');
        assert(!result.needsPicker, 'does not need picker');
        assertEqual(result.filePath, '/home/user/file.txt', 'path extracted');
        assertEqual(result.promptText, '', 'no remaining prompt');
    }],

    ['parseDocumentCommand: /doc "path" with additional prompt text', () => {
        const result = parseDocumentCommand('/doc "/tmp/file.txt" summarize this document');
        assertEqual(result.filePath, '/tmp/file.txt', 'path extracted');
        assertEqual(result.promptText, 'summarize this document', 'prompt extracted');
    }],

    ['parseDocumentCommand: /doc "path with spaces"', () => {
        const result = parseDocumentCommand('/doc "/path/with spaces/file.md"');
        assertEqual(result.filePath, '/path/with spaces/file.md', 'spaces in path');
    }],

    ['parseDocumentCommand: /doc without quotes defaults to picker', () => {
        const result = parseDocumentCommand('/doc some text');
        assert(result.isCommand, 'is command');
        assert(result.needsPicker, 'needs picker without quotes');
        assertEqual(result.promptText, 'some text', 'remaining becomes prompt');
    }],

    ['parseDocumentCommand: escaped quotes in path', () => {
        const result = parseDocumentCommand('/doc "/path/with/\\"quotes\\"/file.txt"');
        assert(result.filePath.includes('"quotes"'), 'escaped quotes handled');
    }],

    ['parseDocumentCommand: unclosed quote throws', () => {
        assertThrows(
            () => parseDocumentCommand('/doc "/unclosed path'),
            'tell the document path apart',
            'unclosed quote'
        );
    }],

    ['parseDocumentCommand: not a /doc command', () => {
        assertEqual(parseDocumentCommand('regular message'), null, 'not a command');
        assertEqual(parseDocumentCommand(''), null, 'empty');
        assertEqual(parseDocumentCommand(null), null, 'null');
    }],

    // ── resolveDocumentPath ────────────────────────────────────────────────

    ['resolveDocumentPath: tilde expansion', () => {
        const result = resolveDocumentPath('~/Documents/file.txt');
        assert(result !== null, 'result exists');
        assert(!result.startsWith('~'), 'tilde expanded');
        assert(result.endsWith('/Documents/file.txt'), 'path preserved');
    }],

    ['resolveDocumentPath: bare tilde', () => {
        const result = resolveDocumentPath('~');
        assert(result !== null, 'bare tilde expands to home');
        assert(!result.includes('~'), 'no tilde in result');
    }],

    ['resolveDocumentPath: absolute path preserved', () => {
        const result = resolveDocumentPath('/usr/share/doc/README');
        assertEqual(result, '/usr/share/doc/README', 'absolute path unchanged');
    }],

    ['resolveDocumentPath: null/empty returns null', () => {
        assertEqual(resolveDocumentPath(null), null, 'null → null');
        assertEqual(resolveDocumentPath(''), null, 'empty → null');
        assertEqual(resolveDocumentPath('  '), null, 'whitespace → null');
    }],

    // ── buildDocumentPromptBlock ───────────────────────────────────────────

    ['buildDocumentPromptBlock: standard document', () => {
        const block = buildDocumentPromptBlock({
            displayName: 'README.md',
            path: '/home/user/README.md',
            parserName: 'Gio.File',
            text: '# Hello World\n\nThis is a test.',
            truncated: false,
        });
        assert(block.includes('README.md'), 'display name');
        assert(block.includes('/home/user/README.md'), 'source path');
        assert(block.includes('Gio.File'), 'parser name');
        assert(block.includes('# Hello World'), 'content');
    }],

    ['buildDocumentPromptBlock: truncated document', () => {
        const block = buildDocumentPromptBlock({
            displayName: 'large.txt',
            path: '/tmp/large.txt',
            parserName: 'Gio.File',
            text: 'content',
            truncated: true,
        });
        assert(block.includes('truncated'), 'truncation note');
    }],

    // ── buildMissingDocumentPromptBlock ────────────────────────────────────

    ['buildMissingDocumentPromptBlock: with display name', () => {
        const block = buildMissingDocumentPromptBlock({ displayName: 'notes.txt', path: '/tmp/notes.txt' });
        assert(block.includes('notes.txt'), 'display name used');
        assert(block.includes('Reattach'), 'reattach instruction');
    }],

    ['buildMissingDocumentPromptBlock: fallback to path', () => {
        const block = buildMissingDocumentPromptBlock({ path: '/tmp/notes.txt' });
        assert(block.includes('/tmp/notes.txt'), 'path used as fallback');
    }],

    // ── buildMissingImagePromptBlock ───────────────────────────────────────

    ['buildMissingImagePromptBlock: with display name', () => {
        const block = buildMissingImagePromptBlock({ displayName: 'screenshot.png' });
        assert(block.includes('screenshot.png'), 'display name');
        assert(block.includes('Previously attached image'), 'image context');
    }],

    // ── buildVisionAnalysisPromptBlock ────────────────────────────────────

    ['buildVisionAnalysisPromptBlock: with analysis and model', () => {
        const block = buildVisionAnalysisPromptBlock(
            'The image shows a terminal window with code.',
            'llama3.2-vision'
        );
        assert(block.includes('llama3.2-vision'), 'model name included');
        assert(block.includes('terminal window'), 'analysis text included');
        assert(block.includes('Vision analysis'), 'vision label');
    }],

    ['buildVisionAnalysisPromptBlock: empty analysis', () => {
        const block = buildVisionAnalysisPromptBlock('', 'ollama-vision');
        assert(block.includes('unavailable'), 'unavailable message');
    }],

    ['buildVisionAnalysisPromptBlock: empty analysis returns unavailable', () => {
        const block = buildVisionAnalysisPromptBlock('', 'test-model');
        assert(block.includes('unavailable'), 'empty string → unavailable');
    }],

    // ── getDocumentToolCapabilities ────────────────────────────────────────

    ['getDocumentToolCapabilities: built-in capabilities always available', () => {
        const caps = getDocumentToolCapabilities();
        assert(caps.text.available, 'text always available');
        assert(caps.image.available, 'image always available');
        assertEqual(caps.text.status, 'builtin', 'text is builtin');
        assertEqual(caps.image.status, 'builtin', 'image is builtin');
    }],

    ['getDocumentToolCapabilities: all capability keys present', () => {
        const caps = getDocumentToolCapabilities();
        const expectedKeys = ['text', 'image', 'pdf', 'docx'];
        for (const key of expectedKeys) {
            assert(caps[key] !== undefined, `${key} capability exists`);
            assert(typeof caps[key].label === 'string', `${key} has label`);
            assert(typeof caps[key].available === 'boolean', `${key} has available flag`);
        }
    }],

    // ── Constants ──────────────────────────────────────────────────────────

    ['document tools: constants defined', () => {
        assertEqual(DOCUMENT_TOOL_COMMAND, '/doc', 'command constant');
        assertEqual(typeof DOCUMENT_TOOL_MAX_CHARS, 'number', 'max chars is number');
        assert(DOCUMENT_TOOL_MAX_CHARS > 0, 'max chars positive');
    }],
];

await runTests(tests);

// providersCatalog.test.js — Guards the shared provider catalog.
import GLib from 'gi://GLib';
import {
    PROVIDER_META,
    PROVIDER_LABELS,
    PROVIDER_ICON_STYLE_CLASSES,
    PROVIDER_ACCENT_CLASSES,
    PROVIDER_DETAILS,
    DEEPSEEK_MODELS,
} from '../src/providers/catalog.js';
import { assert, assertEqual, runTests } from './testUtils.js';

function repoPath(...parts) {
    const candidates = [];
    try {
        if (import.meta && import.meta.url) {
            const [modulePath] = GLib.filename_from_uri(import.meta.url);
            const repoRoot = GLib.path_get_dirname(GLib.path_get_dirname(modulePath));
            candidates.push(GLib.build_filenamev([repoRoot, ...parts]));
        }
    } catch (_e) {
        // fall through to cwd
    }
    candidates.push(GLib.build_filenamev([GLib.get_current_dir(), ...parts]));
    for (const candidate of candidates) {
        if (GLib.file_test(candidate, GLib.FileTest.EXISTS)) {
            return candidate;
        }
    }
    return candidates[0];
}

const tests = [
    ['meta: all five providers present with labels and icon files', () => {
        const providers = Object.keys(PROVIDER_META).sort();
        assertEqual(providers.join(','), 'anthropic,deepseek,ollama,openai,unsloth', 'provider set');
        for (const [provider, meta] of Object.entries(PROVIDER_META)) {
            assert(meta.label && meta.label.length > 0, `${provider} label`);
            assert(meta.iconFile && /\.[a-z]+$/i.test(meta.iconFile), `${provider} iconFile`);
        }
    }],

    ['meta: every icon file actually exists in icons/', () => {
        for (const [provider, meta] of Object.entries(PROVIDER_META)) {
            const path = repoPath('icons', meta.iconFile);
            assert(GLib.file_test(path, GLib.FileTest.EXISTS),
                `${provider} icon missing: ${path}`);
        }
    }],

    ['labels: derived from meta and complete', () => {
        assertEqual(Object.keys(PROVIDER_LABELS).sort().join(','), Object.keys(PROVIDER_META).sort().join(','), 'keys match');
        assertEqual(PROVIDER_LABELS.anthropic, 'Anthropic', 'extension label');
        assertEqual(PROVIDER_LABELS.unsloth, 'Unsloth Studio', 'unsloth label');
    }],

    ['style classes: derived from meta keys', () => {
        assertEqual(PROVIDER_ICON_STYLE_CLASSES[0], 'katab-provider-icon-ollama', 'icon class');
        assert(PROVIDER_ICON_STYLE_CLASSES.includes('katab-provider-icon-anthropic'), 'anthropic icon class');
        assertEqual(PROVIDER_ACCENT_CLASSES.length, 5, 'five accent classes');
        assert(PROVIDER_ACCENT_CLASSES.includes('katab-accent-deepseek'), 'deepseek accent class');
    }],

    ['deepseek models: unique ids, required fields, legacy alias present', () => {
        const ids = DEEPSEEK_MODELS.map(m => m.id);
        assertEqual(new Set(ids).size, ids.length, 'ids unique');
        assert(ids.includes('deepseek-flash') && ids.includes('deepseek-v4-pro') && ids.includes('deepseek-v4-flash'),
            'expected model ids present');
        for (const model of DEEPSEEK_MODELS) {
            assert(model.label && model.description, `${model.id} has label + description`);
        }
    }],

    ['details: preferences copy preserved (incl. Anthropic Claude override)', () => {
        assertEqual(Object.keys(PROVIDER_DETAILS).sort().join(','), Object.keys(PROVIDER_META).sort().join(','), 'keys match meta');
        for (const [provider, detail] of Object.entries(PROVIDER_DETAILS)) {
            assert(detail.pageTitle && detail.pageTitle.length > 0, `${provider} pageTitle`);
            assert(detail.description && detail.description.length > 20, `${provider} description`);
            assertEqual(detail.iconFile, PROVIDER_META[provider].iconFile, `${provider} icon shared with meta`);
        }
        assertEqual(PROVIDER_DETAILS.anthropic.label, 'Anthropic Claude', 'prefs label override kept');
        assertEqual(PROVIDER_DETAILS.ollama.label, 'Ollama', 'plain label passthrough');
        assertEqual(PROVIDER_DETAILS.unsloth.pageTitle, 'Unsloth', 'page title differs from label as before');
    }],
];

await runTests(tests);

// Fidelity audit — ported from /tmp during the audit-rescue pass (Phase 1).
// Baseline: git fc4f882:extension.js, loaded via ./lib.js (skips on shallow clones).
// Run from the repository root (`make audit`).
// Fidelity audit: header bar extraction (extension.js -> src/ui/headerBar.js)
import fs from 'node:fs';
import { loadBaseline } from './lib.js';

const OLD = loadBaseline('fc4f882');
const MOD = fs.readFileSync('src/ui/headerBar.js', 'utf8');
const NEW = fs.readFileSync('extension.js', 'utf8');

function extractMethod(src, name) {
    const re = new RegExp(`^    (?:async )?${name}\\(`, 'm');
    const m = re.exec(src);
    if (!m) return null;
    const lineEnd = src.indexOf('\n', m.index);
    const line = src.slice(m.index, lineEnd);
    if (!line.trimEnd().endsWith('{')) return null;
    const start = m.index + line.trimEnd().length;
    let depth = 1;
    let i = start;
    while (i < src.length && depth > 0) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        i++;
    }
    return src.slice(start, i - 1);
}

function extractFunction(src, signature) {
    const i = src.indexOf(signature);
    if (i === -1) return null;
    const start = i + signature.length;
    let depth = 1;
    let j = start;
    while (j < src.length && depth > 0) {
        const c = src[j];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        j++;
    }
    return src.slice(start, j - 1);
}

const SUBS = [
    [/this\.contentLayout\.add_child\(headerBox\)/g, 'host.addToContentLayout(headerBox)'],
    [/this\._extension\.path/g, 'host.extensionPath'],
    [/this\._currentProvider/g, 'host.getCurrentProvider()'],
    [/createProviderIcon\(/g, 'host.createProviderIcon('],
    [/(?<!\.)getProviderLabel\(/g, 'host.getProviderLabel('],
    [/this\._toggleProviderPicker\(\)/g, 'host.toggleProviderPicker()'],
    [/this\._togglePresetPicker\(\)/g, 'host.togglePresetPicker()'],
    [/this\._toggleDeepseekModelPicker\(\)/g, 'host.toggleDeepseekModelPicker()'],
    [/this\._toggleUsagePanel\(\)/g, 'host.toggleUsagePanel()'],
    [/this\._ensureRecentChats\(\);/g, ''],
    [/this\._recentChats\.noteTriggerEnter\(\);?/g, 'host.recentChatsEnter();'],
    [/this\._recentChats\.noteTriggerLeave\(\);?/g, 'host.recentChatsLeave();'],
    [/this\._hideRecentChatsPopup\(\);/g, 'host.hideRecentChatsPopup();'],
    [/this\._toggleHistoryView\(\)/g, 'host.toggleHistoryView()'],
    [/this\._newChat\(\)/g, 'host.newChat()'],
    [/this\._extension\.showPreferences\(\);/g, 'host.openPreferences();'],
    [/this\.close\(\);/g, ''],
    [/=> this\.close\(\)/g, '=> host.closeDialog()'],
    // Widget field renames (Label variants before base names).
    [/this\._cacheSavingsChipLabel/g, 'widgets.cacheSavingsChipLabel'],
    [/this\._cacheSavingsChip/g, 'widgets.cacheSavingsChip'],
    [/this\._providerStatusBox/g, 'widgets.providerStatusBox'],
    [/this\._providerStatusIcon/g, 'widgets.providerStatusIcon'],
    [/this\._providerStatusLabel/g, 'widgets.providerStatusLabel'],
    [/this\._providerStatusText/g, 'widgets.providerStatusText'],
    [/this\._balanceLabel/g, 'widgets.balanceLabel'],
    [/this\._presetBtnLabel/g, 'widgets.presetBtnLabel'],
    [/this\._presetBtn/g, 'widgets.presetBtn'],
    [/this\._deepseekModelBtnLabel/g, 'widgets.deepseekModelBtnLabel'],
    [/this\._deepseekModelBtn/g, 'widgets.deepseekModelBtn'],
    [/this\._usageBtn/g, 'widgets.usageBtn'],
    [/this\._headerPetBox/g, 'widgets.headerPetBox'],
    [/this\._headerPetSprite/g, 'widgets.headerPetSprite'],
    [/this\._headerPetFallback/g, 'widgets.headerPetFallback'],
    [/this\._historyBtn/g, 'widgets.historyBtn'],
];

function flat(text) {
    let out = [];
    let inBlockComment = false;
    for (let rawLine of text.split('\n')) {
        let line = rawLine;
        if (inBlockComment) {
            const end = line.indexOf('*/');
            if (end === -1) continue;
            line = line.slice(end + 2);
            inBlockComment = false;
        }
        line = line.replace(/\/\*.*?\*\//g, '');
        const bc = line.indexOf('/*');
        if (bc !== -1) {
            inBlockComment = true;
            line = line.slice(0, bc);
        }
        line = line.replace(/\s+/g, ' ').trim();
        if (line) out.push(line);
    }
    return out
        .join(' ')
        .replace(/\s+/g, '')
        .replace(/,(?=[)\]}])/g, '')
        .replace(/─+/g, '─')
        .replace(/═+/g, '═');
}

const WIDGETS = [
    'cacheSavingsChip',
    'cacheSavingsChipLabel',
    'providerStatusBox',
    'providerStatusIcon',
    'providerStatusLabel',
    'providerStatusText',
    'balanceLabel',
    'presetBtn',
    'presetBtnLabel',
    'deepseekModelBtn',
    'deepseekModelBtnLabel',
    'usageBtn',
    'headerPetBox',
    'headerPetSprite',
    'headerPetFallback',
    'historyBtn',
];

let fails = 0;

// 1. Body equivalence.
const oldBody = extractMethod(OLD, '_buildHeaderBar');
const modBody = extractFunction(MOD, 'export function buildHeaderBar(host) {');
if (oldBody === null || modBody === null) {
    console.log(`!! MISSING bodies (old=${!!oldBody} mod=${!!modBody})`);
    fails++;
} else {
    let expected = oldBody;
    for (const [re, repl] of SUBS) expected = expected.replace(re, repl);
    const a = flat(expected);
    let b = flat(modBody);
    // New preamble + epilogue: the widgets object the module returns.
    b = b.replace('constwidgets={};', '').replace('returnwidgets;', '');
    if (a === b) {
        console.log('OK  _buildHeaderBar -> buildHeaderBar body');
    } else {
        fails++;
        console.log('DIFF _buildHeaderBar -> buildHeaderBar body');
        let lo = 0;
        const lim = Math.min(a.length, b.length);
        while (lo < lim && a[lo] === b[lo]) lo++;
        console.log(`  at ${lo}: ...${a.slice(Math.max(0, lo - 90), lo + 90)}`);
        console.log(`      vs: ...${b.slice(Math.max(0, lo - 90), lo + 90)}`);
    }
}

// 2. Module must return the widgets object.
if (!MOD.includes('return widgets;')) {
    console.log('!! module does not return widgets');
    fails++;
}

// 3. Wrapper must re-attach every widget ref to the dialog field.
const wrapperIdx = NEW.indexOf('    _buildHeaderBar() {');
const wrapperSeg = wrapperIdx === -1 ? '' : NEW.slice(wrapperIdx, wrapperIdx + 1400);
for (const name of WIDGETS) {
    if (!wrapperSeg.includes(`this._${name} = widgets.${name};`)) {
        console.log(`!! WRAPPER MISSING REF: this._${name}`);
        fails++;
    }
}

// 4. Host bag must carry every callback.
const hostIdx = NEW.indexOf('    _buildHeaderHost() {');
const hostSeg = hostIdx === -1 ? '' : NEW.slice(hostIdx, hostIdx + 1400);
for (const key of [
    'addToContentLayout',
    'extensionPath',
    'getCurrentProvider',
    'createProviderIcon',
    'getProviderLabel',
    'toggleProviderPicker',
    'togglePresetPicker',
    'toggleDeepseekModelPicker',
    'toggleUsagePanel',
    'recentChatsEnter',
    'recentChatsLeave',
    'hideRecentChatsPopup',
    'toggleHistoryView',
    'newChat',
    'closeDialog',
    'openPreferences',
]) {
    if (!hostSeg.includes(`${key}:`)) {
        console.log(`!! HOST BAG MISSING: ${key}`);
        fails++;
    }
}

// 5. Residual: header widget construction must be gone from extension.js.
for (const p of [
    /let headerBox = new St\.BoxLayout/,
    /titleWrapper/,
    /katab-logo-icon/,
    /this\._providerStatusBox = new St\.BoxLayout/,
    /this\._cacheSavingsChip = new St\.BoxLayout/,
    /this\._historyBtn = new St\.BoxLayout/,
    /katab-new-chat-btn/,
    /this\._toggleDeepseekModelPicker\(\);$/m,
]) {
    if (p.test(NEW)) {
        console.log(`!! RESIDUAL in extension.js: ${p}`);
        fails++;
    }
}

// 6. Button handlers must route through host in the module.
for (const wire of [
    'host.toggleProviderPicker();',
    'host.togglePresetPicker();',
    'host.toggleDeepseekModelPicker();',
    'host.toggleUsagePanel();',
    'host.recentChatsEnter();',
    'host.recentChatsLeave();',
    'host.hideRecentChatsPopup();',
    'host.toggleHistoryView();',
    'host.newChat()',
    'host.openPreferences();',
    'host.closeDialog()',
]) {
    if (!MOD.includes(wire)) {
        console.log(`!! MODULE MISSING WIRE: ${wire}`);
        fails++;
    }
}

console.log(fails === 0 ? '\nFIDELITY: PASS' : `\nFIDELITY: ${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);

// Fidelity audit — ported from /tmp during the audit-rescue pass (Phase 1).
// Baseline: git fc4f882:extension.js, loaded via ./lib.js (skips on shallow clones).
// Run from the repository root (`make audit`).
// Fidelity audit: picker extraction (extension.js -> src/ui/pickers.js)
import fs from 'node:fs';
import { loadBaseline } from './lib.js';

const OLD = loadBaseline('fc4f882');
const MOD = fs.readFileSync('src/ui/pickers.js', 'utf8');
const NEW = fs.readFileSync('extension.js', 'utf8');
const SMOKE = fs.readFileSync('scripts/import-smoke.js', 'utf8');

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

const SUBS = [
    // Multi-line host extractions first.
    [
        /let states = \{\};\s*try \{\s*states = this\._extension\.providerHealthMonitor\?\.getAllStates\(\) \|\| \{\};\s*\} catch \(e\) \{\s*states = \{\};\s*\}/,
        'const states = this._host.getProviderHealthStates();',
    ],
    [
        /try \{\s*this\._extension\.providerHealthMonitor\?\.refreshAll\(\{ immediate: true \}\);\s*\} catch \(e\) \{\s*logError\(e, 'Katab: provider health refresh failed'\);\s*\}/,
        'this._host.refreshProviderHealth();',
    ],
    [
        /if \(!this\._deepseekModelBtn\) return;/g,
        'const btn = this._host.getDeepseekModelButton();\n        if (!btn) return;',
    ],
    [/this\._deepseekModelBtn\.visible/g, 'btn.visible'],
    [
        /this\._deepseekModelBtnLabel\.set_text\(/g,
        'this._host.getDeepseekModelButtonLabel().set_text(',
    ],
    // Method call renames.
    [/this\._buildPickerShell\(/g, 'this.buildShell('],
    [/this\._providerPickerListBox/g, 'this._providerListBox'],
    [/this\._deepseekModelListBox/g, 'this._deepseekListBox'],
    [/this\._togglePresetPicker\(\)/g, 'this.togglePresetPicker()'],
    [/this\._refreshPresetPicker\(\)/g, 'this.refreshPresetPicker()'],
    [/this\._refreshProviderPicker\(\)/g, 'this.refreshProviderPicker()'],
    [/this\._refreshDeepseekModelPicker\(\)/g, 'this.refreshDeepseekModelPicker()'],
    [/this\._updateDeepseekModelButton\(\)/g, 'this.updateDeepseekModelButton()'],
    // Dialog accesses become host calls.
    [/this\._settings/g, 'this._host.settings'],
    [/this\._currentProvider/g, 'this._host.getCurrentProvider()'],
    [/this\._extension\.path/g, 'this._host.extensionPath'],
    [/const icon = createProviderIcon\(/g, 'const icon = this._host.createProviderIcon('],
    [/getProviderStatusText\(state\.status\)/g, 'this._host.getProviderStatusText(state.status)'],
    [
        /syncProviderAccentClasses\(row, accentProvider\);/g,
        'this._host.syncProviderAccentClasses(row, accentProvider);',
    ],
    [
        /syncProviderStatusClasses\(statusLabel, status\.status\);/g,
        'this._host.syncProviderStatusClasses(statusLabel, status.status);',
    ],
    [/this\._showChatView\(\)/g, 'this._host.showChatView()'],
    [/this\._openAuxPanel\(/g, 'this._host.openAuxPanel('],
    [/this\._applyPreset\(preset\)/g, 'this._host.applyPreset(preset)'],
    [/this\._addSystemMessage\(/g, 'this._host.addSystemMessage('],
    [/this\._updatePresetButton\(\)/g, 'this._host.updatePresetButton()'],
];

const NEW_A11Y = [
    'accessible_name:title,accessible_role:Clutter.AccessibleRole.PUSH_BUTTON',
    "accessible_name:'Toolsandtoggles'",
    "accessible_name:'Openchat'",
    "accessible_name:'Deletechat'",
    "accessible_name:'Deleteconversation'",
    "accessible_name:'Closesessioninfo'",
    "accessible_name:'Closetoolspanel'",
    "accessible_name:'Closepicker'",
    "accessible_name:'Closepresetlist'",
    "accessible_name:'Togglesourcelist'",
    "accessible_name:'Cachesavingsdetails'",
    "accessible_name:'Knowledgebaseusage'",
    'accessible_name:`Deletepreset"${preset.name}"`',
    'accessible_name:this._host.getToolButtonLabel(tool)',
    "accessible_name:entry.companion?.name||'Petcompanion'",
    'accessible_name:range.label',
    'accessible_role:Clutter.AccessibleRole.PUSH_BUTTON',
];
function stripA11y(s) {
    for (const frag of NEW_A11Y) s = s.split(frag).join('');
    s = s.replace(/_\('[^']*'\)/g, (m) => m.slice(2, -1));
    return s
        .replace(/,,+/g, ',')
        .replace(/,([)}\]])/g, '$1')
        .replace(/\{,/g, '{');
}

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

const PAIRS = [
    ['_togglePresetPicker', 'togglePresetPicker'],
    ['_refreshPresetPicker', 'refreshPresetPicker'],
    ['_buildPresetPicker', 'buildPresetPicker'],
    ['_buildPickerShell', 'buildShell'],
    ['_createSelectionRow', '_createSelectionRow'],
    ['_buildProviderPicker', 'buildProviderPicker'],
    ['_refreshProviderPicker', 'refreshProviderPicker'],
    ['_selectProvider', '_selectProvider'],
    ['_toggleProviderPicker', 'toggleProviderPicker'],
    ['_buildDeepseekModelPicker', 'buildDeepseekModelPicker'],
    ['_refreshDeepseekModelPicker', 'refreshDeepseekModelPicker'],
    ['_selectDeepseekModel', '_selectDeepseekModel'],
    ['_toggleDeepseekModelPicker', 'toggleDeepseekModelPicker'],
    ['_updateDeepseekModelButton', 'updateDeepseekModelButton'],
    ['_getProviderModelSummary', '_getProviderModelSummary'],
];

// Module-only additions (constructor wiring) that the audit ignores.
const REMOVE_FROM_NEW = [
    'this._providerPicker=picker;',
    'this._deepseekModelPicker=picker;',
    'this._presetPicker=picker;',
];

let fails = 0;

// 1. Body equivalence for every moved method.
for (const [oldName, newName] of PAIRS) {
    const oldBody = extractMethod(OLD, oldName);
    const modBody = extractMethod(MOD, newName);
    if (oldBody === null || modBody === null) {
        console.log(`!! MISSING body ${oldName} -> ${newName} (old=${!!oldBody} mod=${!!modBody})`);
        fails++;
        continue;
    }
    let expected = oldBody;
    for (const [re, repl] of SUBS) expected = expected.replace(re, repl);
    let a = flat(expected);
    let b = flat(modBody);
    b = stripA11y(b);
    for (const frag of REMOVE_FROM_NEW) b = b.replace(frag, '');
    if (a === b) {
        console.log(`OK  ${oldName} -> ${newName}`);
    } else {
        fails++;
        console.log(`DIFF ${oldName} -> ${newName}`);
        let lo = 0;
        const lim = Math.min(a.length, b.length);
        while (lo < lim && a[lo] === b[lo]) lo++;
        console.log(`  at ${lo}: ...${a.slice(Math.max(0, lo - 90), lo + 90)}`);
        console.log(`      vs: ...${b.slice(Math.max(0, lo - 90), lo + 90)}`);
    }
}

// 2. Residual: moved code must be gone from extension.js.
// The host bag legitimately keeps the dialog-side provider-health accessors.
const hostIdxAll = NEW.indexOf('    _buildPickersHost() {');
const NEW_NO_HOST =
    hostIdxAll === -1 ? NEW : NEW.slice(0, hostIdxAll) + NEW.slice(hostIdxAll + 1900);
for (const p of [
    /No presets saved yet/,
    /katab-preset-picker-scroll/,
    /_createSelectionRow/,
    /DEEPSEEK_MODELS/,
    /\bdeletePreset\b/,
    /_providerPickerListBox|_deepseekModelListBox|_presetListBox/,
    /_getProviderModelSummary/,
    /_selectDeepseekModel/,
    /_refreshDeepseekModelPicker/,
    /_refreshPresetPicker/,
]) {
    if (p.test(NEW_NO_HOST)) {
        console.log(`!! RESIDUAL in extension.js: ${p}`);
        fails++;
    }
}
// Provider-health monitor access (getAllStates/refreshAll) must exist ONLY
// inside the host bag. NOTE: the monitor class defines its own getAllStates
// method — match only the dialog-side `providerHealthMonitor?.` accessors.
for (const p of [/providerHealthMonitor\?\.getAllStates/, /providerHealthMonitor\?\.refreshAll/]) {
    const idx = NEW.search(p);
    if (idx === -1) {
        console.log(`!! host bag lost the dialog-side accessor: ${p}`);
        fails++;
    } else if (idx < hostIdxAll || idx >= hostIdxAll + 1900) {
        console.log(`!! provider-health access outside the host bag: ${p}`);
        fails++;
    }
}

// 3. Wrappers must delegate to the module.
for (const wire of [
    'this._pickers?.togglePresetPicker();',
    'this._pickers.buildPresetPicker();',
    'this._pickers.buildShell(titleText);',
    'this._pickers.buildProviderPicker();',
    'this._pickers?.refreshProviderPicker();',
    'this._pickers?.toggleProviderPicker();',
    'this._pickers.buildDeepseekModelPicker();',
    'this._pickers?.toggleDeepseekModelPicker();',
    'this._pickers?.updateDeepseekModelButton();',
    'new Pickers(this._buildPickersHost());',
]) {
    if (!NEW.includes(wire)) {
        console.log(`!! WRAPPER MISSING: ${wire}`);
        fails++;
    }
}

// 4. Host bag must carry every dialog dependency.
const hostIdx = NEW.indexOf('    _buildPickersHost() {');
const hostSeg = hostIdx === -1 ? '' : NEW.slice(hostIdx, hostIdx + 1900);
for (const key of [
    'settings',
    'showChatView',
    'openAuxPanel',
    'applyPreset',
    'addSystemMessage',
    'updatePresetButton',
    'getCurrentProvider',
    'createProviderIcon',
    'getProviderStatusText',
    'syncProviderAccentClasses',
    'syncProviderStatusClasses',
    'getProviderHealthStates',
    'refreshProviderHealth',
    'getDeepseekModelButton',
    'getDeepseekModelButtonLabel',
]) {
    if (!hostSeg.includes(`${key}:`)) {
        console.log(`!! HOST BAG MISSING: ${key}`);
        fails++;
    }
}

// 5. Module must route everything through the host.
for (const wire of [
    'this._host.showChatView();',
    'this._host.openAuxPanel(',
    'this._host.settings',
    'this._host.getCurrentProvider()',
    'this._host.createProviderIcon(',
    'this._host.getProviderStatusText(',
    'this._host.syncProviderAccentClasses(',
    'this._host.syncProviderStatusClasses(',
    'this._host.getProviderHealthStates()',
    'this._host.refreshProviderHealth()',
    'this._host.applyPreset(',
    'this._host.addSystemMessage(',
    'this._host.updatePresetButton()',
    'this._host.getDeepseekModelButton()',
    'this._host.getDeepseekModelButtonLabel()',
]) {
    if (!MOD.includes(wire)) {
        console.log(`!! MODULE MISSING WIRE: ${wire}`);
        fails++;
    }
}

// 6. Imports + smoke exclusion.
if (!NEW.includes("from './src/ui/pickers.js'")) {
    console.log('!! extension.js missing Pickers import');
    fails++;
}
if (/DEEPSEEK_MODELS,/.test(NEW) || /\n {4}deletePreset,/.test(NEW)) {
    console.log('!! extension.js still imports moved helpers (DEEPSEEK_MODELS/deletePreset)');
    fails++;
}
if (!SMOKE.includes("'src/ui/pickers.js',")) {
    console.log('!! import-smoke missing src/ui/pickers.js exclusion');
    fails++;
}

console.log(fails === 0 ? '\nFIDELITY: PASS' : `\nFIDELITY: ${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);

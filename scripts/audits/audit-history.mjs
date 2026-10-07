// Fidelity audit — ported from /tmp during the audit-rescue pass (Phase 1).
// Baseline: git 100a1d0:extension.js, loaded via ./lib.js (skips on shallow clones).
// Run from the repository root (`make audit`).
// Fidelity audit: history view extraction (extension.js -> src/ui/historyView.js)
import fs from 'node:fs';
import { loadBaseline } from './lib.js';

const OLD = loadBaseline('100a1d0');
const MOD = fs.readFileSync('src/ui/historyView.js', 'utf8');
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

const RENAMES = [
    // State fields (specific before generic).
    [/this\._historyListCacheIds/g, 'this._listCacheKey'],
    [/this\._historySearchQuery/g, 'this._searchQuery'],
    [/this\._historySearchTimeoutId/g, 'this._searchTimeoutId'],
    [/this\._historySearchBox/g, 'this._searchBox'],
    [/this\._historySearchEntry/g, 'this._searchEntry'],
    [/this\._historyTabRow/g, 'this._tabRow'],
    [/this\._historyActiveTabBtn/g, 'this._activeTabBtn'],
    [/this\._historyArchivedTabBtn/g, 'this._archivedTabBtn'],
    [/this\._historyContainer/g, 'this._container'],
    [/this\._historyEditorTitleEntry/g, 'this._editorTitleEntry'],
    [/this\._historyEditorDescEntry/g, 'this._editorDescEntry'],
    [/this\._historyEditorGenerateBtn/g, 'this._editorGenerateBtn'],
    [/this\._historyEditorSaveBtn/g, 'this._editorSaveBtn'],
    [/this\._historyEditorCancelBtn/g, 'this._editorCancelBtn'],
    [/this\._historyEditorStatus/g, 'this._editorStatus'],
    [/this\._historyEditorTargetId/g, 'this._editorTargetId'],
    [/this\._historyEditorCancellable/g, 'this._editorCancellable'],
    [/this\._historyEditorPanel/g, 'this.editor'],
    [/this\._historyView/g, 'this.view'],
    [/this\._historyTab/g, 'this._tab'],
    // Host substitutions.
    [
        /this\._buildPickerShell\('Edit Conversation'\)/g,
        "this._host.buildPickerShell('Edit Conversation')",
    ],
    [
        /if \(this\._recentChatsPopup\?\.visible\) this\._hideRecentChatsPopup\(\);/g,
        'this._host.hideRecentChatsPopup();',
    ],
    [/this\._hideRecentChatsPopup\(\)/g, 'this._host.hideRecentChatsPopup()'],
    [/this\._openAuxPanel\(this\.editor\)/g, 'this._host.openAuxPanel(this.editor)'],
    [/this\._showHistoryView\(\)/g, 'this._host.showHistoryView()'],
    [/this\._showChatView\(\)/g, 'this._host.showChatView()'],
    [/this\._loadConversation\(/g, 'this._host.loadConversation('],
    [/this\._deleteConversation\(/g, 'this._host.deleteConversation('],
    [/this\._notifyCurrentChatChanged\(\)/g, 'this._host.notifyCurrentChatChanged()'],
    [/this\._addSystemMessage\(/g, 'this._host.addSystemMessage('],
    [/this\._requestNonStreamingCompletion\(/g, 'this._host.requestNonStreamingCompletion('],
    [/this\._isActorDisposed\(/g, 'this._host.isActorDisposed('],
    [/this\._ragRuntime\.search\(/g, 'this._host.getRagRuntime().search('],
    [/this\._withTimeout\(/g, 'this._host.withTimeout('],
    [/RAG_MANUAL_SEARCH_TIMEOUT_MS/g, 'this._host.ragManualSearchTimeoutMs'],
    [/this\._extension\.path/g, 'this._host.extensionPath'],
    [/this\.close\(\);/g, 'this._host.closeDialog();'],
    [/this\._extractMessageText\(/g, 'extractMessageText('],
    // Method renames.
    [/this\._renderHistoryList\(/g, 'this.renderList('],
    [/this\._updateHistoryTabLabels\(/g, 'this._updateTabLabels('],
    [/this\._syncHistoryTabButtons\(/g, 'this._syncTabButtons('],
    [/this\._setHistoryTab\(/g, 'this._setTab('],
    [/this\._setConversationArchived\(/g, 'this._setArchived('],
    [/this\._openHistoryEditor\(/g, 'this._openEditor('],
    [/this\._saveHistoryEditor\(/g, 'this._saveEditor('],
    [/this\._generateConversationMeta\(/g, 'this._generateMeta('],
    [/this\._closeHistoryEditor\(/g, 'this.closeEditor('],
    [/this\._cancelTitleGeneration\(/g, 'this.cancelTitleGeneration('],
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
    ['_buildHistoryView', '_buildView', ['        this.contentLayout.add_child(this.view);']],
    ['_buildHistoryEditorPanel', 'buildEditorPanel', [], ['this.editor = picker;']],
    ['_openHistoryEditor', '_openEditor', [], []],
    ['_closeHistoryEditor', 'closeEditor', [], []],
    ['_saveHistoryEditor', '_saveEditor', [], []],
    ['_generateConversationMeta', '_generateMeta', [], []],
    ['_cancelTitleGeneration', 'cancelTitleGeneration', [], []],
    ['_setTitleGenBusy', '_setTitleGenBusy', [], []],
    ['_setHistoryTab', '_setTab', [], []],
    ['_syncHistoryTabButtons', '_syncTabButtons', [], []],
    ['_updateHistoryTabLabels', '_updateTabLabels', [], []],
    ['_setConversationArchived', '_setArchived', [], []],
    ['_renderHistoryList', 'renderList', [], []],
    ['_executeKbSearch', '_executeKbSearch', [], []],
    ['_renderKbSearchResults', '_renderKbSearchResults', [], []],
];

let fails = 0;
for (const [oldName, newName, removeFromOld = [], removeFromNew = []] of PAIRS) {
    const oldBody = extractMethod(OLD, oldName);
    const newBody = extractMethod(MOD, newName);
    if (oldBody === null || newBody === null) {
        console.log(`!! MISSING: ${oldName} -> ${newName} (old=${!!oldBody} new=${!!newBody})`);
        fails++;
        continue;
    }
    let expected = oldBody;
    for (const [re, repl] of RENAMES) expected = expected.replace(re, repl);
    for (const frag of removeFromOld) expected = expected.replace(frag, '');
    let actual = newBody;
    for (const frag of removeFromNew) actual = actual.replace(frag, '');
    const a = flat(expected);
    let b = flat(actual);
    b = stripA11y(b);
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

// Residual audit on new extension.js.
const RESIDUAL = [
    /this\._historySearchEntry/,
    /this\._historySearchBox/,
    /this\._historySearchQuery/,
    /this\._historySearchTimeoutId/,
    /this\._historyListCacheIds/,
    /this\._historyTabRow/,
    /this\._historyActiveTabBtn/,
    /this\._historyArchivedTabBtn/,
    /this\._historyContainer/,
    /this\._historyEditorTitle/,
    /this\._historyEditorDesc/,
    /this\._historyEditorGenerate/,
    /this\._historyEditorSave/,
    /this\._historyEditorCancel/,
    /this\._historyEditorStatus/,
    /this\._historyEditorTargetId/,
    /this\._historyEditorCancellable/,
    /this\._titleGenInFlight/,
    /this\._kbSearchEntry/,
    /this\._kbSearchBox/,
    /this\._kbSearchQuery/,
    /this\._kbSearchTimeoutId/,
    /this\._kbSearchViewActive/,
    /this\._renderHistoryList/,
    /this\._updateHistoryTabLabels/,
    /this\._syncHistoryTabButtons/,
    /this\._setHistoryTab\b/,
    /this\._setConversationArchived/,
    /this\._openHistoryEditor/,
    /this\._saveHistoryEditor/,
    /this\._generateConversationMeta/,
    /this\._setTitleGenBusy/,
    /this\._executeKbSearch/,
    /this\._renderKbSearchResults/,
    /this\._historyTab\b/,
];
for (const p of RESIDUAL) {
    if (p.test(NEW)) {
        console.log(`!! RESIDUAL in extension.js: ${p}`);
        fails++;
    }
}

// Wrappers + host wires must exist.
const WRAPPER_CHECKS = [
    ['_buildHistoryView()', 'new HistoryView(this._buildHistoryHost())', 400],
    ['_buildHistoryEditorPanel()', 'this._history.buildEditorPanel()', 200],
    ['_closeHistoryEditor()', 'this._history?.closeEditor()', 200],
    ['_cancelTitleGeneration()', 'this._history?.cancelTitleGeneration()', 200],
];
for (const [sig, call, win] of WRAPPER_CHECKS) {
    const idx = NEW.indexOf(`    ${sig} {`);
    const seg = idx === -1 ? '' : NEW.slice(idx, idx + win);
    if (idx === -1 || !seg.includes(call)) {
        console.log(`!! WRAPPER BROKEN: ${sig}`);
        fails++;
    }
}
const WIRES = [
    'this._history?.resetViewState()',
    'this._history?.prepareForShow()',
    'this._history?.destroy()',
];
for (const wire of WIRES) {
    if (!NEW.includes(wire)) {
        console.log(`!! MISSING WIRE: ${wire}`);
        fails++;
    }
}
const invalidateCount = (NEW.match(/this\._history\?\.invalidateList\(\)/g) || []).length;
if (invalidateCount !== 3) {
    console.log(`!! invalidateList wires: expected 3, found ${invalidateCount}`);
    fails++;
}

// New public module API presence checks.
for (const name of [
    'prepareForShow()',
    'resetViewState()',
    'invalidateList()',
    'destroy()',
    'closeEditor()',
    'cancelTitleGeneration()',
]) {
    if (!MOD.includes(`    ${name} {`)) {
        console.log(`!! MODULE MISSING: ${name}`);
        fails++;
    }
}

console.log(fails === 0 ? '\nFIDELITY: PASS' : `\nFIDELITY: ${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);

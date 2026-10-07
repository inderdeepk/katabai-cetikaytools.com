// Fidelity audit — ported from /tmp during the audit-rescue pass (Phase 1).
// Baseline: git 0e3ad5d:extension.js, loaded via ./lib.js (skips on shallow clones).
// Run from the repository root (`make audit`).
// Fidelity audit: assistant render pipeline (extension.js -> src/ui/assistantRender.js)
import fs from 'node:fs';
import { loadBaseline } from './lib.js';

const OLD = loadBaseline('0e3ad5d');
const MOD = fs.readFileSync('src/ui/assistantRender.js', 'utf8');
const NEW = fs.readFileSync('extension.js', 'utf8');
const SMOKE = fs.readFileSync('scripts/import-smoke.js', 'utf8');

function extractMethod(src, name) {
    const re = new RegExp(`^    (?:async )?${name}\\(`, 'm');
    const m = re.exec(src);
    if (!m) return null;
    // Walk the parameter list (handles multi-line + destructured params),
    // then the first brace after it opens the body.
    let i = m.index + m[0].length;
    let parens = 1;
    while (i < src.length && parens > 0) {
        const c = src[i];
        if (c === '(') parens++;
        else if (c === ')') parens--;
        i++;
    }
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== '{') return null;
    const start = i + 1;
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
    // Intentional comment update: method renamed to the public makeTextSelectable.
    [/after _makeTextSelectable so selection/g, 'after makeTextSelectable so selection'],
    [
        /this\._currentBibMap = this\._parseMessageBibliography\(sourceText\);/g,
        'this._host.setCurrentBibMap(this._parseMessageBibliography(sourceText));',
    ],
    [/this\._currentBibMap/g, 'this._host.getCurrentBibMap()'],
    [/this\._citationTracker/g, 'this._host.getCitationTracker()'],
    [/this\._messageHistory/g, 'this._host.getMessageHistory()'],
    [/this\._collectWebSources\(\)/g, 'this._host.collectWebSources()'],
    [/this\._addSystemMessage\(/g, 'this._host.addSystemMessage('],
    [/this\._scrollToBottom\(\)/g, 'this._host.scrollToBottom()'],
    [/this\.isOpen/g, 'this._host.isOpen()'],
    [/this\._isChatUiCurrent\(/g, 'this._host.isChatUiCurrent('],
    [/this\._isActorDisposed\(/g, 'this._host.isActorDisposed('],
    [/this\._renderSourcesSection\(/g, 'this.renderSourcesSection('],
    [/this\._makeTextSelectable\(/g, 'this.makeTextSelectable('],
    [/this\._truncateText\(/g, 'this.truncateText('],
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
    ['_setLabelMarkup', '_setLabelMarkup'],
    ['_truncateText', 'truncateText'],
    ['_positionFromTextEvent', '_positionFromTextEvent'],
    ['_byteOffsetToCharOffset', '_byteOffsetToCharOffset'],
    ['_makeTextSelectable', 'makeTextSelectable'],
    ['_createAssistantTextLabel', '_createAssistantTextLabel'],
    ['_createMarkdownRuleWidget', '_createMarkdownRuleWidget'],
    ['_createMarkdownTableCell', '_createMarkdownTableCell'],
    ['_createMarkdownTableWidget', '_createMarkdownTableWidget'],
    ['_createCodeBlockWidget', '_createCodeBlockWidget'],
    ['_renderAssistantSegments', '_renderAssistantSegments'],
    ['_openExternalLink', '_openExternalLink'],
    ['_parseMessageBibliography', '_parseMessageBibliography'],
    ['_collectCitationMap', '_collectCitationMap'],
    ['_createTextWithCitationButtons', '_createTextWithCitationButtons'],
    ['_renderSourcesSection', 'renderSourcesSection'],
    ['_getLinkChipLabel', '_getLinkChipLabel'],
    ['_updateLinkActions', '_updateLinkActions'],
    ['_applyAssistantRender', 'applyAssistantRender'],
    ['_renderAssistantFull', '_renderAssistantFull'],
    ['_renderAssistantStreamingFast', '_renderAssistantStreamingFast'],
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
    const a = flat(expected);
    const b = stripA11y(flat(modBody));
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
//    (Wrappers named _makeTextSelectable/_truncateText/_renderSourcesSection/
//    _applyAssistantRender are expected; body-specific strings are not.)
for (const p of [
    /_setLabelMarkup/,
    /_positionFromTextEvent/,
    /_byteOffsetToCharOffset/,
    /_createCodeBlockWidget/,
    /_createAssistantTextLabel/,
    /_renderAssistantSegments/,
    /_getLinkChipLabel/,
    /_updateLinkActions/,
    /katab-markdown-rule/,
    /katab-code-window/,
    /Failed to open link/,
    /STREAMING_FAST_THROTTLE_US|STREAMING_FULL_THROTTLE_US|STREAMING_SINGLE_LABEL_MAX_CHARS/,
    /buildAssistantRenderModel|formatInlineMarkdown|normalizeUrl|splitTextIntoBoundedChunks|MARKDOWN_SEGMENT_MAX_CHARS/,
]) {
    if (p.test(NEW)) {
        console.log(`!! RESIDUAL in extension.js: ${p}`);
        fails++;
    }
}

// 3. Wrappers must delegate to the module.
for (const wire of [
    'this._ensureRender().makeTextSelectable(label);',
    'this._ensureRender().truncateText(text, maxLength);',
    'this._ensureRender().renderSourcesSection(uiElements);',
    'this._ensureRender().applyAssistantRender(uiElements, rawText, options);',
    'new AssistantRender(this._buildRenderHost());',
]) {
    if (!NEW.includes(wire)) {
        console.log(`!! WRAPPER MISSING: ${wire}`);
        fails++;
    }
}

// 4. Host bag must carry every dialog dependency.
const hostIdx = NEW.indexOf('    _buildRenderHost() {');
const hostSeg = hostIdx === -1 ? '' : NEW.slice(hostIdx, hostIdx + 1700);
for (const key of [
    'isOpen',
    'isActorDisposed',
    'isChatUiCurrent',
    'getCurrentBibMap',
    'setCurrentBibMap',
    'getCitationTracker',
    'getMessageHistory',
    'collectWebSources',
    'addSystemMessage',
    'scrollToBottom',
]) {
    if (!hostSeg.includes(`${key}:`)) {
        console.log(`!! HOST BAG MISSING: ${key}`);
        fails++;
    }
}

// 5. Module must route dialog dependencies through the host.
for (const wire of [
    'this._host.isOpen()',
    'this._host.isActorDisposed(',
    'this._host.isChatUiCurrent(',
    'this._host.getCurrentBibMap()',
    'this._host.setCurrentBibMap(',
    'this._host.getCitationTracker()',
    'this._host.getMessageHistory()',
    'this._host.collectWebSources()',
    'this._host.addSystemMessage(',
    'this._host.scrollToBottom()',
]) {
    if (!MOD.includes(wire)) {
        console.log(`!! MODULE MISSING WIRE: ${wire}`);
        fails++;
    }
}

// 6. Imports + smoke exclusion + constructor field.
if (!NEW.includes("from './src/ui/assistantRender.js'")) {
    console.log('!! extension.js missing AssistantRender import');
    fails++;
}
if (NEW.includes("from './src/ui/markdownRender.js'")) {
    console.log('!! extension.js still imports from markdownRender.js');
    fails++;
}
if (!SMOKE.includes("'src/ui/assistantRender.js',")) {
    console.log('!! import-smoke missing src/ui/assistantRender.js exclusion');
    fails++;
}
if (!NEW.includes('this._render = null;')) {
    console.log('!! constructor missing this._render = null');
    fails++;
}

console.log(fails === 0 ? '\nFIDELITY: PASS' : `\nFIDELITY: ${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);

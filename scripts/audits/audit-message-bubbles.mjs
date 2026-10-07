// Fidelity audit — ported from /tmp during the audit-rescue pass (Phase 1).
// Baseline: git d3a612f:extension.js, loaded via ./lib.js (skips on shallow clones).
// Run from the repository root (`make audit`).
// Fidelity audit: message-bubble extraction (extension.js -> src/ui/messageBubble.js)
import fs from 'node:fs';
import { loadBaseline } from './lib.js';

const OLD = loadBaseline('d3a612f');
const MOD = fs.readFileSync('src/ui/messageBubble.js', 'utf8');
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
    [/this\._applyAssistantMetrics\(/g, 'this.applyAssistantMetrics('],
    [/this\._isDisposedWidgetError\(/g, 'this.isDisposedWidgetError('],
    [/this\._scrollToBottom\(\)/g, 'this.scrollToBottom()'],
    [/this\._makeTextSelectable\(/g, 'this._host.makeTextSelectable('],
    [/this\._getMessageAttachments\(/g, 'this._host.getMessageAttachments('],
    [/this\._getAttachmentKind\(/g, 'this._host.getAttachmentKind('],
    [/this\._sessionDocuments\.has\(/g, 'this._host.hasSessionDocument('],
    [/this\._regenerateResponse\(\)/g, 'this._host.regenerateResponse()'],
    [/this\._applyAssistantRender\(/g, 'this._host.applyAssistantRender('],
    [/this\._applyCacheSavings\(/g, 'this._host.applyCacheSavings('],
    [/this\._formatAssistantMetrics\(/g, 'this._host.formatAssistantMetrics('],
    [/this\._extension\.path/g, 'this._host.getExtensionPath()'],
    [/\((this\._messageList \|\| this\._chatContainer)\)/g, 'this._host.getMessageContainer()'],
    [/this\._chatGeneration/g, 'this._host.getChatGeneration()'],
    [/this\.isOpen/g, 'this._host.isOpen()'],
    [/this\._chatScroll/g, 'this._host.getChatScroll()'],
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
    ['_applyAssistantMetrics', 'applyAssistantMetrics'],
    ['_addChatMessage', 'buildMessage'],
    ['_buildAssistantPills', '_buildAssistantPills'],
    ['_buildCacheSavingsDrawer', '_buildCacheSavingsDrawer'],
    ['_buildToolLogSection', '_buildToolLogSection'],
    ['_buildThinkingSection', '_buildThinkingSection'],
    ['_scrollToBottom', 'scrollToBottom'],
    ['_isDisposedWidgetError', 'isDisposedWidgetError'],
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
for (const p of [
    /katab-think-wrapper/,
    /'Ran 0 tools'/,
    /Reattach this (?:file|image)/,
    /cacheSavingsDrawer\.add_child\(cacheSavingsDrawerBody\)/,
    /kbDrawer\.add_child\(kbDrawerBody\)/,
    /thinkBody\.visible = thinkButton\.checked/,
    /copyBtnRow\._katabHasReplyCopy = false/,
    /katab-chat-bubble user/,
    /_buildBubblesHost|_ensureBubbles/,
]) {
    if (p.test(NEW) && String(p) !== '/_buildBubblesHost|_ensureBubbles/') {
        console.log(`!! RESIDUAL in extension.js: ${p}`);
        fails++;
    }
}
// The ensure/host pair MUST exist (last pattern is an allow-check).
if (!/_ensureBubbles/.test(NEW) || !/_buildBubblesHost/.test(NEW)) {
    console.log('!! ensure/host helpers missing from extension.js');
    fails++;
}

// 3. Wrappers must delegate to the module.
for (const wire of [
    'this._ensureBubbles().buildMessage(sender, text, type, messageMeta);',
    'this._ensureBubbles().applyAssistantMetrics(label, messageMeta, footerRow);',
    'this._ensureBubbles().scrollToBottom();',
    'this._ensureBubbles().isDisposedWidgetError(e);',
    'new MessageBubble(this._buildBubblesHost());',
]) {
    if (!NEW.includes(wire)) {
        console.log(`!! WRAPPER MISSING: ${wire}`);
        fails++;
    }
}

// 4. Host bag must carry every dialog dependency.
const hostIdx = NEW.indexOf('    _buildBubblesHost() {');
const hostSeg = hostIdx === -1 ? '' : NEW.slice(hostIdx, hostIdx + 1900);
for (const key of [
    'isOpen',
    'getChatScroll',
    'getMessageContainer',
    'getChatGeneration',
    'getExtensionPath',
    'hasSessionDocument',
    'getMessageAttachments',
    'getAttachmentKind',
    'makeTextSelectable',
    'applyAssistantRender',
    'applyCacheSavings',
    'formatAssistantMetrics',
    'regenerateResponse',
]) {
    if (!hostSeg.includes(`${key}:`)) {
        console.log(`!! HOST BAG MISSING: ${key}`);
        fails++;
    }
}

// 5. Module must route everything through the host.
for (const wire of [
    'this._host.isOpen()',
    'this._host.getChatScroll()',
    'this._host.getMessageContainer()',
    'this._host.getChatGeneration()',
    'this._host.getExtensionPath()',
    'this._host.hasSessionDocument(',
    'this._host.getMessageAttachments(',
    'this._host.getAttachmentKind(',
    'this._host.makeTextSelectable(',
    'this._host.applyAssistantRender(',
    'this._host.applyCacheSavings(',
    'this._host.formatAssistantMetrics(',
    'this._host.regenerateResponse()',
]) {
    if (!MOD.includes(wire)) {
        console.log(`!! MODULE MISSING WIRE: ${wire}`);
        fails++;
    }
}

// 6. Imports + smoke exclusion.
if (!NEW.includes("from './src/ui/messageBubble.js'")) {
    console.log('!! extension.js missing MessageBubble import');
    fails++;
}
if (!SMOKE.includes("'src/ui/messageBubble.js',")) {
    console.log('!! import-smoke missing src/ui/messageBubble.js exclusion');
    fails++;
}

console.log(fails === 0 ? '\nFIDELITY: PASS' : `\nFIDELITY: ${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);

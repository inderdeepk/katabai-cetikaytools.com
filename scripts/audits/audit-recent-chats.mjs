// Fidelity audit — ported from /tmp during the audit-rescue pass (Phase 1).
// Baseline: git 6d6d896:extension.js, loaded via ./lib.js (skips on shallow clones).
// Run from the repository root (`make audit`).
// Fidelity audit: recent-chats popup extraction (extension.js -> src/ui/recentChatsPopup.js)
import fs from 'node:fs';
import { loadBaseline } from './lib.js';

const OLD = loadBaseline('6d6d896');
const MOD = fs.readFileSync('src/ui/recentChatsPopup.js', 'utf8');
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

function sliceHandlerBody(src, marker) {
    const i = src.indexOf(marker);
    if (i === -1) return null;
    const start = i + marker.length;
    const end = src.indexOf('return Clutter.EVENT_PROPAGATE;', start);
    if (end === -1) return null;
    return src.slice(start, end);
}

const SUBS = [
    [
        /this\.actor\.add_child\(this\._recentChatsPopup\)/g,
        'this._host.addToOverlay(this._recentChatsPopup)',
    ],
    [/this\._recentChatsClickLocked/g, 'this._clickLocked'],
    [/this\._recentChatsHoverTimeout/g, 'this._hoverTimeout'],
    [/this\._recentChatsLeaveTimeout/g, 'this._leaveTimeout'],
    [/this\._recentChatsRepositionId/g, 'this._repositionId'],
    [/this\._recentChatsCloseHandler/g, 'this._closeHandler'],
    [/this\._recentChatsPopup/g, 'this._popup'],
    [/this\._buildRecentChatsPopup\(\)/g, 'this._build()'],
    [/this\._showRecentChatsPopup\(\);/g, 'this.show();'],
    [/this\._hideRecentChatsPopup\(\)/g, 'this.hide()'],
    [/this\._positionRecentChatsPopup\(\);/g, 'this.position();'],
    [/this\._clearRecentChatsTimeouts\(\)/g, 'this._clearTimeouts()'],
    [/this\._refreshRecentChatsPopupRows\(/g, 'this._refreshRows('],
    [/refreshed by _refreshRecentChatsPopupRows/g, 'refreshed by _refreshRows'],
    [/refresh via _refreshRecentChatsPopupRows/g, 'refresh via _refreshRows'],
    [/this\._stageToOverlayCoords\(/g, 'this._host.stageToOverlayCoords('],
    [/this\._overlaySize\(\)/g, 'this._host.overlaySize()'],
    [/this\._historyBtn/g, 'this._host.getHistoryButton()'],
    [/!this\._chatScroll\?\.visible/g, '!this._host.isChatViewVisible()'],
    [/this\._currentConversationId/g, 'this._host.getCurrentConversationId()'],
    [/this\._loadConversation\(/g, 'this._host.loadConversation('],
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

function transformed(text) {
    let t = text;
    for (const [re, repl] of SUBS) t = t.replace(re, repl);
    return t;
}

const PAIRS = [
    ['_showRecentChatsPopup', 'show'],
    ['_hideRecentChatsPopup', 'hide'],
    ['_clearRecentChatsTimeouts', '_clearTimeouts'],
    ['_buildRecentChatsPopup', '_build'],
    ['_refreshRecentChatsPopupRows', '_refreshRows'],
    ['_positionRecentChatsPopup', 'position'],
    ['_formatRelativeTime', '_formatRelativeTime'],
];

let fails = 0;
for (const [oldName, newName] of PAIRS) {
    const oldBody = extractMethod(OLD, oldName);
    const newBody = extractMethod(MOD, newName);
    if (oldBody === null || newBody === null) {
        console.log(`!! MISSING: ${oldName} -> ${newName} (old=${!!oldBody} new=${!!newBody})`);
        fails++;
        continue;
    }
    const a = flat(transformed(oldBody));
    const b = flat(newBody);
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

// Trigger hover/leave handlers compared against old wiring slices.
for (const [marker, newName] of [
    ["this._historyBtn.connect('enter-event', () => {", 'noteTriggerEnter'],
    ["this._historyBtn.connect('leave-event', () => {", 'noteTriggerLeave'],
]) {
    const slice = sliceHandlerBody(OLD, marker);
    const newBody = extractMethod(MOD, newName);
    if (slice === null || newBody === null) {
        console.log(`!! MISSING trigger handler: ${newName} (slice=${!!slice} new=${!!newBody})`);
        fails++;
        continue;
    }
    const a = flat(transformed(slice));
    const b = flat(newBody);
    if (a === b) {
        console.log(`OK  historyBtn handler -> ${newName}`);
    } else {
        fails++;
        console.log(`DIFF historyBtn handler -> ${newName}`);
        let lo = 0;
        const lim = Math.min(a.length, b.length);
        while (lo < lim && a[lo] === b[lo]) lo++;
        console.log(`  at ${lo}: ...${a.slice(Math.max(0, lo - 90), lo + 90)}`);
        console.log(`      vs: ...${b.slice(Math.max(0, lo - 90), lo + 90)}`);
    }
}

// Residual audit on new extension.js.
const RESIDUAL = [
    /this\._recentChatsClickLocked/,
    /this\._recentChatsHoverTimeout/,
    /this\._recentChatsLeaveTimeout/,
    /this\._recentChatsRepositionId/,
    /this\._recentChatsCloseHandler/,
    /this\._buildRecentChatsPopup/,
    /this\._clearRecentChatsTimeouts/,
    /this\._refreshRecentChatsPopupRows/,
    /this\._formatRelativeTime/,
];
for (const p of RESIDUAL) {
    if (p.test(NEW)) {
        console.log(`!! RESIDUAL in extension.js: ${p}`);
        fails++;
    }
}

// Wrappers + host wires.
const WRAPPER_CHECKS = [
    [
        '_showRecentChatsPopup()',
        ['this._recentChats.show()', 'this._recentChatsPopup = this._recentChats.popup'],
    ],
    ['_hideRecentChatsPopup()', ['this._recentChats?.hide()']],
    ['_positionRecentChatsPopup()', ['this._recentChats?.position()']],
    ['_ensureRecentChats()', ['new RecentChatsPopup(this._buildRecentChatsHost())']],
];
for (const [sig, calls] of WRAPPER_CHECKS) {
    const idx = NEW.indexOf(`    ${sig} {`);
    const seg = idx === -1 ? '' : NEW.slice(idx, idx + 400);
    for (const call of calls) {
        if (idx === -1 || !seg.includes(call)) {
            console.log(`!! WRAPPER BROKEN: ${sig} (missing ${call})`);
            fails++;
        }
    }
}
for (const wire of [
    'this._recentChats.noteTriggerEnter()',
    'this._recentChats.noteTriggerLeave()',
    'this._recentChats?.destroy()',
]) {
    if (!NEW.includes(wire)) {
        console.log(`!! MISSING WIRE: ${wire}`);
        fails++;
    }
}

// Module public API presence.
for (const name of [
    'show()',
    'hide()',
    'noteTriggerEnter()',
    'noteTriggerLeave()',
    'position()',
    '_clearTimeouts()',
    'destroy()',
    '_build()',
    '_refreshRows(entries)',
    '_formatRelativeTime(timestamp)',
]) {
    if (!MOD.includes(`    ${name} {`)) {
        console.log(`!! MODULE MISSING: ${name}`);
        fails++;
    }
}
if (!MOD.includes('get popup()')) {
    console.log('!! MODULE MISSING: get popup()');
    fails++;
}

console.log(fails === 0 ? '\nFIDELITY: PASS' : `\nFIDELITY: ${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);

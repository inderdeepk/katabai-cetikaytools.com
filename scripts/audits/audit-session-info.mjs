// Fidelity audit — ported from /tmp during the audit-rescue pass (Phase 1).
// Baseline: git 100a1d0:extension.js, loaded via ./lib.js (skips on shallow clones).
// Run from the repository root (`make audit`).
// Fidelity audit: session-info popup extraction (extension.js -> src/ui/sessionInfoPopup.js)
import fs from 'node:fs';
import { loadBaseline } from './lib.js';

const OLD = loadBaseline('100a1d0');
const MOD = fs.readFileSync('src/ui/sessionInfoPopup.js', 'utf8');
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
        /this\._tokenBox\.get_transformed_position\(\)/g,
        'this._host.getAnchor().get_transformed_position()',
    ],
    [/this\._tokenBox\.get_transformed_size\(\)/g, 'this._host.getAnchor().get_transformed_size()'],
    [/this\._stageToOverlayCoords\(/g, 'this._host.stageToOverlayCoords('],
    [/this\._overlaySize\(\)/g, 'this._host.overlaySize()'],
    [/this\._computeSessionInfo\(\)/g, 'this._host.getSessionInfo()'],
    [/this\._summarizeNow\(\)/g, 'this._host.summarizeNow()'],
    [/this\._compactConversation\(\)/g, 'this._host.compactConversation()'],
    [
        /this\.actor\.add_child\(this\._sessionInfoPopup\)/g,
        'this._host.addToOverlay(this._sessionInfoPopup)',
    ],
    [/this\._buildSessionInfoPopup\(\)/g, 'this._build()'],
    [/this\._refreshSessionInfoPopup\(\);/g, 'this.refresh();'],
    [/this\._positionSessionInfoPopup\(\);/g, 'this.position();'],
    [/this\._hideSessionInfoPopup\(\)/g, 'this.hide()'],
    [/this\._showSessionInfoPopup\(\);/g, 'this.show();'],
    [/this\._clearSessionInfoTimeouts\(\)/g, 'this._clearTimeouts()'],
    [/this\._sessionInfoClickLocked/g, 'this._clickLocked'],
    [/this\._sessionInfoHoverTimeout/g, 'this._hoverTimeout'],
    [/this\._sessionInfoLeaveTimeout/g, 'this._leaveTimeout'],
    [/this\._sessionInfoPopup/g, 'this._popup'],
    [/this\._siRepositionId/g, 'this._repositionId'],
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
function sanitizeFlat(s) {
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

function transformed(text) {
    let t = text;
    for (const [re, repl] of SUBS) t = t.replace(re, repl);
    return t;
}

const PAIRS = [
    ['_buildSessionInfoPopup', '_build'],
    ['_showSessionInfoPopup', 'show'],
    ['_hideSessionInfoPopup', 'hide'],
    ['_toggleSessionInfoPopup', 'toggle'],
    ['_clearSessionInfoTimeouts', '_clearTimeouts'],
    ['_positionSessionInfoPopup', 'position'],
    ['_refreshSessionInfoPopup', 'refresh'],
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
    const b = sanitizeFlat(flat(newBody));
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

// Trigger hover/leave handlers: compare against custom slices of the old wiring.
for (const [marker, newName] of [
    ["this._tokenBox.connect('enter-event', () => {", 'noteTriggerEnter'],
    ["this._tokenBox.connect('leave-event', () => {", 'noteTriggerLeave'],
]) {
    const slice = sliceHandlerBody(OLD, marker);
    const newBody = extractMethod(MOD, newName);
    if (slice === null || newBody === null) {
        console.log(`!! MISSING trigger handler: ${newName} (slice=${!!slice} new=${!!newBody})`);
        fails++;
        continue;
    }
    const a = flat(transformed(slice));
    const b = sanitizeFlat(flat(newBody));
    if (a === b) {
        console.log(`OK  tokenBox handler -> ${newName}`);
    } else {
        fails++;
        console.log(`DIFF tokenBox handler -> ${newName}`);
        let lo = 0;
        const lim = Math.min(a.length, b.length);
        while (lo < lim && a[lo] === b[lo]) lo++;
        console.log(`  at ${lo}: ...${a.slice(Math.max(0, lo - 90), lo + 90)}`);
        console.log(`      vs: ...${b.slice(Math.max(0, lo - 90), lo + 90)}`);
    }
}

// Residual audit on new extension.js.
const RESIDUAL = [
    /this\._sessionInfoClickLocked/,
    /this\._sessionInfoHoverTimeout/,
    /this\._sessionInfoLeaveTimeout/,
    /this\._siRepositionId/,
    /this\._buildSessionInfoPopup/,
    /this\._clearSessionInfoTimeouts/,
    /this\._siCw/,
    /this\._siProgress/,
    /this\._siReserved/,
    /this\._siSys/,
    /this\._siUc/,
    /this\._siMem/,
    /this\._siRes/,
    /this\._siResearchSection/,
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
        '_showSessionInfoPopup()',
        ['this._sessionInfo.show()', 'this._sessionInfoPopup = this._sessionInfo.popup'],
    ],
    ['_hideSessionInfoPopup()', ['this._sessionInfo?.hide()']],
    ['_toggleSessionInfoPopup()', ['this._sessionInfo.toggle()']],
    ['_positionSessionInfoPopup()', ['this._sessionInfo?.position()']],
    ['_refreshSessionInfoPopup()', ['this._sessionInfo?.refresh()']],
    ['_ensureSessionInfo()', ['new SessionInfoPopup(this._buildSessionInfoHost())']],
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
    'this._sessionInfo.noteTriggerEnter()',
    'this._sessionInfo.noteTriggerLeave()',
    'this._sessionInfo?.destroy()',
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
    'toggle()',
    'noteTriggerEnter()',
    'noteTriggerLeave()',
    'position()',
    'refresh()',
    '_clearTimeouts()',
    'destroy()',
]) {
    if (!MOD.includes(`    ${name} {`) && !MOD.includes(`    ${name} {`)) {
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

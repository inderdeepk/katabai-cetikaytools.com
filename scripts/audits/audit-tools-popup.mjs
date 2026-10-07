// Fidelity audit — ported from /tmp during the audit-rescue pass (Phase 1).
// Baseline: git 6d6d896:extension.js, loaded via ./lib.js (skips on shallow clones).
// Run from the repository root (`make audit`).
// Fidelity audit: tools popup extraction (extension.js -> src/ui/toolsPopup.js)
import fs from 'node:fs';
import { loadBaseline } from './lib.js';

const OLD = loadBaseline('6d6d896');
const MOD = fs.readFileSync('src/ui/toolsPopup.js', 'utf8');
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
        /this\._toolsGearWrap\.get_transformed_position\(\)/g,
        'this._host.getAnchor().get_transformed_position()',
    ],
    [
        /this\._toolsGearWrap\.get_transformed_size\(\)/g,
        'this._host.getAnchor().get_transformed_size()',
    ],
    [/!this\._toolsGearWrap/g, '!this._host.getAnchor()'],
    [/this\._entry\.get_text\(\)\.trim\(\)/g, 'this._host.getEntryText()'],
    [/this\._entry\.set_text\(/g, 'this._host.setEntryText('],
    [/this\._entry\.set_cursor_position\(-1\)/g, 'this._host.placeCursorAtEnd()'],
    [/this\.actor\.add_child\(this\._toolsPopup\)/g, 'this._host.addToOverlay(this._toolsPopup)'],
    [/this\._toolsPopupModeLabels/g, 'this._modeLabels'],
    [/this\._toolsPopupRows/g, 'this._rows'],
    [/this\._toolsClickLocked/g, 'this._clickLocked'],
    [/this\._toolsHoverTimeout/g, 'this._hoverTimeout'],
    [/this\._toolsLeaveTimeout/g, 'this._leaveTimeout'],
    [/this\._toolsRepositionId/g, 'this._repositionId'],
    [/this\._toolsPopup/g, 'this._popup'],
    [/this\._buildToolsPopup\(\)/g, 'this._build()'],
    [/this\._refreshToolsPopup\(\);/g, 'this.refresh();'],
    [/this\._positionToolsPopup\(\);/g, 'this.position();'],
    [/this\._hideToolsPopup\(\)/g, 'this.hide()'],
    [/this\._showToolsPopup\(\);/g, 'this.show();'],
    [/this\._clearToolsTimeouts\(\)/g, 'this._clearTimeouts()'],
    [/this\._patchToolsPopupMode\(/g, 'this._patchMode('],
    [/this\._stageToOverlayCoords\(/g, 'this._host.stageToOverlayCoords('],
    [/this\._overlaySize\(\)/g, 'this._host.overlaySize()'],
    [/this\._getAvailableTools\(\)/g, 'this._host.getAvailableTools()'],
    [/this\._isModeControlledTool\(/g, 'this._host.isModeControlledTool('],
    [/this\._getToolMode\(/g, 'this._host.getToolMode('],
    [/this\._isDocumentToolEnabled\(\)/g, 'this._host.isDocumentToolEnabled()'],
    [/this\._toolModeAvailable\(/g, 'this._host.toolModeAvailable('],
    [/this\._getToolButtonLabel\(/g, 'this._host.getToolButtonLabel('],
    [/this\._cycleToolMode\(/g, 'this._host.cycleToolMode('],
    [/this\._updateToolsBadge\(\)/g, 'this._host.updateToolsBadge()'],
    [/this\._addSystemMessage\(/g, 'this._host.addSystemMessage('],
    [/await this\._pickDocumentForAttachment\(\)/g, 'await this._host.pickDocumentForAttachment()'],
    [/this\.focusPrompt\(\)/g, 'this._host.focusPrompt()'],
    [/this\._dialogX/g, 'dx'],
    [/this\._dialogY/g, 'dy'],
    [/this\._dialogW/g, 'dw'],
    [/this\._dialogH/g, 'dh'],
    // Intentional comment update: the module's own method is refresh().
    [/rebuilt by _refreshToolsPopup/g, 'rebuilt by refresh()'],
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
    ['_buildToolsPopup', '_build', []],
    ['_showToolsPopup', 'show', ['const[dx,dy,dw,dh]=this._host.getDialogRect();']],
    ['_hideToolsPopup', 'hide', []],
    ['_toggleToolsPopup', 'toggle', []],
    ['_clearToolsTimeouts', '_clearTimeouts', []],
    ['_positionToolsPopup', 'position', []],
    ['_refreshToolsPopup', 'refresh', []],
    ['_patchToolsPopupMode', '_patchMode', []],
];

let fails = 0;
for (const [oldName, newName, removeFromNew] of PAIRS) {
    const oldBody = extractMethod(OLD, oldName);
    const newBody = extractMethod(MOD, newName);
    if (oldBody === null || newBody === null) {
        console.log(`!! MISSING: ${oldName} -> ${newName} (old=${!!oldBody} new=${!!newBody})`);
        fails++;
        continue;
    }
    const a = flat(transformed(oldBody));
    let b = sanitizeFlat(flat(newBody));
    for (const frag of removeFromNew) b = b.replace(frag, '');
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
    ["this._toolsGearWrap.connect('enter-event', () => {", 'noteTriggerEnter'],
    ["this._toolsGearWrap.connect('leave-event', () => {", 'noteTriggerLeave'],
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
        console.log(`OK  gearWrap handler -> ${newName}`);
    } else {
        fails++;
        console.log(`DIFF gearWrap handler -> ${newName}`);
        let lo = 0;
        const lim = Math.min(a.length, b.length);
        while (lo < lim && a[lo] === b[lo]) lo++;
        console.log(`  at ${lo}: ...${a.slice(Math.max(0, lo - 90), lo + 90)}`);
        console.log(`      vs: ...${b.slice(Math.max(0, lo - 90), lo + 90)}`);
    }
}

// Residual audit on new extension.js.
const RESIDUAL = [
    /this\._toolsPopupRows/,
    /this\._toolsPopupModeLabels/,
    /this\._toolsClickLocked/,
    /this\._toolsHoverTimeout/,
    /this\._toolsLeaveTimeout/,
    /this\._toolsRepositionId/,
    /this\._buildToolsPopup/,
    /this\._clearToolsTimeouts/,
    /this\._patchToolsPopupMode/,
    /const TOOL_MODE_SEQUENCE/,
    /const TOOL_MODE_LABELS/,
    /const DEEP_RESEARCH_MODE_SEQUENCE/,
    /const DEEP_RESEARCH_MODE_LABELS/,
];
for (const p of RESIDUAL) {
    if (p.test(NEW)) {
        console.log(`!! RESIDUAL in extension.js: ${p}`);
        fails++;
    }
}

// Wrappers + host wires.
const WRAPPER_CHECKS = [
    ['_showToolsPopup()', ['this._tools.show()', 'this._toolsPopup = this._tools.popup']],
    ['_hideToolsPopup()', ['this._tools?.hide()']],
    ['_toggleToolsPopup()', ['this._tools.toggle()']],
    ['_positionToolsPopup()', ['this._tools?.position()']],
    ['_refreshToolsPopup()', ['this._tools?.refresh()']],
    ['_ensureToolsPopup()', ['new ToolsPopup(this._buildToolsHost())']],
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
    'this._tools.noteTriggerEnter()',
    'this._tools.noteTriggerLeave()',
    'this._tools?.destroy()',
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
    if (!MOD.includes(`    ${name} {`)) {
        console.log(`!! MODULE MISSING: ${name}`);
        fails++;
    }
}
if (!MOD.includes('get popup()')) {
    console.log('!! MODULE MISSING: get popup()');
    fails++;
}

// Single-sourced mode constants: extension imports them, shared module defines them.
const SHARED = fs.readFileSync('src/shared/toolModes.js', 'utf8');
for (const name of [
    'TOOL_MODE_AUTO',
    'TOOL_MODE_ON',
    'TOOL_MODE_OFF',
    'TOOL_MODE_SEQUENCE',
    'TOOL_MODE_LABELS',
    'DEEP_RESEARCH_MODE_SEQUENCE',
    'DEEP_RESEARCH_MODE_LABELS',
]) {
    if (!SHARED.includes(`export const ${name}`)) {
        console.log(`!! SHARED MISSING: ${name}`);
        fails++;
    }
}
if (!NEW.includes("from './src/shared/toolModes.js'")) {
    console.log('!! extension.js does not import toolModes.js');
    fails++;
}

console.log(fails === 0 ? '\nFIDELITY: PASS' : `\nFIDELITY: ${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);

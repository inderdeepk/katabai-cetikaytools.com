// Fidelity audit — ported from /tmp during the audit-rescue pass (Phase 1).
// Baseline: git d1879c9:extension.js, loaded via ./lib.js (skips on shallow clones).
// Run from the repository root (`make audit`).
// Fidelity audit: dialog constructor decomposition (in-place, no module move).
// Verifies every line of the old 517-line constructor survives in either the
// new slim constructor or one of the eight extracted init methods, and that
// each method body is a preserved (contiguous) slice of the old constructor.
import fs from 'node:fs';
import { loadBaseline } from './lib.js';

const OLD = loadBaseline('d1879c9');
const NEW = fs.readFileSync('extension.js', 'utf8');

function extractMethod(src, name) {
    const re = new RegExp(`^    (?:async )?${name}\\(`, 'm');
    const m = re.exec(src);
    if (!m) return null;
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

function dialogCtorBody(src) {
    const classIdx = src.indexOf('class KatabDialog');
    if (classIdx === -1) return null;
    const body = extractMethod(src.slice(classIdx), 'constructor');
    if (!body || !body.includes('this._extension = extension;')) return null;
    return body;
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

function normalizedLines(text) {
    const out = [];
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
    return out;
}

const METHODS = [
    '_scheduleStartupRagTasks',
    '_initSleepMonitor',
    '_initStateFields',
    '_wireSettingsWatchers',
    '_initInterfaceSettings',
    '_buildActorShell',
    '_installStageCapture',
    '_subscribeProviderHealth',
];

let fails = 0;

const oldCtor = dialogCtorBody(OLD);
const newCtor = dialogCtorBody(NEW);
if (!oldCtor || !newCtor) {
    console.log(`!! could not extract constructors (old=${!!oldCtor} new=${!!newCtor})`);
    process.exit(1);
}

// 1. Multiset line comparison: oldCtor lines == newCtor + all method lines.
function countLines(lines) {
    const map = new Map();
    for (const l of lines) map.set(l, (map.get(l) || 0) + 1);
    return map;
}
const oldCounts = countLines(normalizedLines(oldCtor));
const combined = [newCtor, ...METHODS.map((name) => extractMethod(NEW, name))];
if (combined.some((b) => b === null)) {
    console.log('!! MISSING method body: ' + METHODS.filter((n, i) => combined[i + 1] === null));
    fails++;
}
const newCounts = countLines(combined.filter(Boolean).flatMap((b) => normalizedLines(b)));

// Allowances:
// (a) comments hoisted ABOVE their method signatures live outside the
//     extracted bodies — accept them if they exist verbatim anywhere in NEW.
// (b) the new constructor calls + method signatures are expected additions.
const newRawCounts = countLines(normalizedLines(NEW));
const ALLOWED_EXTRA = new Set([
    ...METHODS.map((n) => `this.${n}();`),
    ...METHODS.map((n) => `${n}() {`),
]);

for (const [line, count] of oldCounts) {
    const got = newCounts.get(line) || 0;
    if (got < count) {
        // Relocated comment check: exists verbatim in the raw new file?
        const rawGot = newRawCounts.get(line) || 0;
        if (line.startsWith('//') && rawGot >= count) {
            continue;
        }
        console.log(`!! LINE COUNT MISMATCH (old=${count} new=${got}): ${line.slice(0, 110)}`);
        fails++;
        if (fails > 12) break;
    }
}
for (const [line, count] of newCounts) {
    const old = oldCounts.get(line) || 0;
    if (old < count && !ALLOWED_EXTRA.has(line)) {
        console.log(`!! EXTRA LINE in new (new=${count} old=${old}): ${line.slice(0, 110)}`);
        fails++;
        if (fails > 12) break;
    }
}
if (fails === 0)
    console.log('OK  multiset line coverage (old constructor == new ctor + 8 methods)');

// 2. Block preservation: each method's flat body is contiguous in the old ctor
//    (_initStateFields is two slices: state block 1 + state block 2).
const flatOld = flat(oldCtor);
for (const name of METHODS) {
    const body = extractMethod(NEW, name);
    if (!body) continue;
    const fb = flat(body);
    if (name === '_initStateFields') {
        const j = fb.indexOf('this._monitorChangedId=0;');
        const part1 = fb.slice(0, j);
        const part2 = fb.slice(j);
        const ok1 = flatOld.includes(part1);
        const ok2 = flatOld.includes(part2);
        if (ok1 && ok2) {
            console.log(`OK  _initStateFields (2 preserved slices)`);
        } else {
            console.log(`!! _initStateFields slices not found (part1=${ok1} part2=${ok2})`);
            fails++;
        }
        continue;
    }
    if (flatOld.includes(fb)) {
        console.log(`OK  ${name} body preserved`);
    } else {
        console.log(`!! ${name} body NOT a contiguous slice of the old constructor`);
        fails++;
    }
}

// 3. New constructor shape: expected calls in order, no state blocks.
const flatCtor = flat(newCtor);
let cursor = 0;
const expected = [
    'this._scheduleStartupRagTasks();',
    'this._initToolRegistry();',
    'this._initSleepMonitor();',
    'this._initStateFields();',
    'this._wireSettingsWatchers();',
    'this._initInterfaceSettings();',
    'this._buildActorShell();',
    'this._installStageCapture();',
    'this._monitorChangedId=Main.layoutManager.connect(',
    'this._syncGeometry();',
    'this._buildUI();',
    'this._updateHeaderPetSprite();',
    'this._subscribeProviderHealth();',
];
let shapeOk = true;
for (const token of expected) {
    const idx = flatCtor.indexOf(token, cursor);
    if (idx === -1) {
        console.log(`!! constructor call out of order/missing: ${token}`);
        shapeOk = false;
        fails++;
    } else {
        cursor = idx + token.length;
    }
}
if (shapeOk) console.log('OK  constructor call sequence');
for (const forbidden of [
    'this._messageHistory=[]',
    'this.isOpen=false',
    "this._connectSetting('",
    'this._settingsHandlerIds=[]',
]) {
    if (flatCtor.includes(forbidden)) {
        console.log(`!! constructor still contains moved block: ${forbidden}`);
        fails++;
    }
}
if (flatCtor.length > 1600) {
    console.log(`!! constructor still large (${flatCtor.length} flat chars)`);
    fails++;
}

// 4. File-level invariants: same number of _connectSetting( call sites.
const oldCalls = (OLD.match(/_connectSetting\(/g) || []).length;
const newCalls = (NEW.match(/_connectSetting\(/g) || []).length;
if (oldCalls === newCalls) {
    console.log(`OK  _connectSetting call sites unchanged (${newCalls})`);
} else {
    console.log(`!! _connectSetting count changed: ${oldCalls} -> ${newCalls}`);
    fails++;
}

console.log(fails === 0 ? '\nFIDELITY: PASS' : `\nFIDELITY: ${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);

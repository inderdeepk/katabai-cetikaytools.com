// Fidelity audit — ported from /tmp during the audit-rescue pass (Phase 1).
// Baseline: git 100a1d0:extension.js, loaded via ./lib.js (skips on shallow clones).
// Run from the repository root (`make audit`).
// Fidelity audit: welcome panel extraction (extension.js -> src/ui/welcomePanel.js)
import fs from 'node:fs';
import { loadBaseline } from './lib.js';

const OLD = loadBaseline('100a1d0');
const MOD = fs.readFileSync('src/ui/welcomePanel.js', 'utf8');
const NEW = fs.readFileSync('extension.js', 'utf8');

function extractMethod(src, name) {
    const re = new RegExp(`^    ${name}\\([^)]*\\) \\{$`, 'm');
    const m = re.exec(src);
    if (!m) return null;
    const start = m.index + m[0].length;
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
    [/this\._welcomeStage/g, 'this._stage'],
    [/this\._welcomeAura/g, 'this._aura'],
    [/this\._welcomePageActors/g, 'this._pageActors'],
    [/this\._welcomeDustActors/g, 'this._dustActors'],
    [/this\._welcomeAnimationLoopId/g, 'this._animationLoopId'],
    [/this\._welcomeAnimationSourceIds/g, 'this._animationSourceIds'],
    [/this\._welcomePanel/g, 'this.panel'],
    [/this\.isOpen/g, 'this._dialog.isOpen'],
    [/this\._chatScroll/g, 'this._dialog._chatScroll'],
    [/this\._startWelcomeAnimation/g, 'this.startAnimation'],
    [/this\._stopWelcomeAnimation/g, 'this.stopAnimation'],
    [/this\._scheduleWelcomeCallback/g, 'this._scheduleCallback'],
    [/this\._resetWelcomeAnimation/g, 'this._reset'],
    [/this\._runWelcomeAnimationCycle/g, 'this._runCycle'],
];

function normalize(text) {
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
        const lc = line.indexOf('//');
        if (lc !== -1) line = line.slice(0, lc);
        line = line.replace(/\s+/g, ' ').trim();
        if (line) out.push(line);
    }
    return out.join('\n');
}

// Wrap-insensitive form: strip comments, all whitespace, and trailing commas
// (prettier inserts/removes those purely based on line width).
function flat(text) {
    return normalize(text)
        .replace(/\s+/g, '')
        .replace(/,(?=[)\]}])/g, '');
}

const PAIRS = [
    ['_buildWelcomePanel', '_build'],
    ['_setWelcomeVisible', 'setVisible'],
    ['_scheduleWelcomeCallback', '_scheduleCallback'],
    ['_resetWelcomeAnimation', '_reset'],
    ['_runWelcomeAnimationCycle', '_runCycle'],
    ['_startWelcomeAnimation', 'startAnimation'],
    ['_stopWelcomeAnimation', 'stopAnimation'],
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
    let expected = oldBody;
    for (const [re, repl] of RENAMES) expected = expected.replace(re, repl);
    const a = normalize(expected);
    const b = normalize(newBody);
    if (a === b) {
        console.log(`OK  ${oldName} -> ${newName}`);
    } else if (flat(expected) === unwrapI18n(flat(newBody))) {
        console.log(`OK  ${oldName} -> ${newName} (wrap-insensitive match)`);
    } else {
        fails++;
        console.log(`DIFF ${oldName} -> ${newName}`);
        const al = a.split('\n');
        const bl = b.split('\n');
        const n = Math.max(al.length, bl.length);
        let shown = 0;
        for (let i = 0; i < n && shown < 12; i++) {
            if (al[i] !== bl[i]) {
                console.log(`  old[${i}]: ${al[i]}`);
                console.log(`  new[${i}]: ${bl[i]}`);
                shown++;
            }
        }
    }
}

// Residual checks on the new extension.js
const residualPatterns = [
    /this\._welcomeStage\b/,
    /this\._welcomeAura\b/,
    /this\._welcomePageActors\b/,
    /this\._welcomeDustActors\b/,
    /this\._welcomeAnimationLoopId\b/,
    /this\._welcomeAnimationSourceIds\b/,
    /_scheduleWelcomeCallback\(/,
    /_resetWelcomeAnimation\(/,
    /_runWelcomeAnimationCycle\(/,
];
for (const p of residualPatterns) {
    if (p.test(NEW)) {
        console.log(`!! RESIDUAL in extension.js: ${p}`);
        fails++;
    }
}

// Wrappers must exist with delegation
for (const [sig, call] of [
    ['_buildWelcomePanel()', 'new WelcomePanel(this)'],
    ['_setWelcomeVisible(visible)', 'this._welcome?.setVisible(visible)'],
    ['_startWelcomeAnimation()', 'this._welcome?.startAnimation()'],
    ['_stopWelcomeAnimation()', 'this._welcome?.stopAnimation()'],
]) {
    const idx = NEW.indexOf(`    ${sig} {`);
    const seg = idx === -1 ? '' : NEW.slice(idx, idx + 220);
    if (idx === -1 || !seg.includes(call)) {
        console.log(`!! WRAPPER BROKEN: ${sig}`);
        fails++;
    }
}

function unwrapI18n(s) {
    return s.replace(/_\('[^']*'\)/g, (m) => m.slice(2, -1));
}

console.log(fails === 0 ? '\nFIDELITY: PASS' : `\nFIDELITY: ${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);

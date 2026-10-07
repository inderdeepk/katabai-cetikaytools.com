// Fidelity audit — `_handleStreamEnd` decomposition (extension.js, in-place).
// Baseline: git d3b49ef:extension.js (pre-split), loaded via ./lib.js.
// Run from the repository root (`make audit`).
//
// Verifies:
//   1. Each of the four extracted helper bodies is exactly the corresponding
//      contiguous slice of the old method (flat-compare; the two recovery
//      helpers carry an appended `return { finalContent, effectiveToolCalls };`).
//   2. The old slices really were contiguous runs of the old body.
//   3. The new coordinator keeps the expected call sequence and none of the
//      moved text; it stayed small.
//   4. Line coverage: old body minus the four slices == new coordinator,
//      modulo the allow-listed call-statement lines.
import fs from 'node:fs';
import { loadBaseline, extractMethod, flat, normalizedLines, countLines } from './lib.js';

const OLD = loadBaseline('d3b49ef');
const NEW = fs.readFileSync('extension.js', 'utf8');

const oldBody = extractMethod(OLD, '_handleStreamEnd');
const newCoord = extractMethod(NEW, '_handleStreamEnd');
const helpers = {
    S1: extractMethod(NEW, '_recoverThinkingOnlyFallback'),
    S2: extractMethod(NEW, '_recoverTextBasedToolCalls'),
    S3: extractMethod(NEW, '_finalizeToolCallTurn'),
    S4: extractMethod(NEW, '_finalizeSynthesisTurn'),
};

let fails = 0;
const fail = (msg) => {
    console.log(`!! ${msg}`);
    fails++;
};

if (!oldBody || !newCoord || Object.values(helpers).some((h) => !h)) {
    console.log(
        `!! extraction failed (old=${!!oldBody} coord=${!!newCoord} helpers=${Object.values(helpers).filter(Boolean).length}/4)`,
    );
    process.exit(1);
}

// ── Slice extraction from the old body (anchor-based) ────────────────────
function slice(startAnchor, endAnchor) {
    const s = oldBody.indexOf(startAnchor);
    if (s === -1) throw new Error(`start anchor not found: ${startAnchor.slice(0, 50)}`);
    const e = oldBody.indexOf(endAnchor, s);
    if (e === -1) throw new Error(`end anchor not found: ${endAnchor.slice(0, 50)}`);
    return oldBody.slice(s, e).trim();
}

const slices = {
    S1: slice(
        '// If we have thinking but no content and no structured tool calls,',
        '\n\n            // If no structured tool_calls were streamed,',
    ),
    S2: slice(
        '// If no structured tool_calls were streamed, check whether the',
        '\n            if (effectiveToolCalls.length > 0) {',
    ),
    S3: slice(
        '// Hard-enforce the tool-iteration cap AND force-synthesis.',
        '\n            } else {\n                // ── Synthesis fallback',
    ),
    S4: slice(
        '// ── Synthesis fallback: handle degraded model output',
        '\n            }\n        } catch (eofError) {',
    ),
};

// ── 1. Helper bodies == old slices ───────────────────────────────────────
const RETURN_PAIR = 'return{finalContent,effectiveToolCalls};';
const NAMES = {
    S1: '_recoverThinkingOnlyFallback',
    S2: '_recoverTextBasedToolCalls',
    S3: '_finalizeToolCallTurn',
    S4: '_finalizeSynthesisTurn',
};
for (const key of ['S1', 'S2', 'S3', 'S4']) {
    const oldFlat = flat(slices[key]);
    let newFlat = flat(helpers[key]);
    if (key === 'S1' || key === 'S2') {
        if (!newFlat.endsWith(RETURN_PAIR)) {
            fail(`${NAMES[key]}: missing trailing ${RETURN_PAIR}`);
            continue;
        }
        newFlat = newFlat.slice(0, -RETURN_PAIR.length);
    }
    if (oldFlat === newFlat) {
        console.log(`OK  ${NAMES[key]} == old slice ${key}`);
    } else {
        fails++;
        let lo = 0;
        const lim = Math.min(oldFlat.length, newFlat.length);
        while (lo < lim && oldFlat[lo] === newFlat[lo]) lo++;
        console.log(`DIFF ${NAMES[key]} vs old slice ${key}`);
        console.log(`  at ${lo}: ...${oldFlat.slice(Math.max(0, lo - 90), lo + 90)}`);
        console.log(`      vs: ...${newFlat.slice(Math.max(0, lo - 90), lo + 90)}`);
    }
}

// ── 2. Slices are contiguous runs of the old body ───────────────────────
const flatOld = flat(oldBody);
for (const key of ['S1', 'S2', 'S3', 'S4']) {
    if (!flatOld.includes(flat(slices[key]))) {
        fail(`old slice ${key} is not contiguous in the old body (anchor bug?)`);
    }
}

// ── 3. Coordinator shape ─────────────────────────────────────────────────
const fc = flat(newCoord);
const expectedOrder = [
    'let{uiElements}=responseState;',
    'SSEEOFreached',
    'letfinalContent=responseState.accumulatedText;',
    'leteffectiveToolCalls=responseState.accumulatedToolCalls;',
    '({finalContent,effectiveToolCalls}=this._recoverThinkingOnlyFallback(',
    '({finalContent,effectiveToolCalls}=this._recoverTextBasedToolCalls(',
    'if(effectiveToolCalls.length>0){',
    'this._finalizeToolCallTurn(',
    '}else{',
    'this._finalizeSynthesisTurn(responseState,provider,uiElements,finalContent);',
    '}catch(eofError){',
    'ErrorduringSSEstream-endfinalization',
    'Failedtosaveconversationafterstream-enderror',
];
let cursor = 0;
let shapeOk = true;
for (const token of expectedOrder) {
    const idx = fc.indexOf(token, cursor);
    if (idx === -1) {
        fail(`coordinator token missing/out of order: ${token}`);
        shapeOk = false;
    } else {
        cursor = idx + token.length;
    }
}
if (shapeOk) console.log('OK  coordinator call sequence');

for (const p of [
    /Hard-enforce the tool-iteration cap/,
    /Synthesis fallback: handle degraded/,
    /If we have thinking but no content/,
    /If no structured tool_calls were streamed/,
    /Self-healing retry/,
]) {
    if (p.test(newCoord)) fail(`coordinator still contains moved text: ${p}`);
}
if (fc.length > 1600) fail(`coordinator still large (${fc.length} flat chars)`);

for (const key of ['S1', 'S2', 'S3', 'S4']) {
    const calls = (newCoord.match(new RegExp(`this\\.${NAMES[key]}\\(`, 'g')) || []).length;
    if (calls !== 1) fail(`coordinator should call ${NAMES[key]} exactly once (found ${calls})`);
}

// ── 4. Line coverage: old minus slices == coordinator (+ allow-listed) ───
let remainder = oldBody;
for (const key of ['S4', 'S3', 'S2', 'S1']) remainder = remainder.replace(slices[key], '');
const oldCounts = countLines(normalizedLines(remainder));
const newCounts = countLines(normalizedLines(newCoord));

const ALLOWED = new Map([
    ['({ finalContent, effectiveToolCalls } = this._recoverThinkingOnlyFallback(', 1],
    ['({ finalContent, effectiveToolCalls } = this._recoverTextBasedToolCalls(', 1],
    ['this._finalizeToolCallTurn(', 1],
    ['this._finalizeSynthesisTurn(responseState, provider, uiElements, finalContent);', 1],
    ['responseState,', 3],
    ['provider,', 2],
    ['finalContent,', 3],
    ['effectiveToolCalls,', 3],
    ['uiElements,', 1],
    ['));', 2],
    [');', 1],
]);
for (const [line, n] of ALLOWED) {
    const have = newCounts.get(line) || 0;
    if (have < n) {
        fail(`allow-listed coordinator line missing (${have} < ${n}): ${line}`);
        continue;
    }
    newCounts.set(line, have - n);
}
let coverageOk = true;
for (const [line, c] of oldCounts) {
    const got = newCounts.get(line) || 0;
    if (got !== c) {
        console.log(`!! LINE MISMATCH (old=${c} new=${got}): ${line.slice(0, 110)}`);
        fails++;
        coverageOk = false;
        if (fails > 14) break;
    }
}
for (const [line, c] of newCounts) {
    if (c === 0) continue;
    const o = oldCounts.get(line) || 0;
    if (o !== c) {
        console.log(`!! EXTRA LINE in coordinator (new=${c} old=${o}): ${line.slice(0, 110)}`);
        fails++;
        coverageOk = false;
        if (fails > 14) break;
    }
}
if (coverageOk) console.log('OK  line coverage (old remainder == new coordinator)');

console.log(fails === 0 ? '\nFIDELITY: PASS' : `\nFIDELITY: ${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);

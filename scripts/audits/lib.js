// Shared helpers for the fidelity audits in this directory.
//
// A fidelity audit proves a refactor was a pure code move: it extracts the
// pre-refactor method bodies from git history (`loadBaseline`), applies the
// documented mechanical transforms, and flat-compares them against the
// post-refactor sources (and extracted modules).
//
// Run all audits from the repository root via `make audit`.
//
// `loadBaseline(ref)` exits the audit with a [SKIP] notice when the git
// object is unavailable (e.g. a shallow clone) — CI checkouts default to
// fetch-depth 1, so audits are a local/gate tool unless the workflow is
// changed to fetch full history.
//
// Historical audits keep their own local copies of the compare helpers
// (extractMethod/flat/stripA11y/…): each accumulated per-audit allowances
// over time and none of them may change retroactively. New audits should
// import the shared helpers below instead.
import { execFileSync } from 'node:child_process';

export function loadBaseline(ref, file = 'extension.js') {
    try {
        return execFileSync('git', ['show', `${ref}:${file}`], {
            encoding: 'utf8',
            maxBuffer: 128 * 1024 * 1024,
        });
    } catch (e) {
        console.log(
            `[SKIP] git baseline ${ref}:${file} unavailable (${String(e.message).split('\n')[0]})`,
        );
        process.exit(0);
    }
}

/** Extract a method body by name, walking the full parameter list so
 *  multi-line signatures and destructured params work. */
export function extractMethod(src, name) {
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

/** Wrap-insensitive flat text: strips block comments, collapses whitespace,
 *  drops trailing commas before closers, collapses box-drawing runs.
 *  (Line comments are intentionally kept — compare them via allowances.) */
export function flat(text) {
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

/** Non-empty, whitespace-normalized lines (for multiset coverage checks). */
export function normalizedLines(text) {
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

export function countLines(lines) {
    const map = new Map();
    for (const l of lines) map.set(l, (map.get(l) || 0) + 1);
    return map;
}

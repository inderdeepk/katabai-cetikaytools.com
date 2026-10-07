// i18n-extract.mjs — POT generator for Katab.
//
// WHY THIS EXISTS: GNU xgettext 0.21's JavaScript parser mis-handles several
// constructs used in this codebase (nested template literals, regex literals
// containing quote characters, …) and silently stops extracting from the rest
// of a file — e.g. it missed every wrapped string past extension.js line ~3460.
// This script parses each file with a real JavaScript parser (espree, already a
// devDependency via ESLint) and collects the SAME call sites xgettext would:
//
//   _('literal')                      → msgid
//   gettext('literal')                → msgid
//   ngettext('one', 'many', n)        → msgid + msgid_plural
//
// Extraction rules:
//   - The first argument must be statically computable: a string literal, a
//     substitution-free template literal, or a `+` concatenation of those.
//     Dynamic calls (`_(variable)`) are skipped — wrap literals instead.
//   - `format(_('text with {tokens}'), { … })` works because the inner call is
//     still `_('…')`; placeholders are left verbatim in the msgid.
//
// Usage: `make pot` (or `node scripts/i18n-extract.mjs`), from the repo root.
// Sources are listed in po/POTFILES.in (one path per line, `#` comments allowed).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parse } = require('espree');

const ROOT = process.cwd();
const POT_FILE = 'po/katabai@cetikaytools.com.pot';
const POTFILES = 'po/POTFILES.in';

// ── POT helpers ─────────────────────────────────────────────────────────────

const potEscape = (str) =>
    str
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t')
        .replace(/\r/g, '\\r');

function potDate() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const abs = Math.abs(off);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}${sign}${p(Math.floor(abs / 60))}${p(abs % 60)}`;
}

function potHeader() {
    return `# SOME DESCRIPTIVE TITLE.
# Copyright (C) YEAR THE PACKAGE'S COPYRIGHT HOLDER
# This file is distributed under the same license as the Katab - AI Assistant package.
# FIRST AUTHOR <EMAIL@ADDRESS>, YEAR.
#
#, fuzzy
msgid ""
msgstr ""
"Project-Id-Version: Katab - AI Assistant\\n"
"Report-Msgid-Bugs-To: \\n"
"POT-Creation-Date: ${potDate()}\\n"
"PO-Revision-Date: YEAR-MO-DA HO:MI+ZONE\\n"
"Last-Translator: FULL NAME <EMAIL@ADDRESS>\\n"
"Language-Team: LANGUAGE <LL@li.org>\\n"
"Language: \\n"
"MIME-Version: 1.0\\n"
"Content-Type: text/plain; charset=UTF-8\\n"
"Content-Transfer-Encoding: 8bit\\n"
"Plural-Forms: nplurals=INTEGER; plural=EXPRESSION;\\n"
`;
}

// ── Static argument evaluation ──────────────────────────────────────────────

/** Return the static string value of an expression, or null. */
function staticString(node) {
    if (!node) return null;
    switch (node.type) {
        case 'Literal':
            return typeof node.value === 'string' ? node.value : null;
        case 'TemplateLiteral':
            if (node.expressions.length === 0 && node.quasis.length === 1) {
                return node.quasis[0].value.cooked ?? null;
            }
            return null;
        case 'BinaryExpression': {
            if (node.operator !== '+') return null;
            const left = staticString(node.left);
            const right = staticString(node.right);
            return left !== null && right !== null ? left + right : null;
        }
        case 'ParenthesizedExpression':
            return staticString(node.expression);
        default:
            return null;
    }
}

// ── Extraction ──────────────────────────────────────────────────────────────

const entries = new Map(); // key → { msgid, plural, refs[] }

function addEntry(msgid, plural, ref) {
    if (msgid === null || msgid === '') return;
    const key = `${msgid}\u0000${plural ?? ''}`;
    let entry = entries.get(key);
    if (!entry) {
        entry = { msgid, plural: plural ?? null, refs: [] };
        entries.set(key, entry);
    }
    if (entry.refs.length < 8) entry.refs.push(ref);
}

function walk(node, file, collect) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier') {
        const name = node.callee.name;
        if ((name === '_' || name === 'gettext') && node.arguments.length >= 1) {
            const value = staticString(node.arguments[0]);
            if (value !== null) addEntry(value, null, `${file}:${node.loc.start.line}`);
        } else if (name === 'ngettext' && node.arguments.length >= 2) {
            const singular = staticString(node.arguments[0]);
            const plural = staticString(node.arguments[1]);
            if (singular !== null && plural !== null) {
                addEntry(singular, plural, `${file}:${node.loc.start.line}`);
            }
        }
    }
    for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'range' || key === 'parent') continue;
        const value = node[key];
        if (Array.isArray(value)) {
            for (const child of value) walk(child, file, collect);
        } else if (value && typeof value === 'object') {
            walk(value, file, collect);
        }
    }
}

// ── Main ────────────────────────────────────────────────────────────────────

const potfiles = fs
    .readFileSync(path.join(ROOT, POTFILES), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

let files = 0;
let skipped = 0;
for (const file of potfiles) {
    const abs = path.join(ROOT, file);
    if (!fs.existsSync(abs)) {
        console.warn(`[i18n-extract] MISSING: ${file}`);
        skipped++;
        continue;
    }
    const source = fs.readFileSync(abs, 'utf8');
    let ast;
    try {
        ast = parse(source, {
            ecmaVersion: 'latest',
            sourceType: 'module',
            loc: true,
            comment: false,
        });
    } catch (e) {
        console.warn(`[i18n-extract] PARSE FAIL: ${file}: ${e.message}`);
        skipped++;
        continue;
    }
    walk(ast, file, null);
    files++;
}

const blocks = [];
for (const entry of entries.values()) {
    const refs = entry.refs.join(' ');
    let block = `#: ${refs}\n`;
    block += `msgid "${potEscape(entry.msgid)}"\n`;
    if (entry.plural !== null) {
        block += `msgid_plural "${potEscape(entry.plural)}"\n`;
        block += `msgstr[0] ""\nmsgstr[1] ""\n`;
    } else {
        block += `msgstr ""\n`;
    }
    blocks.push(block);
}

fs.writeFileSync(path.join(ROOT, POT_FILE), `${potHeader()}\n${blocks.join('\n')}`);
console.log(
    `[i18n-extract] ${entries.size} messages from ${files} files (${skipped} skipped) → ${POT_FILE}`,
);

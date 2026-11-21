// toolCallMarkup.js — Detection, normalization, parsing, and stripping of
// tool-call markup that degraded models emit as plain text instead of using
// structured tool_calls.  Extracted from extension.js's KatabDialog so the
// logic is unit-testable without the GNOME Shell UI.
//
// Models under context pressure (notably DeepSeek V4) obfuscate XML with
// fullwidth pipes and an invented "|DSML|" namespace (`<｜｜DSML｜｜tool_calls>`),
// invisible characters between tag letters, a space after the angle bracket
// ("< invoke", "< calls>"), or Unicode lookalike brackets/quotes.  All of it
// is routed through normalizeToolCallMarkup() before matching.

const KNOWN_TOOL_NAMES_PATTERN =
    'web_search|read_url|crawl_url|explore_docs|knowledge_search|update_knowledge|forget_knowledge|python|terminal';

const DEFAULT_POSITIONAL_PARAM_BY_TOOL = Object.freeze({
    web_search: 'query',
    knowledge_search: 'query',
    read_url: 'url',
    crawl_url: 'url',
    explore_docs: 'url',
    forget_knowledge: 'about',
    update_knowledge: 'fact',
});

/**
 * Normalize obfuscated tool-call markup to plain ASCII so the tag regexes see
 * consistent input.  Handles invisible/control characters, Unicode lookalike
 * angle brackets and quotes, fullwidth pipe fences, the invented "|DSML|"
 * namespace, a pipe directly before a tag name, and a space after the angle
 * bracket — without stripping legitimate pipes in Markdown tables, TypeScript
 * unions, regexes, or shell commands.
 *
 * `light: true` runs only the subset used by residue detection (control and
 * format characters + pipe normalization + tag spacing — no Unicode-tags-block
 * strip, no bracket/quote lookalikes).
 *
 * @param {string} text
 * @param {{light?: boolean}} [options]
 * @returns {string}
 */
export function normalizeToolCallMarkup(text, { light = false } = {}) {
    let out = String(text)
        // Control characters are exactly what this normalization exists to
        // strip, so matching them here is deliberate.
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
        .replace(
            /[\u00AD\u0600-\u0605\u061C\u06DD\u070F\u08E2\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF\uFFF9-\uFFFB]/g,
            '',
        );
    if (!light) {
        out = out
            .replace(/[\u{E0000}-\u{E007F}]/gu, '') // Unicode tags block (needs u flag)
            .replace(/[\u2039\u2329\u27E8\u3008\uFE64\uFF1C]/g, '<')
            .replace(/[\u203A\u232A\u27E9\u3009\uFE65\uFF1E]/g, '>')
            .replace(/[\u201C\u201D\u201E\uFF02]/g, '"');
    }
    return out
        .replace(/\uFF5C+/g, '|')
        .replace(/\|+\s*DSML\s*\|+/gi, '')
        .replace(/(<\/?)\s*\|+\s*(?=[a-zA-Z_])/g, '$1')
        .replace(/\|+(?=(?:tool_calls?|function_calls?|invoke|parameter|function|calls)\b)/gi, '')
        .replace(/<\s+(?=(?:tool_calls?|function_calls?|invoke|parameter|function|calls)\b)/gi, '<')
        .replace(
            /<\/\s+(?=(?:tool_calls?|function_calls?|invoke|parameter|function|calls)\b)/gi,
            '</',
        );
}

/**
 * Strip fenced code blocks when they sit inside normal prose so code examples
 * illustrating `web_search({...})` or JSON tool calls aren't mistaken for live
 * tool invocations. If the entire message IS a single fenced tool-call block
 * (common with small local models), unwrap it instead of discarding it.
 */
function maskProseCodeFences(text) {
    if (!text.includes('```')) {
        return text;
    }
    const trimmed = text.trim();
    const singleFence = trimmed.match(/^```(?:json|xml|tool_call)?\s*\n([\s\S]*?)\n?```$/i);
    if (singleFence && !singleFence[1].includes('```')) {
        return singleFence[1];
    }
    // Replace multi-line fenced code blocks with whitespace of matching length
    // so prose outside fences is scanned cleanly while code examples are ignored.
    return text.replace(/```[^\n]*\n[\s\S]*?```/g, (match) => ' '.repeat(match.length));
}

// Fallback parser: when a model (e.g. DeepSeek V4 Pro, Qwen, Llama) outputs
// tool calls as text in the content field instead of using structured
// delta.tool_calls, try to recover them so tools still execute. Handles:
//   JSON  : {"name":"read_url","arguments":{"url":"https://..."}} (or "parameters")
//   func  : read_url({"url":"https://..."})
//   XML   : <invoke name="..."><parameter name="...">...</parameter></invoke>,
//           <function>tool</function>, <function=tool>...</function>
export function parseTextToolCalls(text, knownToolNames) {
    if (!text || typeof text !== 'string' || !knownToolNames || knownToolNames.length === 0) {
        return null;
    }

    const scannable = normalizeToolCallMarkup(maskProseCodeFences(text));
    const results = [];

    // ----- JSON-object format: {"name":"tool","arguments":{...}} -----
    const jsonResults = extractJsonToolCalls(scannable, knownToolNames);
    for (const tc of jsonResults) {
        results.push(tc);
    }

    // ----- Function-call format: tool_name({...}) -----
    if (results.length === 0) {
        for (const toolName of knownToolNames) {
            const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`\\b${escaped}\\s*\\(\\s*(?=\\{)`, 'g');
            let match;
            while ((match = re.exec(scannable)) !== null) {
                const braceStart = match.index + match[0].length;
                const balanced = extractBalancedJson(scannable, braceStart);
                if (!balanced) continue;
                const afterBrace = scannable.slice(balanced.end).match(/^\s*\)/);
                if (!afterBrace) continue;
                try {
                    const args = JSON.parse(balanced.json);
                    if (args && typeof args === 'object' && !Array.isArray(args)) {
                        results.push({
                            id: `txt_${results.length}_${Date.now()}`,
                            type: 'function',
                            function: { name: toolName, arguments: JSON.stringify(args) },
                        });
                        re.lastIndex = balanced.end + afterBrace[0].length;
                    }
                } catch (_) {
                    // Not valid JSON – skip this match
                }
            }
        }
    }

    // ----- XML-ish / tagged format -----
    if (results.length === 0) {
        results.push(...extractXmlStyleToolCalls(scannable, knownToolNames));
    }

    return results.length > 0 ? results : null;
}

// Linear scan for balanced JSON objects that look like tool calls: must have
// "name" and "arguments" (or "parameters") keys where name is a known tool.
function extractJsonToolCalls(text, knownToolNames) {
    const results = [];
    const knownSet = new Set(knownToolNames);

    for (let i = 0; i < text.length; i++) {
        if (text[i] !== '{') continue;

        const balanced = extractBalancedJson(text, i);
        if (!balanced) continue;

        const raw = balanced.json;
        const hasKnownName = knownToolNames.some((n) => raw.includes(`"${n}"`));
        if (!hasKnownName) {
            // Skip past non-matching outer objects only if they don't contain
            // any known tool name anywhere inside.
            i = balanced.end - 1;
            continue;
        }

        try {
            const obj = JSON.parse(raw);
            const rawArgs = obj?.arguments !== undefined ? obj.arguments : obj?.parameters;
            if (
                obj &&
                typeof obj === 'object' &&
                !Array.isArray(obj) &&
                typeof obj.name === 'string' &&
                knownSet.has(obj.name) &&
                rawArgs !== undefined
            ) {
                results.push({
                    id: `txt_${results.length}_${Date.now()}`,
                    type: 'function',
                    function: {
                        name: obj.name,
                        arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs),
                    },
                });
                i = balanced.end - 1;
            }
        } catch (_) {
            // Not parseable JSON – continue scanning for inner objects
        }
    }
    return results;
}

// Extract a balanced JSON object string starting at offset `start` in `text`.
function extractBalancedJson(text, start = 0) {
    if (!text || text[start] !== '{') return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = start; j < text.length; j++) {
        const ch = text[j];
        if (escape) {
            escape = false;
            continue;
        }
        if (ch === '\\' && inString) {
            escape = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString) continue;
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) {
                return { json: text.slice(start, j + 1), end: j + 1 };
            }
        }
    }
    return null;
}

// Parse XML-style tool call blocks:
//   Pattern 1: <function>TOOL</function> + <parameter> pairs
//   Pattern 2: <invoke name="TOOL"> or <tool_call name="TOOL"> (supports
//              extra attributes such as DeepSeek DSML `string="true"` and
//              single quotes)
//   Pattern 3: <function=TOOL>...</function> (Qwen3 / Llama 3.x style)
function extractXmlStyleToolCalls(cleanText, knownToolNames) {
    const knownSet = new Set(knownToolNames);
    const results = [];

    // ── Pattern 1: <function>TOOL</function> + <parameter> pairs ──
    const funcRe = /<function>\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*<\/function>/g;
    let match;
    while ((match = funcRe.exec(cleanText)) !== null) {
        const name = match[1];
        if (!knownSet.has(name)) continue;

        const after = cleanText.slice(match.index + match[0].length);
        const nextFunc = after.search(/<function[=>]/i);
        const scope = nextFunc >= 0 ? after.slice(0, nextFunc) : after;

        const args = parseXmlParameters(scope, name);
        if (!args) continue;

        results.push({
            id: `txt_${results.length}_${Date.now()}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
        });
    }

    // ── Pattern 2: <invoke name="TOOL"> or <tool_call name="TOOL"> ──
    const invokeRe =
        /<(invoke|tool_call)\b[^>]*?\bname\s*=\s*["']([a-zA-Z_][a-zA-Z0-9_]*)["'][^>]*>/gi;
    while ((match = invokeRe.exec(cleanText)) !== null) {
        const tagName = match[1].toLowerCase();
        const name = match[2];
        if (!knownSet.has(name)) continue;

        const closeTag = `</${tagName}>`;
        const startIdx = match.index + match[0].length;
        const closeIdx = cleanText.toLowerCase().indexOf(closeTag, startIdx);
        const scope =
            closeIdx >= 0
                ? cleanText.slice(startIdx, closeIdx)
                : cleanText.slice(startIdx, startIdx + 1000);

        const args = parseXmlParameters(scope, name);
        if (!args) continue;

        results.push({
            id: `txt_${results.length}_${Date.now()}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
        });
    }

    // ── Pattern 3: <function=TOOL>...</function> (Qwen3 / Llama 3.x) ──
    const eqFuncRe = /<function\s*=\s*["']?([a-zA-Z_][a-zA-Z0-9_]*)["']?\s*>/gi;
    while ((match = eqFuncRe.exec(cleanText)) !== null) {
        const name = match[1];
        if (!knownSet.has(name)) continue;

        const startIdx = match.index + match[0].length;
        const closeIdx = cleanText.toLowerCase().indexOf('</function>', startIdx);
        const scope =
            closeIdx >= 0
                ? cleanText.slice(startIdx, closeIdx)
                : cleanText.slice(startIdx, startIdx + 1000);

        let args = null;
        const trimmedScope = scope.trim();
        if (trimmedScope.startsWith('{')) {
            try {
                const parsed = JSON.parse(trimmedScope);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    args = parsed;
                }
            } catch (_e) {
                /* fall through to parameter-tag parser */
            }
        }
        if (!args) {
            args = parseXmlParameters(scope, name);
        }
        if (!args) continue;

        results.push({
            id: `txt_${results.length}_${Date.now()}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
        });
    }

    return results;
}

// Parse parameter key:value pairs from an XML scope string. Handles:
//   <parameter name="key" ...>value</parameter>  (named, incl. DSML string="true")
//   <parameter=key>value</parameter>             (Qwen3 style)
//   <parameter>key</parameter><parameter>value</parameter> (positional)
function parseXmlParameters(scope, toolName = '') {
    // 1. Named-parameter style (allows extra attributes like string="true" and single quotes)
    const namedRe =
        /<parameter\b[^>]*?\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
    let nm;
    const named = {};
    while ((nm = namedRe.exec(scope)) !== null) {
        named[nm[1].trim()] = nm[2].trim();
    }
    if (Object.keys(named).length > 0) return named;

    // 2. Qwen3 `<parameter=key>value</parameter>` style
    const eqParamRe =
        /<parameter\s*=\s*["']?([a-zA-Z_][a-zA-Z0-9_]*)["']?\s*>([\s\S]*?)<\/parameter>/gi;
    while ((nm = eqParamRe.exec(scope)) !== null) {
        named[nm[1].trim()] = nm[2].trim();
    }
    if (Object.keys(named).length > 0) return named;

    // 3. Fall back to positional: <parameter>val1</parameter><parameter>val2</parameter>
    const paramRe = /<parameter>\s*([\s\S]*?)\s*<\/parameter>/gi;
    const params = [];
    let pm;
    while ((pm = paramRe.exec(scope)) !== null) {
        params.push(pm[1]);
    }
    if (params.length === 0) return null;

    if (params.length % 2 === 0) {
        const args = {};
        for (let k = 0; k < params.length; k += 2) {
            args[params[k]] = params[k + 1];
        }
        return args;
    }

    // Single param — infer required argument key from tool name
    const firstKey = DEFAULT_POSITIONAL_PARAM_BY_TOOL[toolName] || 'url';
    return { [firstKey]: params[0] };
}

// Detect whether content looks like raw tool-call markup that wasn't
// successfully parsed into structured calls.
export function contentLooksLikeToolCalls(content) {
    if (!content || typeof content !== 'string') return false;

    // Guard: if the content is large (>5000 chars) and has substantial
    // prose (newlines/paragraphs), it's likely a legitimate response
    // that happens to mention tool names — not raw tool-call markup.
    if (content.length > 5000) {
        const paragraphCount = (content.match(/\n\n/g) || []).length;
        const sentenceCount = (content.match(/[.!?]\s/g) || []).length;
        if (paragraphCount >= 2 || sentenceCount >= 5) {
            return false;
        }
    }

    const cleaned = normalizeToolCallMarkup(maskProseCodeFences(content));

    // 1. Explicit wrapper tags — definitive signal of tool-call XML.
    if (/<(?:function_calls?|tool_calls?|calls)\b[^>]*>/i.test(cleaned)) {
        log(
            `[Katab:detect] Found wrapper tag in ${content.length}-char response: ${cleaned.slice(0, 120)}`,
        );
        return true;
    }

    // 2. Invoke / function= tags with known tool names.
    const invokeNameRe = new RegExp(
        `<(?:invoke|tool_call)\\b[^>]*?\\bname\\s*=\\s*["'](?:${KNOWN_TOOL_NAMES_PATTERN})["']`,
        'i',
    );
    if (invokeNameRe.test(cleaned)) {
        log(
            `[Katab:detect] Found invoke tag in ${content.length}-char response: ${cleaned.slice(0, 120)}`,
        );
        return true;
    }
    const eqFuncRe = new RegExp(
        `<function\\s*=\\s*["']?(?:${KNOWN_TOOL_NAMES_PATTERN})["']?\\s*>`,
        'i',
    );
    if (eqFuncRe.test(cleaned)) {
        log(
            `[Katab:detect] Found function= tag in ${content.length}-char response: ${cleaned.slice(0, 120)}`,
        );
        return true;
    }

    // 3. Parameter tags in an invoke context — supplementary signal.
    if (/<parameter[\s=>]/i.test(cleaned) && /<\/(?:invoke|function|tool_call)>/i.test(cleaned)) {
        log(`[Katab:detect] Found parameter+invoke in ${content.length}-char response`);
        return true;
    }

    // 4. Raw function-call at the very START of content (not in prose).
    const trimmedStart = cleaned.trimStart();
    const rawStartRe = new RegExp(`^(?:${KNOWN_TOOL_NAMES_PATTERN})\\s*\\(\\s*\\{`, 'i');
    if (rawStartRe.test(trimmedStart)) {
        log(`[Katab:detect] Found raw function-call at start of response`);
        return true;
    }

    return false;
}

// True if `text` still contains tool-call markup after an attempted strip.
// Matches ONLY explicit tool-call tag structures (never arbitrary HTML/generic
// angle brackets like `<div>` or `Vec<String>` alongside prose words).
export function stillLooksLikeToolMarkup(text) {
    if (!text || typeof text !== 'string') return false;
    const t = normalizeToolCallMarkup(text, { light: true });
    if (/<\/?\s*(?:tool_calls?|function_calls?|invoke|parameter|calls)\b[^>]*>/i.test(t)) {
        return true;
    }
    const funcTagRe = new RegExp(
        `<function(?:\\s*=\\s*["']?(?:${KNOWN_TOOL_NAMES_PATTERN})["']?\\s*>|>\\s*(?:${KNOWN_TOOL_NAMES_PATTERN})\\s*</function>)`,
        'i',
    );
    if (funcTagRe.test(t)) {
        return true;
    }
    return false;
}

// Remove balanced JSON tool-call objects referencing known tool names without
// breaking on nested `{...}` arguments.
function stripJsonToolObjects(text) {
    const knownList = KNOWN_TOOL_NAMES_PATTERN.split('|');
    const knownSet = new Set(knownList);
    let out = '';
    let i = 0;

    while (i < text.length) {
        if (text[i] === '{') {
            const balanced = extractBalancedJson(text, i);
            if (balanced) {
                let isToolObj = false;
                try {
                    const obj = JSON.parse(balanced.json);
                    if (
                        obj &&
                        typeof obj === 'object' &&
                        !Array.isArray(obj) &&
                        typeof obj.name === 'string' &&
                        knownSet.has(obj.name) &&
                        (obj.arguments !== undefined || obj.parameters !== undefined)
                    ) {
                        isToolObj = true;
                    }
                } catch (_e) {
                    /* not valid JSON */
                }
                if (isToolObj) {
                    i = balanced.end;
                    continue;
                }
            }
        }
        out += text[i];
        i++;
    }
    return out;
}

// ── Aggressive tool-call markup stripping (handles truncated XML) ─────────
// Strips balanced and truncated tool-call XML/JSON blocks while preserving
// legitimate HTML, generic types (`Vec<String>`), Markdown tables, and code
// indentation.
export function stripTruncatedToolCallMarkup(text) {
    if (!text || typeof text !== 'string') return text;

    let cleaned = normalizeToolCallMarkup(text);

    // Remove balanced XML blocks: <function_calls?>...</function_calls?>,
    // <tool_calls?>...</tool_calls?>, <invoke>...</invoke>, <function=...>...</function>.
    cleaned = cleaned.replace(/<function_calls?\b[^>]*>[\s\S]*?<\/function_calls?>/gi, '');
    cleaned = cleaned.replace(/<tool_calls?\b[^>]*>[\s\S]*?<\/tool_calls?>/gi, '');
    cleaned = cleaned.replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, '');
    cleaned = cleaned.replace(
        new RegExp(
            `<function\\s*=\\s*["']?(?:${KNOWN_TOOL_NAMES_PATTERN})["']?\\s*>[\\s\\S]*?<\\/function>`,
            'gi',
        ),
        '',
    );
    cleaned = cleaned.replace(
        new RegExp(`<function>\\s*(?:${KNOWN_TOOL_NAMES_PATTERN})\\s*<\\/function>`, 'gi'),
        '',
    );
    cleaned = cleaned.replace(/<parameter\b[^>]*>[\s\S]*?<\/parameter>/gi, '');
    cleaned = cleaned.replace(/<parameter\s*=[^>]*>[\s\S]*?<\/parameter>/gi, '');
    cleaned = cleaned.replace(/<parameter\b[^>]*\/>/gi, '');

    // ── Handle TRUNCATED XML (no closing tag) ─────────────────────────
    cleaned = cleaned.replace(/<invoke\b[^>]*>[\s\S]*?(?=<\/?[a-zA-Z_]|$)/gi, '');
    cleaned = cleaned.replace(
        /<(?:function_calls?|tool_calls?)\b[^>]*>[\s\S]*?(?=<\/?[a-zA-Z_]|$)/gi,
        '',
    );
    cleaned = cleaned.replace(/<parameter[\s=>][^>]*>[\s\S]*?(?=\n|$)/gi, '');

    // Remove stray closing or opening tool-call-only tags (NEVER strip
    // arbitrary HTML tags or generic types like <div> or Vec<String>).
    cleaned = cleaned.replace(
        /<\/?(?:tool_calls?|function_calls?|invoke|parameter|calls)\b[^>]*\/?>/gi,
        '',
    );

    // Remove balanced JSON tool-call objects (including nested arguments)
    if (cleaned.includes('{') && cleaned.includes('"name"')) {
        cleaned = stripJsonToolObjects(cleaned);
    }

    // Remove raw function-call syntax for known tools
    const fnCallRe = new RegExp(
        `\\b(?:${KNOWN_TOOL_NAMES_PATTERN})\\s*\\(\\s*\\{(?:[^{}]|\\{[^{}]*\\})*\\}\\s*\\)`,
        'gi',
    );
    cleaned = cleaned.replace(fnCallRe, '');

    // Collapse excessive blank lines while preserving code indentation
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    cleaned = cleaned.trim();

    // ── String-based fallback (regex-resistant Unicode) ────────────────
    if (
        cleaned &&
        (cleaned.includes('<invoke') ||
            cleaned.includes('<tool_call') ||
            cleaned.includes('<function_call') ||
            cleaned.includes('<parameter'))
    ) {
        const lines = cleaned.split('\n');
        const kept = [];
        let skipUntilClose = false;
        const jsonLineRe = new RegExp(`^\\s*\\{[^}]*"(?:${KNOWN_TOOL_NAMES_PATTERN})"`);
        const fnLineRe = new RegExp(`^\\s*(?:${KNOWN_TOOL_NAMES_PATTERN})\\s*\\(`);

        for (const line of lines) {
            const trimmed = line.trim();

            if (/< *(?:invoke|tool_calls?|function_calls?)[ >]/i.test(trimmed)) {
                if (!/<\/ *(?:invoke|tool_calls?|function_calls?)>/i.test(trimmed)) {
                    skipUntilClose = true;
                }
                continue;
            }
            if (/< *parameter[\s=>]/i.test(trimmed)) {
                continue;
            }
            if (skipUntilClose && /<\/ *(?:invoke|tool_calls?|function_calls?)>/i.test(trimmed)) {
                skipUntilClose = false;
                continue;
            }
            if (/<\/ *(?:invoke|tool_calls?|function_calls?|parameter)>/i.test(trimmed)) {
                continue;
            }
            if (jsonLineRe.test(trimmed) || fnLineRe.test(trimmed)) {
                continue;
            }

            if (!skipUntilClose && trimmed) {
                kept.push(line);
            }
        }

        if (kept.length > 0) {
            cleaned = kept.join('\n').trim();
            log(
                `[Katab:strip] String-based fallback kept ${kept.length}/${lines.length} lines after regex stripping was ineffective.`,
            );
        } else {
            cleaned = '';
            log(
                `[Katab:strip] String-based fallback removed all ${lines.length} lines — content was entirely tool-call XML.`,
            );
        }
    }

    return cleaned;
}

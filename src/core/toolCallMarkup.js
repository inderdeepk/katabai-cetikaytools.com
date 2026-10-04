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

/**
 * Normalize obfuscated tool-call markup to plain ASCII so the tag regexes see
 * consistent input.  Handles invisible/control characters, Unicode lookalike
 * angle brackets and quotes, fullwidth pipe fences, the invented "|DSML|"
 * namespace, a pipe directly before a tag name, and a space after the angle
 * bracket.
 *
 * `light: true` runs only the subset used by residue detection (control and
 * format characters + pipe normalization + tag spacing — no Unicode-tags-block
 * strip, no bracket/quote lookalikes), preserving the exact behavior of the
 * former `_stillLooksLikeToolMarkup` chain.
 *
 * @param {string} text
 * @param {{light?: boolean}} [options]
 * @returns {string}
 */
export function normalizeToolCallMarkup(text, { light = false } = {}) {
    let out = String(text)
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
        .replace(/\|DSML\|/gi, '')
        .replace(/\|(?=[a-zA-Z_])/g, '')
        .replace(/<\s+(?=(?:tool_calls?|function_calls?|invoke|parameter|function|calls)\b)/gi, '<')
        .replace(
            /<\/\s+(?=(?:tool_calls?|function_calls?|invoke|parameter|function|calls)\b)/gi,
            '</',
        );
}

// Fallback parser: when a model (e.g. DeepSeek V4 Pro) outputs tool calls as
// text in the content field instead of using structured delta.tool_calls, try
// to recover them so tools still execute. Handles:
//   JSON  : {"name":"read_url","arguments":{"url":"https://..."}}
//   func  : read_url({"url":"https://..."})
//   XML   : <function>read_url</function> followed by key:value pairs
export function parseTextToolCalls(text, knownToolNames) {
    if (!text || typeof text !== 'string' || !knownToolNames || knownToolNames.length === 0) {
        return null;
    }

    const results = [];

    // ----- JSON-object format: {"name":"tool","arguments":{...}} -----
    // Use a character-by-character scan to find balanced JSON objects that
    // contain "name" and "arguments" keys referencing a known tool.
    const jsonResults = extractJsonToolCalls(text, knownToolNames);
    for (const tc of jsonResults) {
        results.push(tc);
    }

    // ----- Function-call format: tool_name({...}) -----
    if (results.length === 0) {
        for (const toolName of knownToolNames) {
            // Find tool_name followed by parenthesised JSON arguments
            const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(
                escaped + '\\s*\\(\\s*(\\{(?:[^{}]|\\{[^{}]*\\})*\\})\\s*\\)',
                'g',
            );
            let match;
            while ((match = re.exec(text)) !== null) {
                try {
                    const args = JSON.parse(match[1]);
                    results.push({
                        id: `txt_${results.length}_${Date.now()}`,
                        type: 'function',
                        function: { name: toolName, arguments: JSON.stringify(args) },
                    });
                } catch (_) {
                    // Not valid JSON – skip this match
                }
            }
        }
    }

    // ----- XML-ish / tagged format -----
    // Some models wrap tool calls in <function> or <tool_call> tags with
    // key:value parameter pairs on subsequent lines.
    if (results.length === 0) {
        results.push(...extractXmlStyleToolCalls(text, knownToolNames));
    }

    return results.length > 0 ? results : null;
}

// Scan for balanced JSON objects that look like tool calls: must have "name"
// and "arguments" keys where name is a known tool.
function extractJsonToolCalls(text, knownToolNames) {
    const results = [];
    // Find every `{` that could start a JSON tool-call object
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== '{') continue;
        const slice = text.slice(i);
        // Quick sanity: the object must mention a known tool name within the
        // first ~200 chars (avoids deeply scanning every brace).
        const head = slice.slice(0, 200);
        const hasKnownName = knownToolNames.some((n) => head.includes(`"${n}"`));
        if (!hasKnownName) continue;

        const extracted = extractBalancedJson(slice);
        if (!extracted) continue;

        try {
            const obj = JSON.parse(extracted);
            if (
                obj &&
                typeof obj === 'object' &&
                typeof obj.name === 'string' &&
                knownToolNames.includes(obj.name) &&
                obj.arguments !== undefined
            ) {
                results.push({
                    id: `txt_${results.length}_${Date.now()}`,
                    type: 'function',
                    function: {
                        name: obj.name,
                        arguments:
                            typeof obj.arguments === 'string'
                                ? obj.arguments
                                : JSON.stringify(obj.arguments),
                    },
                });
            }
        } catch (_) {
            // Not parseable JSON – skip
        }
    }
    return results;
}

// Extract a balanced JSON object string starting at position 0 of `slice`.
function extractBalancedJson(slice) {
    if (!slice || slice[0] !== '{') return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = 0; j < slice.length; j++) {
        const ch = slice[j];
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
            if (depth === 0) return slice.slice(0, j + 1);
        }
    }
    return null;
}

// Parse XML-style tool call blocks (e.g. <function>read_url</function>
// followed by <parameter>key</parameter><parameter>value</parameter> pairs).
// Also handles <invoke name="tool">, <tool_call name="tool">, and
// named-parameter styles: <parameter name="url">value</parameter>.
function extractXmlStyleToolCalls(text, knownToolNames) {
    // Strip invisible/control characters and normalize lookalikes BEFORE
    // matching — see normalizeToolCallMarkup for the full rationale.
    const cleanText = normalizeToolCallMarkup(text);

    const results = [];

    // ── Pattern 1: <function>TOOL</function> + <parameter> pairs ──
    const funcRe = /<function>\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*<\/function>/g;
    let match;
    while ((match = funcRe.exec(cleanText)) !== null) {
        const name = match[1];
        if (!knownToolNames.includes(name)) continue;

        const after = cleanText.slice(match.index + match[0].length);
        const nextFunc = after.search(/<function>/i);
        const scope = nextFunc >= 0 ? after.slice(0, nextFunc) : after;

        const args = parseXmlParameters(scope);
        if (!args) continue;

        results.push({
            id: `txt_${results.length}_${Date.now()}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
        });
    }

    // ── Pattern 2: <invoke name="TOOL"> or <tool_call name="TOOL"> ──
    // These may contain nested <parameter name="key">value</parameter> tags.
    const invokeRe = /<(?:invoke|tool_call)\s+name\s*=\s*"([a-zA-Z_][a-zA-Z0-9_]*)"\s*>/g;
    while ((match = invokeRe.exec(cleanText)) !== null) {
        const name = match[1];
        if (!knownToolNames.includes(name)) continue;

        // Find matching closing tag in the CLEAN text.
        const tagName = match[0].startsWith('<invoke') ? 'invoke' : 'tool_call';
        const closeTag = `</${tagName}>`;
        const startIdx = match.index + match[0].length;
        const closeIdx = cleanText.indexOf(closeTag, startIdx);
        const scope =
            closeIdx >= 0
                ? cleanText.slice(startIdx, closeIdx)
                : cleanText.slice(startIdx, startIdx + 500);

        const args = parseXmlParameters(scope);
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
//   <parameter>key</parameter><parameter>value</parameter>  (positional)
//   <parameter name="key">value</parameter>                  (named)
function parseXmlParameters(scope) {
    // Try named-parameter style first: <parameter name="key">value</parameter>
    const namedRe = /<parameter\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/parameter>/g;
    let nm;
    const named = {};
    while ((nm = namedRe.exec(scope)) !== null) {
        named[nm[1].trim()] = nm[2].trim();
    }
    if (Object.keys(named).length > 0) return named;

    // Fall back to positional: <parameter>val1</parameter><parameter>val2</parameter>
    const paramRe = /<parameter>\s*([\s\S]*?)\s*<\/parameter>/g;
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

    // Single param — treat as the first required arg
    const schema = getToolParamSchemaForScope();
    const firstKey = schema.length > 0 ? schema[0] : 'url';
    return { [firstKey]: params[0] };
}

// Lightweight: get param schema without needing tool name (used by XML parser).
function getToolParamSchemaForScope() {
    return ['url']; // conservative default for XML parameter recovery
}

// Detect whether content looks like raw tool-call markup that wasn't
// successfully parsed into structured calls.
//
// IMPORTANT: This must ONLY match explicit tool-call XML syntax, NOT
// casual mentions of tool names in prose.  A legitimate response about
// "web_search architecture" contains angle brackets from markdown and
// mentions tool names — that is NOT a malformed tool call.
//
// Specific patterns matched:
//   <function_calls> / <tool_calls> wrapper tags
//   <invoke name="web_search"> (with known tool name)
//   <parameter name="..."> inside an invoke context
//   Raw tool_name({...}) at the START of content (not in prose)
export function contentLooksLikeToolCalls(content) {
    if (!content || typeof content !== 'string') return false;

    // Guard: if the content is large (>5000 chars) and has substantial
    // prose (newlines/paragraphs), it's likely a legitimate response
    // that happens to mention tool names — not raw tool-call markup.
    // Raw tool-call XML from a degraded model is dense tags with no
    // natural paragraph structure.
    if (content.length > 5000) {
        const paragraphCount = (content.match(/\n\n/g) || []).length;
        const sentenceCount = (content.match(/[.!?]\s/g) || []).length;
        // A legitimate response has paragraphs and sentences.
        // Raw tool-call XML has neither.
        if (paragraphCount >= 2 || sentenceCount >= 5) {
            log(
                `[Katab:detect] Skipping — large prose response (${content.length} chars, ${paragraphCount} paras, ${sentenceCount} sentences)`,
            );
            return false;
        }
    }

    // Strip ALL invisible/control characters, normalize Unicode lookalikes of
    // <, >, " to ASCII, and repair obfuscated tag spellings.
    const cleaned = normalizeToolCallMarkup(content);

    // 1. Explicit wrapper tags — definitive signal of tool-call XML.
    // ("calls" covers the mangled "< calls>" variant, normalized above.)
    if (/<(function_calls|tool_calls|calls)>/i.test(cleaned)) {
        log(
            `[Katab:detect] Found wrapper tag in ${content.length}-char response: ${cleaned.slice(0, 120)}`,
        );
        return true;
    }

    // 2. Invoke tags with known tool names — model is trying to invoke a tool.
    if (/<invoke\s+name\s*=\s*"(?:web_search|read_url|crawl_url|python|terminal)"/i.test(cleaned)) {
        log(
            `[Katab:detect] Found invoke tag in ${content.length}-char response: ${cleaned.slice(0, 120)}`,
        );
        return true;
    }

    // 3. Parameter tags in an invoke context — supplementary signal.
    if (/<parameter\s/i.test(cleaned) && /<\/invoke>/i.test(cleaned)) {
        log(`[Katab:detect] Found parameter+invoke in ${content.length}-char response`);
        return true;
    }

    // 4. Raw function-call at the very START of content (not in prose).
    const trimmedStart = cleaned.trimStart();
    if (/^(?:web_search|read_url|crawl_url)\s*\(\s*\{/i.test(trimmedStart)) {
        log(`[Katab:detect] Found raw function-call at start of response`);
        return true;
    }

    // Debug: log what the cleaned content looks like when detection fails
    // for short responses (potential false negatives).
    if (content.length < 2000) {
        const head = cleaned.slice(0, 120);
        const m1 = /<(function_calls|tool_calls|calls)>/i.test(cleaned);
        const m2 = /<invoke\s+name\s*=\s*"(?:web_search|read_url|crawl_url|python|terminal)"/i.test(
            cleaned,
        );
        const m3 = /<parameter\s/i.test(cleaned) && /<\/invoke>/i.test(cleaned);
        log(
            `[Katab:detect] No tool-call patterns found in ${content.length}-char response. Match1=${m1} Match2=${m2} Match3=${m3} Cleaned start: ${head}`,
        );
    }
    return false;
}

// True if `text` still contains tool-call markup after an attempted strip.
// Degraded models emit obfuscated variants the tag regexes miss (fullwidth
// pipe fences, an invented "|DSML|" namespace prefix, invisible chars
// between tag letters, a space after the angle bracket, a dropped
// "tool_"/"function_" prefix), so normalize first, then look for known
// tool-call tag names inside angle brackets.
export function stillLooksLikeToolMarkup(text) {
    if (!text || typeof text !== 'string') return false;
    const t = normalizeToolCallMarkup(text, { light: true });
    return (
        /<\/?\s*[a-zA-Z_][a-zA-Z0-9_]*\b[^>]*>/.test(t) &&
        /(?:tool_calls?|function_calls?|invoke|parameter|function|\bcalls\b|read_url|web_search|crawl_url|python|terminal)/i.test(
            t,
        )
    );
}

// ── Aggressive tool-call markup stripping (handles truncated XML) ─────────
// DeepSeek V4 Pro under context pressure often emits tool-call XML that is
// TRUNCATED (no closing </invoke> tag) because the stream ends mid-output.
// This variant handles both balanced and truncated XML by stripping opening
// tags and their content up to end-of-string when no closing tag is found.
// (A previous balanced-tag-only variant, _stripToolCallMarkup, was removed as
// dead code — the live recovery paths always used this function.)
export function stripTruncatedToolCallMarkup(text) {
    if (!text || typeof text !== 'string') return text;

    let cleaned = normalizeToolCallMarkup(text);

    // Remove balanced XML blocks: <function_calls>...</function_calls>,
    // <tool_calls>...</tool_calls>, <invoke>...</invoke>.
    cleaned = cleaned.replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, '');
    cleaned = cleaned.replace(/<tool_calls>[\s\S]*?<\/tool_calls>/gi, '');
    cleaned = cleaned.replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, '');
    cleaned = cleaned.replace(/<function>\s*\w+\s*<\/function>/gi, '');
    cleaned = cleaned.replace(/<parameter\b[^>]*>[\s\S]*?<\/parameter>/gi, '');
    cleaned = cleaned.replace(/<parameter\b[^>]*\/>/gi, '');

    // ── Handle TRUNCATED XML (no closing tag) ─────────────────────────
    // Remove any remaining opening tags that have no matching close tag.
    // These are fragments like "<invoke name="crawl_url">\n<parameter ..."
    // 1. Remove orphaned <invoke ...> through end of string or next <tag
    cleaned = cleaned.replace(/<invoke\b[^>]*>[\s\S]*?(?=<\/?[a-zA-Z_]|$)/gi, '');
    // 2. Remove orphaned <function_calls> / <tool_calls> without close
    cleaned = cleaned.replace(
        /<(?:function_calls|tool_calls)\b[^>]*>[\s\S]*?(?=<\/?[a-zA-Z_]|$)/gi,
        '',
    );
    // 3. Remove any remaining <parameter ...> lines
    cleaned = cleaned.replace(/<parameter\b[^>]*>[\s\S]*?(?=\n|$)/gi, '');
    // 4. Remove any remaining <function>tool_name</function> fragments
    cleaned = cleaned.replace(/<function>\s*\w+\s*<\/function>/gi, '');

    // Remove JSON tool-call objects
    cleaned = cleaned.replace(
        /\{[^{}]*"name"\s*:\s*"(?:web_search|read_url|crawl_url|python|terminal)"[^{}]*\}/gi,
        '',
    );
    // Remove function-call syntax
    cleaned = cleaned.replace(
        /(?:web_search|read_url|crawl_url|python|terminal)\s*\(\s*\{[^{}]*\}\s*\)/gi,
        '',
    );

    // Remove stray angle-bracket fragments
    cleaned = cleaned.replace(/<\/?[a-zA-Z_][a-zA-Z0-9_]*(?:\s[^>]*)?\/?>/g, '');

    // Compact whitespace
    cleaned = cleaned.replace(/[ \t\f\v]+/g, ' ');
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    cleaned = cleaned.trim();

    // ── String-based fallback (regex-resistant Unicode) ────────────────
    // If the content still contains tool-call XML fragments (the regex
    // engine may fail to match due to Unicode whitespace that survives
    // all cleaning steps), use line-by-line string operations as a last
    // resort.  This is O(n) but only runs when regex stripping was
    // ineffective.
    if (
        cleaned &&
        (cleaned.includes('<invoke') ||
            cleaned.includes('<tool_call') ||
            cleaned.includes('<function_call') ||
            cleaned.includes('<parameter') ||
            cleaned.includes('web_search(') ||
            cleaned.includes('read_url(') ||
            cleaned.includes('crawl_url('))
    ) {
        const lines = cleaned.split('\n');
        const kept = [];
        let skipUntilClose = false;

        for (const line of lines) {
            const trimmed = line.trim();

            // Detect tool-call opening lines (any tag-like fragment)
            if (/< *(?:invoke|tool_call|function_call|parameter|function)[ >]/i.test(trimmed)) {
                skipUntilClose = true;
                continue;
            }
            // Detect closing tag while skipping
            if (skipUntilClose && /<\/ *(?:invoke|tool_call|function_call)>/i.test(trimmed)) {
                skipUntilClose = false;
                continue;
            }
            // Skip standalone closing tags
            if (/<\/ *(?:invoke|tool_call|function_call)>/i.test(trimmed)) {
                continue;
            }
            // Skip lines that are purely tool-call arguments (JSON objects with tool names)
            if (/^\s*\{[^}]*"(?:web_search|read_url|crawl_url|python|terminal)"/.test(trimmed)) {
                continue;
            }
            // Skip function-call syntax lines
            if (/^\s*(?:web_search|read_url|crawl_url|python|terminal)\s*\(/.test(trimmed)) {
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

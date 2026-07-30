// toolRegistry.js — Declarative tool registry for Katab
//
// Models Unsloth Studio's pattern: each tool is a typed object with metadata
// that the system introspects, rather than scattered if/else chains.
//
// Tool entries have:
//   name          — function name sent to the API (e.g. "web_search")
//   description   — human-readable description for schema builders
//   parameters    — JSON Schema for the function's arguments
//   dangerLevel   — "read_only" | "potentially_unsafe" (Unsloth permission model)
//   handler       — async fn(args, context) → result string
//   uiLabel       — short label for chat footer buttons
//   uiIcon        — icon name for chat footer buttons
//   command       — slash-command prefix (e.g. "/search"), or null if no command
//   resultTruncationKey — key used in truncation tier lookup

// ── Danger levels ─────────────────────────────────────────────────────────────
export const DANGER_READ_ONLY = 'read_only';
export const DANGER_POTENTIALLY_UNSAFE = 'potentially_unsafe';

// ── Registry ──────────────────────────────────────────────────────────────────

/** @type {Map<string, ToolDefinition>} */
const _registry = new Map();

/**
 * @typedef {Object} ToolDefinition
 * @property {string} name — function name
 * @property {string} description — human description
 * @property {Object} parameters — JSON Schema params
 * @property {string} dangerLevel — read_only | potentially_unsafe
 * @property {Function} handler — async (args: Object, context: HandlerContext) => string
 * @property {string} uiLabel — short footer label
 * @property {string} uiIcon — icon name
 * @property {string|null} command — slash command or null
 * @property {string} resultTruncationKey — 'search' | 'readUrl' | 'crawl' | null
 * @property {boolean} isMeta — true for meta-tools like deep_research (no API schema)
 * @property {boolean} providerScoped — true for tools that only apply to certain providers
 */

/**
 * @typedef {Object} HandlerContext
 * @property {string} provider — active provider key
 * @property {Object} settings — Gio.Settings instance
 * @property {Object} cancellable — Gio.Cancellable
 * @property {WebSearchRuntime} webSearchRuntime
 * @property {Crawl4AIRuntime} crawl4aiRuntime
 * @property {Object} counters — mutable object: { totalWebSearches, consecutiveEmptySearches, totalReadUrlFailures, consecutiveReadUrlFailures, totalReadUrlAttempts }
 */

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Register a tool definition.
 * @param {ToolDefinition} def
 */
export function registerTool(def) {
    if (!def || !def.name) {
        throw new Error('Tool definition must have a name');
    }
    _registry.set(def.name, Object.freeze(def));
}

/**
 * Look up a tool by its function name.
 * @param {string} name
 * @returns {ToolDefinition|undefined}
 */
export function lookupTool(name) {
    return _registry.get(name);
}

/**
 * Get all registered tool names.
 * @returns {string[]}
 */
export function getAllToolNames() {
    return Array.from(_registry.keys());
}

/**
 * Get all registered tool definitions.
 * @returns {ToolDefinition[]}
 */
export function getAllTools() {
    return Array.from(_registry.values());
}

/**
 * Get tools filtered by danger level.
 * @param {string} dangerLevel
 * @returns {ToolDefinition[]}
 */
export function getToolsByDanger(dangerLevel) {
    return getAllTools().filter(t => t.dangerLevel === dangerLevel);
}

/**
 * Build standard JSON Schema for all registered tools, provider-aware.
 * @param {string} provider — provider key (openai-style or anthropic)
 * @returns {Object[]}
 */
export function buildAllToolSchemas(provider = 'openai') {
    const schemas = [];
    for (const tool of _registry.values()) {
        if (tool.isMeta) continue; // meta-tools don't have API schemas
        if (!tool.parameters) continue;
        if (provider === 'anthropic') {
            schemas.push({
                name: tool.name,
                description: tool.description,
                input_schema: tool.parameters,
            });
        } else {
            schemas.push({
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                },
            });
        }
    }
    return schemas;
}

/**
 * Build schemas only for tools whose names match the given set.
 * Used when we need to advertise a subset (e.g., exclude crawl4ai when disabled).
 * @param {string[]} toolNames
 * @param {string} provider
 * @returns {Object[]}
 */
export function buildToolSchemasFor(toolNames, provider = 'openai') {
    const schemas = [];
    for (const name of toolNames) {
        const tool = _registry.get(name);
        if (!tool || tool.isMeta || !tool.parameters) continue;
        if (provider === 'anthropic') {
            schemas.push({
                name: tool.name,
                description: tool.description,
                input_schema: tool.parameters,
            });
        } else {
            schemas.push({
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                },
            });
        }
    }
    return schemas;
}

/**
 * Clear the registry (mainly for testing).
 */
export function clearRegistry() {
    _registry.clear();
}

// ── Placeholder handler (set by extension.js on init) ─────────────────────────
// Tools that depend on runtime state (WebSearchRuntime, Crawl4AIRuntime,
// settings) register a placeholder and have their handlers swapped at init time.
// See _initToolRegistry() in extension.js.

/**
 * Create a placeholder handler that logs and returns an error.
 * @param {string} toolName
 * @returns {Function}
 */
export function createNotReadyHandler(toolName) {
    return async (_args, _ctx) => `Tool "${toolName}" handler not yet wired.`;
}

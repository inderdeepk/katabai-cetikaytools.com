// Katab AI — shared gettext bridge.
//
// GNOME 45+ extensions receive gettext/ngettext from the shell's module
// resources (`resource:///org/gnome/shell/extensions/extension.js` and the
// prefs equivalent), but those imports only resolve inside the running shell
// processes and would break the plain-gjs import smoke test. Every module
// therefore translates through this tiny shim; the two entry points
// (extension.js `enable()`, prefs.js `fillPreferencesWindow()`) inject the
// real functions once via `initI18n()`.
//
// Until initialization happens — unit tests, import smoke, or any context
// without gettext — the shim passes strings through untranslated, so callers
// are safe to use `gettext()` unconditionally. Translations are loaded by the
// shell from `locale/<lang>/LC_MESSAGES/<uuid>.mo` (see `make pot` / `make
// langs` and the Translations section of CONTRIBUTING.md).
let gettextFn = (str) => str;
let ngettextFn = (singular, plural, count) => (count === 1 ? singular : plural);

/**
 * Inject the real gettext functions from the shell resources.
 * Missing/invalid arguments leave the previous implementation in place.
 */
export function initI18n({ gettext, ngettext } = {}) {
    if (typeof gettext === 'function') gettextFn = gettext;
    if (typeof ngettext === 'function') ngettextFn = ngettext;
}

/** Translate a string (identity until initI18n() runs). */
export function gettext(str) {
    return gettextFn(str);
}

/** Translate a plural form (identity until initI18n() runs). */
export function ngettext(singular, plural, count) {
    return ngettextFn(singular, plural, count);
}

/**
 * Substitute `{name}`-style placeholders in a translated string.
 *
 *   format(_('Delete preset "{name}"'), { name: preset.name })
 *
 * Unknown placeholders are left verbatim (a half-applied call stays visible
 * instead of silently losing text). Omitting `params` is a no-op, so callers
 * can pass it through unconditionally.
 */
export function format(str, params) {
    if (typeof str !== 'string' || !params) return str;
    return str.replace(/\{(\w+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match,
    );
}

// networkGuard.js — Shared SSRF protection helpers for Katab tools
// Used by both webSearchTools.js and crawl4aiTools.js

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// ---- IPv4 private / reserved ranges ------------------------------------------

export function isPrivateIPv4(host) {
    const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!match) {
        return false;
    }

    const octets = match.slice(1).map(Number);
    if (octets.some(value => value > 255)) {
        return false;
    }

    const [a, b, c] = octets;
    if (a === 10 || a === 127 || a === 0) {
        return true;
    }
    if (a === 169 && b === 254) {
        return true; // link-local
    }
    if (a === 172 && b >= 16 && b <= 31) {
        return true;
    }
    if (a === 192 && b === 168) {
        return true;
    }
    if (a === 100 && b >= 64 && b <= 127) {
        return true; // carrier-grade NAT
    }
    // 192.0.0.0/16 is NOT private as a whole — only the reserved /24 sub-blocks
    // 192.0.0.0/24 (IETF protocol assignments) and 192.0.2.0/24 (TEST-NET-1) are.
    // The rest of the /16 (e.g. Netlify's public edge 192.0.66.x) is routable and
    // must not be blocked or read_url silently fails on legit CDN-hosted sites.
    if (a === 192 && b === 0 && (c === 0 || c === 2)) {
        return true;
    }
    if (a === 198 && (b === 18 || b === 19)) {
        return true; // benchmark networks
    }
    if (a >= 224) {
        return true; // multicast and reserved ranges
    }

    return false;
}

// ---- IPv6 blocked ranges -----------------------------------------------------

export function isBlockedIPv6(host) {
    const value = host.toLowerCase();
    if (value === '::1' || value === '::') {
        return true;
    }
    if (value.startsWith('fc') || value.startsWith('fd')) {
        return true; // unique local fc00::/7
    }
    if (value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')) {
        return true; // link-local fe80::/10
    }
    const mapped = value.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) {
        return isPrivateIPv4(mapped[1]);
    }

    return false;
}

// ---- Host-level check --------------------------------------------------------

export function isBlockedHost(host, allowLocal) {
    if (allowLocal) {
        return false;
    }
    if (!host) {
        return true;
    }

    let value = host.toLowerCase();
    if (value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1);
    }

    if (value === 'localhost' || value.endsWith('.localhost') || value.endsWith('.local')) {
        return true;
    }
    if (isPrivateIPv4(value)) {
        return true;
    }
    if (value.includes(':') && isBlockedIPv6(value)) {
        return true;
    }

    return false;
}

// ---- URL-level validation (throws on blocked URLs) ---------------------------

export function assertFetchableUrl(rawUrl, { allowLocal = false } = {}, errorClass = null) {
    const url = (rawUrl || '').trim();
    if (!url) {
        const errMsg = 'No URL was provided.';
        if (errorClass) {
            throw new errorClass(errMsg, { code: 'no-url' });
        }
        throw new Error(errMsg);
    }

    let uri;
    try {
        uri = GLib.Uri.parse(url, GLib.UriFlags.NONE);
    } catch (_error) {
        const errMsg = `"${url}" is not a valid URL.`;
        if (errorClass) {
            throw new errorClass(errMsg, { code: 'invalid-url' });
        }
        throw new Error(errMsg);
    }

    const scheme = (uri.get_scheme() || '').toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
        const errMsg = 'Only http and https URLs can be used.';
        if (errorClass) {
            throw new errorClass(errMsg, { code: 'bad-scheme' });
        }
        throw new Error(errMsg);
    }

    const host = uri.get_host() || '';
    if (isBlockedHost(host, allowLocal)) {
        const errMsg = `Access to ${host || 'that address'} is blocked because it points to a private or local network. Enable local addresses in Settings if you trust it.`;
        if (errorClass) {
            throw new errorClass(errMsg, { code: 'blocked-host' });
        }
        throw new Error(errMsg);
    }

    return url;
}

// ---- URL helpers -------------------------------------------------------------

export function getUrlHost(url) {
    try {
        return GLib.Uri.parse(url, GLib.UriFlags.NONE).get_host() || '';
    } catch (_error) {
        return '';
    }
}

export function resolveRedirectUrl(baseUrl, location) {
    const target = (location || '').trim();
    if (!target) {
        throw new Error('The page redirected without a Location header.');
    }
    try {
        return GLib.Uri.resolve_relative(baseUrl, target, GLib.UriFlags.NONE);
    } catch (_error) {
        throw new Error('The page redirected to an invalid URL.');
    }
}

// ---- Async DNS resolution ----------------------------------------------------

export function lookupHostAddresses(host, cancellable = null) {
    return new Promise((resolve, reject) => {
        try {
            const resolver = Gio.Resolver.get_default();
            resolver.lookup_by_name_async(host, cancellable, (source, result) => {
                try {
                    resolve(source.lookup_by_name_finish(result) || []);
                } catch (error) {
                    reject(error);
                }
            });
        } catch (error) {
            reject(error);
        }
    });
}

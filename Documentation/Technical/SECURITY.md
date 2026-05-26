# Security Policy

## Supported Versions

Currently, the main branch of `katabai-cetikaytools.com` is supported with security updates.

## Reporting a Vulnerability

We take the security of Katab seriously. If you discover a security vulnerability or if you believe an API key or a secret has been accidentally exposed, please let us know immediately.

1. **Do not** open a public issue regarding the vulnerability.
2. Please report the issue privately. (Provide contact instructions here, e.g., email the repository owner or use GitHub's private vulnerability reporting feature).
3. Be sure to include full details of the vulnerability and steps to reproduce.

### API Key Best Practices
- Never commit `sk-...` formatted keys to source code or documentation.
- Rely on GNOME's GSettings via `prefs.js` for inputting secrets into the extension.

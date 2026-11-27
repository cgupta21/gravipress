# Security Policy

## Supported Version

| Version | Supported |
| ------- | --------- |
| `v1.2.2` (`release/v1.0-non-multimedia`) | Yes |
| Earlier versions (`< v1.2.2`) | No |

## Reporting a Vulnerability

Please **do not** report security vulnerabilities through public GitHub issues. Publicly disclosing unpatched security details can put users at risk.

- **Preferred method:** Use GitHub's **Private Vulnerability Reporting** feature on the [cgupta21/gravipress Security tab](https://github.com/cgupta21/gravipress/security/advisories), if enabled.
- If private vulnerability reporting is not available, open a minimal public issue asking for a private channel **without** including exploit details, payloads, or sensitive test files.

## Security Bugs vs. Ordinary Bug Reports

- **Security vulnerabilities** include issues such as Content Security Policy (CSP) bypasses, cross-site scripting (XSS), archive path-traversal/Zip-slip defects, unintended network transmission of user files, or service worker cache/update authorization flaws.
- **Ordinary bug reports** (UI glitches, browser codec availability messages, compression ratio expectations, or non-security crashes) should be submitted via [GitHub Issues](https://github.com/cgupta21/gravipress/issues) using non-sensitive test files.

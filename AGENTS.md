# Agent Instructions

## Version bump

Root package:

```
npm version patch --no-git-tag-version
```

Subpackage (run inside the subpackage directory, use `version patch` there; do not use `--prefix`):

```
cd lm-tools-bridge-proxy
npm version patch --no-git-tag-version
```

## Publish

- Publish the proxy from inside `lm-tools-bridge-proxy` (use `npm publish` there; do not use `--prefix`).

Example:

```
cd lm-tools-bridge-proxy
npm publish
```
- Do not use `npm --prefix ... publish`; it can publish the root `lm-tools-bridge` by mistake.
- The root package requires 2FA (OTP) for publish/unpublish.

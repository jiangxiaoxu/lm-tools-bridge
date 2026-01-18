# Agent Instructions

## Version Bump

When asked to bump the version, run this command from the repository root:

```
npm version patch --no-git-tag-version
```

For subpackages, run the version bump with an explicit prefix, for example:

```
npm --prefix lm-tools-bridge-proxy version patch --no-git-tag-version
```

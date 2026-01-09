# LM Tools Dump

Minimal VS Code extension that dumps `vscode.lm.tools` to the Output panel.

## Usage

1. Open the extension in VS Code.
2. Run `npm install`.
3. Press `F5` to launch the Extension Development Host.
4. In the Extension Development Host, press `Ctrl+Shift+P` and run `lm-tools-dump`.
5. Check Output -> `LM Tools`.

## Development

- Build once: `npm run compile`
- Watch mode: `npm run watch`

## Notes

- Requires a VS Code version that exposes the `vscode.lm` API (see `package.json` engines).

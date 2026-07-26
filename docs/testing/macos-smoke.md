# Cloud Inn macOS Smoke Test

- [ ] `npm run tauri dev` opens one window titled Cloud Inn.
- [ ] Hotel overview is the initial view.
- [ ] Floor Canvas displays one gold marker on a dark background.
- [ ] Resizing the window keeps one canvas and produces no visible stretching artifacts.
- [ ] Navigating away and back does not create duplicate canvases.
- [ ] Closing and reopening the development app succeeds.
- [x] `npm run tauri build -- --debug` creates a debug app bundle.
- [ ] Opening the debug app repeats the same navigation and resize behavior.

Playwright covers the Vite frontend in Chromium; this checklist covers the macOS WKWebView shell.

## Verification record

- Automated gates passed: clean npm install, TypeScript, 11 unit/component tests, Vite build, 1 Chromium E2E test, Rust tests, Clippy with warnings denied, and rustfmt check.
- `npm run tauri dev` compiled and launched `target/debug/app` successfully.
- The debug bundle was created at `app/src-tauri/target/debug/bundle/macos/Cloud Inn.app`, launched successfully, and was then closed cleanly.
- Visual checklist items remain unchecked because the Mac was locked during verification and Computer Use could not inspect the WKWebView. They must not be inferred from process-level checks.

## Environment

- Architecture: `arm64`
- macOS: `26.5.2` (`25F84`)

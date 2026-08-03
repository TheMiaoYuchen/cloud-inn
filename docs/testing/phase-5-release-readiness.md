# Cloud Inn Phase 5 macOS Release Readiness

Updated: 2026-08-02 (Asia/Shanghai)

## Release identity

- Product: Cloud Inn
- Bundle identifier: `com.cloudinn.game`
- Current application version: `0.1.0`
- Target: macOS application and DMG
- Keychain account: `nanobanana`
- Production Keychain service: `com.cloudinn.game.api-nebula`
- Development and smoke credentials use isolated bundle/environment scopes.

## Implemented security boundaries

- Provider networking and Keychain access remain in native Rust.
- There is no token getter command and no plaintext credential fallback.
- Production CSP does not allow a provider network origin; `cloudinn-asset:` is image-only.
- Save names never enter filesystem paths; new/imported saves use backend UUIDs.
- Provider preferences and attempt accounting are application-wide, outside individual saves.
- Errors and panic output pass through bounded secret redaction.

## Packaging prerequisites

| Item | Status | Notes |
|---|---|---|
| App/DMG local build | Complete (2026-08-02) | Apple Silicon arm64, macOS 26.5.2; unsigned local artifacts. |
| Hardened runtime | Pending release decision | Do not enable/sign until release authority is provided. |
| Developer ID certificate | Not inspected | Requires the developer's Apple account/certificate choice. |
| Notarization credentials | Not configured | Requires a separate release decision. |
| Stapling | Not performed | Depends on successful notarization. |
| Entitlements audit | Pending final native feature set | Keychain and network usage must be checked against the final bundle. |
| Update strategy | Pending product decision | Version 1 ships without silently enabling an updater. |

## Browser acceptance evidence (2026-08-02)

- TypeScript typecheck passes after the deterministic browser archive round-trip path was added.
- Focused Vitest passes for browser reliability, first-run and save-manager workflows (13 tests).
- Playwright `phase5-reliability.spec.ts` covers first-run optional AI, offline queue persistence/cancellation, save create/rename, and browser export -> inspect -> import into a fresh save.
- Browser fallback remains an offline simulation; native provider, archive, recovery, Keychain and macOS shell gates remain pending below.

## Native package evidence (2026-08-02)

- App: `app/src-tauri/target/release/bundle/macos/Cloud Inn.app` (18 MB), arm64 Mach-O.
- DMG: `app/src-tauri/target/release/bundle/dmg/Cloud Inn_0.1.0_aarch64.dmg` (6.6 MB).
- SHA-256 (app executable, exact release commit `cfd1dab359370eea4fa0634d168bf6978d17f9ff`): `b294c6be306359f6ccdc431f94a5afe337625970f293bd51dc76f1c317a194bf`.
- SHA-256 (DMG): `e46bd698b193875ca51e84a9f78481a4695e89e69193c6f6e7d14a4f43ced8a5`.
- Bundle uses the expected `com.cloudinn.game` identifier and an ad-hoc linker signature; Developer ID signing, notarization and stapling were not performed.
- Accelerated equivalent soak: 720 cycles (the 120-minute run's 10-second sampling count) at 100ms intervals passed in 1m24s on the current Mac. The real-time 120-minute wall-clock mode remains available with `CLOUD_INN_SOAK_MINUTES=120`.

## Final gate still required

- Exact-SHA App and DMG build with SHA-256 hashes.
- Visual inspection of all icon sizes and the generated `.icns`.
- Menu, window sizing, full-screen and off-screen restoration smoke tests.
- Isolated Keychain set/status/delete smoke proving production entries remain unchanged.
- Real Phase 4 database migration and reopen.
- Recovery crash matrix, archive adversarial suite and secret scan.
- Maximum-fixture RSS measurement and two-hour soak.
- Record macOS version, architecture, bundle paths and every unperformed check explicitly.

Signing, notarization, stapling and publication are deliberately excluded until a separate release decision is made.

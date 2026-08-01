# Cloud Inn Phase 5 macOS Release Readiness

Updated: 2026-08-01 (Asia/Shanghai)

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
| App/DMG local build | Pending final gate | Rebuild after the last code change. |
| Hardened runtime | Pending release decision | Do not enable/sign until release authority is provided. |
| Developer ID certificate | Not inspected | Requires the developer's Apple account/certificate choice. |
| Notarization credentials | Not configured | Requires a separate release decision. |
| Stapling | Not performed | Depends on successful notarization. |
| Entitlements audit | Pending final native feature set | Keychain and network usage must be checked against the final bundle. |
| Update strategy | Pending product decision | Version 1 ships without silently enabling an updater. |

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

# Phase 1 Desktop Smoke Test

Use this checklist for a packaged desktop build. Record the macOS version, CPU architecture, and commit under test before starting.

## Fixed prototype values

- New room: 24㎡; build cost ¥116,000; suggested rate ¥800.
- Starting cash: ¥1,000,000. Four rooms reduce cash by ¥464,000, leaving ¥536,000.
- Day 1 at ¥800: 3 sold / 4 available; revenue ¥2,400; operating cost ¥770; net ¥1,630.
- Day 2 at ¥1,600: 0 sold / 4 available; operating cost ¥320.

## Executable smoke path

1. Launch the desktop app and create a new save.
2. Open Design, load the 24㎡ example, and verify the metrics above. Name it `云岫商务房` and save the room type.
3. On Floor, place rooms in northwest, northeast, southwest, and southeast slots. Verify four rooms are built and cash is ¥536,000.
4. Enter Operations, request the visual preview, and verify its state is shown without storing the image as Base64 data. Start business (or confirm the existing flow opens business immediately), set the rate to ¥800, and settle day 1. Verify the day 1 report values above.
5. Set the rate to ¥1,600, update, and settle day 2. Verify 0/4 sold and ¥320 operating cost.
6. Close and reopen the app. Verify day 2, cash, rate, blueprint name/24㎡ metrics, four rooms, visual state, and both reports are preserved.
7. Disable the network and settle another day. Verify settlement completes using local data and reports remain readable.
8. Inspect the local database/persistence records: confirm no Base64 image payloads and no API tokens or other secrets are stored.

## Run record

- macOS version: ____________________
- Architecture (for example, arm64): ____________________
- Commit: ____________________
- Result / notes: ____________________

import tauriConfig from "../../../src-tauri/tauri.conf.json";
import { describe, expect, it } from "vitest";

type Csp = Record<string, string[]>;

describe("production Tauri CSP", () => {
  it("admits only application assets and the image resolver", () => {
    const csp = tauriConfig.app.security.csp as Csp;

    expect(csp["default-src"]).toEqual(["'self'"]);
    expect(csp["img-src"]).toEqual(["'self'", "cloudinn-asset:"]);
    expect(csp["connect-src"]).toEqual(["'self'", "ipc:", "http://ipc.localhost"]);
    expect(csp["connect-src"]).not.toContain("https:");
    expect(csp["connect-src"]).not.toContain("http:");
    expect(csp["worker-src"]).toEqual(["'none'"]);
    expect(csp["object-src"]).toEqual(["'none'"]);
    expect(csp["form-action"]).toEqual(["'none'"]);
    expect(csp["frame-ancestors"]).toEqual(["'none'"]);
    expect(csp["frame-src"]).toEqual(["'none'"]);
    expect(csp["child-src"]).toEqual(["'none'"]);
    expect(csp["media-src"]).toEqual(["'none'"]);
  });
});

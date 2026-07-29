import { describe, expect, it } from "vitest";
import { RELIABILITY_ERROR_CODES } from "../domain/reliability/reliabilityTypes";
import {
  PLAYER_ERROR_COPY,
  toPlayerError,
  type PlayerError,
} from "./playerError";

const SECRET_SENTINEL = "sk-cloud-inn-super-secret-sentinel";

function expectCompletePlayerError(error: PlayerError): void {
  expect(error.code).not.toBe("");
  expect(error.whatHappened.trim()).not.toBe("");
  expect(error.whatIsSafe.trim()).not.toBe("");
  expect(error.nextAction.trim()).not.toBe("");
}

describe("player error mapping", () => {
  it("exhaustively maps every stable native error code", () => {
    expect(Object.keys(PLAYER_ERROR_COPY).sort()).toEqual(
      [...RELIABILITY_ERROR_CODES].sort(),
    );

    RELIABILITY_ERROR_CODES.forEach((code) => {
      const error = toPlayerError({ code });
      expect(error.code).toBe(code);
      expectCompletePlayerError(error);
    });
  });

  it("uses the four-part player language contract for a known error", () => {
    expect(toPlayerError({ code: "provider.quota-exceeded" })).toEqual({
      code: "provider.quota-exceeded",
      whatHappened: "今天的图片请求额度已经用完。",
      whatIsSafe: "酒店、资金与设计蓝图没有因本次请求而改变。",
      nextAction: "请等待下一个 UTC 日期，或谨慎调整每日上限。",
    });
  });

  it("does not forward secret-bearing native fields into player output", () => {
    const nativeFailure = {
      code: "network.timeout",
      message: `Bearer ${SECRET_SENTINEL}`,
      token: SECRET_SENTINEL,
      authorization: `Bearer ${SECRET_SENTINEL}`,
      request: {
        prompt: SECRET_SENTINEL,
        inlineData: `data:image/png;base64,${SECRET_SENTINEL}`,
      },
      response: {
        body: SECRET_SENTINEL,
      },
      path: `/Users/player/${SECRET_SENTINEL}/save.sqlite3`,
    };

    const serialized = JSON.stringify(toPlayerError(nativeFailure));
    expect(serialized).not.toContain(SECRET_SENTINEL);
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("base64");
    expect(serialized).not.toContain("/Users/");
    expect(Object.keys(toPlayerError(nativeFailure))).toEqual([
      "code",
      "whatHappened",
      "whatIsSafe",
      "nextAction",
    ]);
  });

  it.each([
    new Error(SECRET_SENTINEL),
    SECRET_SENTINEL,
    { code: "provider.not-a-real-code", detail: SECRET_SENTINEL },
    { message: SECRET_SENTINEL },
    null,
    undefined,
  ])("maps unknown failures to bounded safe copy", (failure) => {
    const error = toPlayerError(failure);
    expect(error.code).toBe("unknown.unexpected");
    expectCompletePlayerError(error);
    expect(JSON.stringify(error)).not.toContain(SECRET_SENTINEL);
  });

  it("does not invoke an untrusted error-code getter", () => {
    const codeGetter = () => {
      throw new Error(SECRET_SENTINEL);
    };
    const failure = Object.defineProperty({}, "code", { get: codeGetter });

    expect(toPlayerError(failure).code).toBe("unknown.unexpected");
  });

  it("never stores forbidden diagnostic fields in the mapping", () => {
    const serialized = JSON.stringify(PLAYER_ERROR_COPY);

    [
      SECRET_SENTINEL,
      "authorization",
      "responseBody",
      "inlineData",
      "data:image",
      "file://",
      "/Users/",
    ].forEach((forbidden) => expect(serialized).not.toContain(forbidden));
  });
});

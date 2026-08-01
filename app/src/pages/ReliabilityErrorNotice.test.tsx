import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReliabilityErrorNotice } from "./ReliabilityErrorNotice";

describe("ReliabilityErrorNotice", () => {
  it("renders the stable player-safe four-part contract for adapter errors", () => {
    render(<ReliabilityErrorNotice error={new Error("save.conflict")} prefix="操作未完成" />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("操作未完成");
    expect(alert).toHaveTextContent("存档已经被另一项操作更新。");
    expect(alert).toHaveTextContent("较新的存档内容已保留。");
    expect(alert).toHaveTextContent("请刷新后重新检查并再次操作。");
    expect(alert).toHaveTextContent("save.conflict");
  });

  it("does not expose unknown error messages", () => {
    render(<ReliabilityErrorNotice error={new Error("secret-token-value")} />);
    expect(screen.getByRole("alert")).not.toHaveTextContent("secret-token-value");
    expect(screen.getByRole("alert")).toHaveTextContent("unknown.unexpected");
  });
});

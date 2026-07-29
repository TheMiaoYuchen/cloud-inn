import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { App } from "../app/App";
import { InMemorySavePort } from "../infrastructure/memory/InMemorySavePort";
import { createPhase4AcceptanceState } from "../testing/phase4Fixtures";

it("initializes an eligible legacy hotel without changing its cash", async () => {
  const state = createPhase4AcceptanceState("save-1");
  state.revision = 1;
  state.phase = "open";
  state.cashCents = 123_456_700;
  delete state.phase4;
  const port = new InMemorySavePort();
  await port.commit(0, state);
  const user = userEvent.setup();
  window.location.hash = "#/";
  render(<App savePort={port} />);

  const cash = await screen.findByTestId("hotel-cash-cents");
  expect(cash).toHaveAttribute("data-value", String(state.cashCents));
  await user.click(screen.getByRole("button", { name: "启用塔楼与公共空间" }));

  const saved = await port.load(state.saveId);
  expect(saved?.phase4).toBeDefined();
  expect(saved?.cashCents).toBe(state.cashCents);
});

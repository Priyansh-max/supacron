import test from "node:test";
import assert from "node:assert/strict";

import { choiceLine, color, renderBanner, status, supportsColor } from "../src/ui.js";

test("terminal UI disables color outside TTY and when NO_COLOR is set", () => {
  assert.equal(supportsColor({ isTTY: false }, {}), false);
  assert.equal(supportsColor({ isTTY: true }, { NO_COLOR: "1" }), false);
  assert.equal(supportsColor({ isTTY: true }, { TERM: "dumb" }), false);
  assert.equal(supportsColor({ isTTY: true }, {}), true);
});

test("terminal UI keeps non-TTY output clean and structured", () => {
  let buffer = "";
  const out = {
    isTTY: false,
    write(chunk) {
      buffer += chunk;
    },
  };

  assert.equal(color(out, "green", "ok"), "ok");
  status(out, "success", "Done");
  assert.equal(buffer, "  [ok] Done\n");
});
test("terminal UI renders a compact branded setup banner", () => {
  let buffer = "";
  const out = {
    isTTY: false,
    write(chunk) {
      buffer += chunk;
    },
  };

  renderBanner(out, "SUPACRON");

  assert.match(buffer, /\+-+\+/);
  assert.match(buffer, /\| SUPACRON\s+\|/);
  assert.match(buffer, /Private cron, visible proof/);
  assert.match(buffer, /Cloudflare runs the timer/);
  assert.doesNotMatch(buffer, /\x1b\[/);
});

test("terminal UI places the active selection marker on the right", () => {
  const out = { isTTY: false };
  const choice = {
    label: "Twice daily (recommended)",
    description: "0 0,12 * * *",
  };

  assert.equal(
    choiceLine(out, choice, true, 48),
    "  Twice daily (recommended) - 0 0,12 * * *         <",
  );
  assert.equal(
    choiceLine(out, choice, false, 48),
    "  Twice daily (recommended) - 0 0,12 * * *",
  );
});

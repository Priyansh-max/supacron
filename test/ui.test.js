import test from "node:test";
import assert from "node:assert/strict";

import { color, status, supportsColor } from "../src/ui.js";

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
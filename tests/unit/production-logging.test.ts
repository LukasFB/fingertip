import assert from "node:assert/strict";
import test from "node:test";

import { lockProductionLogLevel } from "../../src/production-logging.ts";

test("plugin bootstrap locks SDK logging to info", () => {
  const selected: string[] = [];
  lockProductionLogLevel({
    setLevel(level) {
      selected.push(level);
    },
  });

  assert.deepEqual(selected, ["info"]);
});

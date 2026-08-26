import assert from "node:assert/strict";
import { history } from "../docs/js/store.js";

history.clear();
history.setLimit(2);
history.add({ marker: 1 });
history.add({ marker: 2 });
history.add({ marker: 3 });
assert.deepEqual(history.all().map((item) => item.marker), [3, 2]);

history.setLimit(1);
assert.deepEqual(history.all().map((item) => item.marker), [3]);

history.setLimit(0);
history.add({ marker: 4 });
history.add({ marker: 5 });
assert.deepEqual(history.all().map((item) => item.marker), [5, 4, 3]);

history.clear();
console.log("store tests passed");

import assert from "node:assert/strict";
import { quotaPolicy, recordSuccessfulImage } from "../docs/js/quota-policy.js";

const status = (imageUsed, tempRemaining, overrides = {}) => ({
  temporaryChecked: true,
  image: { used: imageUsed, remaining: 1000 - imageUsed, limit: 1000 },
  temporary: {
    isTemp: true,
    limited: true,
    used: 1000 - tempRemaining,
    remaining: tempRemaining,
    limit: 1000,
    ...overrides
  }
});

assert.deepEqual(quotaPolicy(status(400, 299)), {
  imageUsed: 400,
  imageRemaining: 600,
  imageLimit: 1000,
  tempRemaining: 299,
  unitsRemaining: null,
  unitsLimit: null,
  resetSeconds: null,
  serialUnavailable: false,
  serialDisabled: true,
  warning: false
});
assert.equal(quotaPolicy(status(401, 299.9)).warning, true);
assert.equal(quotaPolicy(status(401, 300)).serialDisabled, false);
assert.equal(quotaPolicy(status(900, 0, { isTemp: false })).serialDisabled, false);
assert.equal(quotaPolicy(null).serialDisabled, true);
assert.equal(quotaPolicy(status(null, null)).serialDisabled, true);
assert.equal(quotaPolicy({ temporaryChecked: true, image: null, temporary: null }).serialDisabled, false);

const consumed = recordSuccessfulImage(status(539, 300.1));
assert.equal(consumed.image.used, 540);
assert.equal(consumed.image.remaining, 460);
assert.equal(consumed.temporary.used, 700.9);
assert.equal(consumed.temporary.remaining, 299.1);
assert.equal(quotaPolicy(consumed).serialDisabled, true);

console.log("quota policy tests passed");

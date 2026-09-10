import assert from "node:assert/strict";
import { quotaPolicy } from "../docs/js/quota-policy.js";
import { normalizeQuota } from "../docs/js/quota-normalize.js";

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

const media = { period: "weekly", images: { "novelai-v5": { used: 2, remaining: 248, limit: 250 }, "novelai-v4.5": { used: 1, remaining: 1999, limit: 2000 } } };
const stats = { temp_limits: { is_temp: true, limited: true, rpd_remaining: 539, rpd_remaining_units: 4610, rpd_units: 10000 } };
const normalized = normalizeQuota(media, stats, true, "novelai-v5");
assert.equal(normalized.image.remaining, 248);
assert.equal(normalized.temporary.remaining, 539);
assert.equal(normalized.temporary.unitsRemaining, 4610);
assert.equal(normalizeQuota(media, stats, true, "novelai-v4.5").image.remaining, 1999);
assert.equal(normalizeQuota(media, stats, true, "missing").image, null);
assert.deepEqual(normalizeQuota(media, stats, true, "novelai-v5"), normalized, "normalization never infers consumption");

console.log("quota policy tests passed");

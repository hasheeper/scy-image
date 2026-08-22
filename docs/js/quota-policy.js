export const IMAGE_USED_WARNING_THRESHOLD = 400;
export const TEMP_REMAINING_SERIAL_THRESHOLD = 300;

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function quotaPolicy(status) {
  const imageUsed = finite(status?.image?.used);
  const tempRemaining = finite(status?.temporary?.remaining);
  const temporaryChecked = status?.temporaryChecked === true;
  const limitedTemporaryKey = status?.temporary?.isTemp === true
    && status?.temporary?.limited !== false;
  const belowThreshold = limitedTemporaryKey
    && tempRemaining !== null
    && tempRemaining < TEMP_REMAINING_SERIAL_THRESHOLD;
  const serialUnavailable = !temporaryChecked
    || (limitedTemporaryKey && tempRemaining === null);

  return {
    imageUsed,
    tempRemaining,
    serialUnavailable,
    serialDisabled: serialUnavailable || belowThreshold,
    warning: belowThreshold
      && imageUsed !== null
      && imageUsed > IMAGE_USED_WARNING_THRESHOLD
  };
}

export function recordSuccessfulImage(status, requestCost = 1) {
  if (!status) return status;
  const cost = Math.max(0, finite(requestCost) ?? 1);
  const imageUsed = finite(status.image?.used);
  const imageRemaining = finite(status.image?.remaining);
  const tempUsed = finite(status.temporary?.used);
  const tempRemaining = finite(status.temporary?.remaining);

  return {
    ...status,
    image: status.image ? {
      ...status.image,
      used: imageUsed === null ? status.image.used : imageUsed + 1,
      remaining: imageRemaining === null
        ? status.image.remaining
        : Math.max(0, imageRemaining - 1)
    } : status.image,
    temporary: status.temporary ? {
      ...status.temporary,
      used: tempUsed === null ? status.temporary.used : tempUsed + cost,
      remaining: tempRemaining === null
        ? status.temporary.remaining
        : Math.max(0, tempRemaining - cost)
    } : status.temporary
  };
}

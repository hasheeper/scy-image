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
    imageRemaining: finite(status?.image?.remaining),
    imageLimit: finite(status?.image?.limit),
    tempRemaining,
    unitsRemaining: finite(status?.temporary?.unitsRemaining),
    unitsLimit: finite(status?.temporary?.unitsLimit),
    resetSeconds: finite(status?.temporary?.resetSeconds),
    serialUnavailable,
    serialDisabled: serialUnavailable || belowThreshold,
    warning: belowThreshold
      && imageUsed !== null
      && imageUsed > IMAGE_USED_WARNING_THRESHOLD
  };
}

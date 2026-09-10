const number = v => v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
export function normalizeQuota(media, stats, temporaryChecked, quotaGroup) {
  const image = media?.images?.[quotaGroup];
  const temporary = stats?.temp_limits;
  return { media, quotaGroup, temporaryChecked,
    image: image ? { date: media.date, period: media.period, used: number(image.used), remaining: number(image.remaining), limit: number(image.limit) } : null,
    temporary: temporary ? { isTemp: temporary.is_temp === true, limited: temporary.limited === true,
      used: number(temporary.rpd_used), remaining: number(temporary.rpd_remaining), limit: number(temporary.rpd),
      unitsUsed: number(temporary.rpd_used_units), unitsRemaining: number(temporary.rpd_remaining_units),
      unitsLimit: number(temporary.rpd_units), resetSeconds: number(temporary.reset_seconds) } : null };
}

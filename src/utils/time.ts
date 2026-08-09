/** Small time helpers used across the gateway. */

export const now = (): number => Date.now();

/** Format a Date as an ISO string in UTC, matching the dashboard query style. */
export const toIsoUtc = (date: Date): string => date.toISOString();

const currency = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

const dateTime = new Intl.DateTimeFormat("id-ID", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Jakarta",
});

const clock = new Intl.DateTimeFormat("id-ID", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "Asia/Jakarta",
});

export function formatCurrency(value: number): string {
  return currency.format(value);
}

export function formatDateTime(value: number | undefined): string {
  return value ? `${dateTime.format(value)} WIB` : "—";
}

export function formatClock(value: number | undefined): string {
  return value ? clock.format(value) : "—";
}

export function shortId(value: string | undefined): string {
  if (!value) return "—";
  if (value.length <= 12) return value;
  return `${value.slice(0, 5)}…${value.slice(-4)}`;
}

export type PaymentStatus = "pending" | "paid" | "expired" | "cancelled";

export function paymentStatusLabel(status: PaymentStatus): string {
  if (status === "paid") return "Lunas";
  if (status === "pending") return "Menunggu";
  if (status === "cancelled") return "Batal";
  return "Kedaluwarsa";
}

export type BadgeVariant =
  "neutral" | "info" | "success" | "warning" | "danger";

export function paymentStatusVariant(status: PaymentStatus): BadgeVariant {
  if (status === "paid") return "success";
  if (status === "pending") return "warning";
  if (status === "cancelled") return "danger";
  return "neutral";
}

/** Remaining time until `expiresAt`, formatted mm:ss, clamped at 00:00. */
export function formatCountdown(remainingMs: number): string {
  const seconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

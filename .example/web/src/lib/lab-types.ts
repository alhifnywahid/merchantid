export type ProviderId = "gopay" | "shopee";
export type AuthStage = "signed-out" | "otp" | "merchant" | "store" | "ready";

export interface SelectOption {
  id: string;
  label: string;
  detail?: string;
}

export interface ScopeView {
  provider: string;
  accountId?: string;
  merchantId: string;
}

export interface ProviderSnapshot {
  id: ProviderId;
  label: string;
  description: string;
  authenticated: boolean;
  authStage: AuthStage;
  sessionFingerprint?: string;
  sessionExpiresAt?: number;
  selectedMerchantId?: string;
  selectedStoreId?: string;
  merchants: SelectOption[];
  stores: SelectOption[];
  scope?: ScopeView;
  hasStaticQris: boolean;
}

export interface PaymentView {
  id: string;
  provider: string;
  merchantId: string;
  reference?: string;
  baseAmount: number;
  uniqueAmount: number;
  uniqueOffset: number;
  status: "pending" | "paid" | "expired" | "cancelled";
  createdAt: number;
  expiresAt: number;
  qrSvg?: string;
  transactionId?: string;
}

export type ActivityTone = "info" | "success" | "warning" | "danger";

export interface ActivityView {
  id: string;
  at: number;
  tone: ActivityTone;
  title: string;
  message: string;
  providerId?: ProviderId;
}

export interface LabSnapshot {
  activeProviderId: ProviderId;
  providers: Record<ProviderId, ProviderSnapshot>;
  payments: PaymentView[];
  activity: ActivityView[];
  packageSource: "file:../..";
  storageLabel: string;
  startedAt: number;
}

export interface ActionResult {
  snapshot: LabSnapshot;
  notice?: string;
}

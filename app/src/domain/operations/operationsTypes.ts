export const GUEST_SEGMENT_IDS = [
  "business",
  "couple",
  "family",
  "leisure",
  "high-net-worth",
  "cultural-experience",
] as const;

export type GuestSegmentId = (typeof GUEST_SEGMENT_IDS)[number];

export type Difficulty = "casual" | "management";

export const DEPARTMENT_IDS = [
  "frontOffice",
  "housekeeping",
  "foodAndBeverage",
  "engineering",
  "security",
  "guestRelations",
] as const;

export type DepartmentId = (typeof DEPARTMENT_IDS)[number];

export interface DepartmentState {
  id: DepartmentId;
  staffing: number;
  dailyBudgetCents: number;
  trainingBps: number;
  serviceStandardBps: number;
  leaderSpecialty?: import("./departmentCatalog").LeaderSpecialtyId;
}

export interface RoomPricePolicy {
  roomOfferId: string;
  nightlyRateCents: number;
}

export type UpgradeKind = "workspace" | "view" | "familyCapacity" | "privacy";

export interface RoomOfferUpgrade {
  roomOfferId: string;
  upgradeId: string;
  level: number;
  /** Added fields remain optional so existing operations-v1 saves stay loadable. */
  kind?: UpgradeKind;
  remainingClosureDays?: number;
  committedDay?: number;
  costCents?: number;
}

export interface LoanState {
  id: string;
  principalCents: number;
  outstandingCents: number;
  dailyInterestBps: number;
  minimumPaymentCents: number;
}

export interface SegmentDayResult {
  segmentId: GuestSegmentId;
  demand: number;
  soldRooms: number;
  averageRateCents: number;
  revenueCents: number;
  satisfactionBps: number;
}

export type LostBookingReasonCode =
  | "hard-requirement"
  | "price"
  | "service"
  | "no-inventory";

export interface LostBookingReason {
  segmentId: GuestSegmentId;
  code: LostBookingReasonCode;
  count: number;
  explanation: string;
}

export interface GuestReview {
  segmentId: GuestSegmentId;
  ratingBps: number;
  text: string;
}

export interface RoomBooking {
  segmentId: GuestSegmentId;
  roomId: string;
  offerId: string;
  rateCents: number;
}

export interface OperationsDailyReport {
  day: number;
  segments: SegmentDayResult[];
  revenueCents: number;
  operatingCostCents: number;
  financeCostCents: number;
  netIncomeCents: number;
  endingCashCents: number;
  reputationBps: number;
  availableRooms?: number;
  soldRooms?: number;
  occupancyBps?: number;
  departmentCostCents?: number;
  roomRevenueCents?: number;
  loanInterestCents?: number;
  cashShortfallCents?: number;
  lostBookings?: LostBookingReason[];
  reviews?: GuestReview[];
  bookings?: RoomBooking[];
  reputationDeltaBps?: number;
  discoveredNeeds?: DiscoveredMarketNeed[];
}

export interface WeeklyOperationsReport {
  week: number;
  startDay: number;
  endDay: number;
  revenueCents: number;
  operatingCostCents?: number;
  financeCostCents?: number;
  netIncomeCents: number;
  availableRooms?: number;
  soldRooms?: number;
  averageOccupancyBps: number;
  reputationBps: number;
  topResultCode?: string;
  topReasonCode?: LostBookingReasonCode | "none";
  suggestedActionCode?: string;
}

export interface MonthlyOperationsClose {
  month: number;
  startDay: number;
  endDay: number;
  revenueCents: number;
  operatingCostCents?: number;
  financeCostCents?: number;
  netIncomeCents: number;
  debtPaymentCents: number;
  availableRooms?: number;
  soldRooms?: number;
  averageOccupancyBps?: number;
  reputationBps?: number;
  endingCashCents: number;
  topResultCode?: string;
  topReasonCode?: LostBookingReasonCode | "none";
  suggestedActionCode?: string;
}

export interface DiscoveredMarketNeed {
  id: string;
  segmentId: GuestSegmentId;
  kind: "room-feature" | "service" | "price";
  discoveredDay: number;
  strengthBps: number;
}

export interface OperationsState {
  rulesetVersion: "operations-v1";
  difficulty: Difficulty;
  reputationBps: number;
  departments: Record<DepartmentId, DepartmentState>;
  pricePolicies: Record<string, RoomPricePolicy>;
  offerUpgrades: Record<string, RoomOfferUpgrade>;
  loans: LoanState[];
  discoveredNeeds: DiscoveredMarketNeed[];
  segmentMix?: Partial<Record<GuestSegmentId, number>>;
  dailyReports: OperationsDailyReport[];
  weeklyReports: WeeklyOperationsReport[];
  monthlyCloses: MonthlyOperationsClose[];
  maximumReputationBps: number;
  unlockedContent: string[];
  timeSpeed: 0 | 1 | 2 | 4;
  lastOfflineCheckpointMs: number | null;
}

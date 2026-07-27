export type GuestSegmentId =
  | "business"
  | "leisure"
  | "family"
  | "luxury"
  | "group";

export type Difficulty = "casual" | "management";

export type DepartmentId =
  | "frontOffice"
  | "housekeeping"
  | "foodAndBeverage"
  | "engineering"
  | "security"
  | "guestRelations";

export interface DepartmentState {
  id: DepartmentId;
  staffing: number;
  dailyBudgetCents: number;
  trainingBps: number;
  serviceStandardBps: number;
}

export interface RoomPricePolicy {
  roomOfferId: string;
  nightlyRateCents: number;
}

export interface RoomOfferUpgrade {
  roomOfferId: string;
  upgradeId: string;
  level: number;
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

export interface OperationsDailyReport {
  day: number;
  segments: SegmentDayResult[];
  revenueCents: number;
  operatingCostCents: number;
  financeCostCents: number;
  netIncomeCents: number;
  endingCashCents: number;
  reputationBps: number;
}

export interface WeeklyOperationsReport {
  week: number;
  startDay: number;
  endDay: number;
  revenueCents: number;
  netIncomeCents: number;
  averageOccupancyBps: number;
  reputationBps: number;
}

export interface MonthlyOperationsClose {
  month: number;
  startDay: number;
  endDay: number;
  revenueCents: number;
  netIncomeCents: number;
  debtPaymentCents: number;
  endingCashCents: number;
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
  dailyReports: OperationsDailyReport[];
  weeklyReports: WeeklyOperationsReport[];
  monthlyCloses: MonthlyOperationsClose[];
  maximumReputationBps: number;
  unlockedContent: string[];
  timeSpeed: 0 | 1 | 2 | 4;
  lastOfflineCheckpointMs: number | null;
}

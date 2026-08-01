import {
  isReliabilityErrorCode,
  type JobStatus,
  type ReliabilityErrorCode,
} from "../domain/reliability/reliabilityTypes";

const JOB_LABELS: Record<JobStatus, string> = {
  queued: "已排队",
  "blocked-no-credential": "等待设置 AI",
  "waiting-network": "等待网络",
  "checking-model": "检查模型",
  "running-primary": "主模型生成中",
  "retry-delay": "等待重试",
  "running-fallback": "兼容模型生成中",
  "staging-asset": "正在保存图片",
  "ready-for-review": "等待审阅",
  adopted: "已采用",
  "needs-retry-confirmation": "需要确认重试",
  "needs-player-confirmation": "需要确认发送",
  superseded: "设计已更新",
  "failed-retryable": "可以重试",
  "failed-terminal": "生成失败",
  cancelled: "已取消",
};

export function jobStatusLabel(status: JobStatus): string {
  return JOB_LABELS[status];
}

export function reliabilityErrorCode(error: unknown): ReliabilityErrorCode {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (isReliabilityErrorCode(code)) return code;
  }
  if (error instanceof Error && isReliabilityErrorCode(error.message)) return error.message;
  if (isReliabilityErrorCode(error)) return error;
  return "unknown.unexpected";
}

export function boundedCount(value: number, maximum = 999): string {
  return value > maximum ? `${maximum}+` : Math.max(0, value).toString();
}

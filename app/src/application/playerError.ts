import {
  isReliabilityErrorCode,
  type ReliabilityErrorCode,
} from "../domain/reliability/reliabilityTypes";

export interface PlayerError {
  code: ReliabilityErrorCode;
  whatHappened: string;
  whatIsSafe: string;
  nextAction: string;
}

type PlayerErrorCopy = Omit<PlayerError, "code">;

const SAVE_SAFE = "现有酒店数据没有被自动覆盖。";
const PROVIDER_SAFE = "酒店、资金与设计蓝图没有因本次请求而改变。";

export const PLAYER_ERROR_COPY = {
  "save.not-found": {
    whatHappened: "找不到这个存档。",
    whatIsSafe: SAVE_SAFE,
    nextAction: "请返回存档管理器并选择仍然存在的存档。",
  },
  "save.invalid-id": {
    whatHappened: "存档标识无效。",
    whatIsSafe: SAVE_SAFE,
    nextAction: "请从存档管理器重新打开，不要手动修改存档位置。",
  },
  "save.invalid-name": {
    whatHappened: "存档名称不符合要求。",
    whatIsSafe: "原名称和存档内容保持不变。",
    nextAction: "请使用 1 至 40 个可见字符重新命名。",
  },
  "save.conflict": {
    whatHappened: "存档已经被另一项操作更新。",
    whatIsSafe: "较新的存档内容已保留。",
    nextAction: "请刷新后重新检查并再次操作。",
  },
  "save.locked": {
    whatHappened: "存档当前正由另一项操作使用。",
    whatIsSafe: SAVE_SAFE,
    nextAction: "请稍后重试；若问题持续，请先关闭其他 Cloud Inn 窗口。",
  },
  "save.corrupt": {
    whatHappened: "存档未通过完整性检查。",
    whatIsSafe: "应用没有继续写入可疑存档。",
    nextAction: "请打开恢复记录或诊断页面选择可验证的恢复点。",
  },
  "migration.unsupported-version": {
    whatHappened: "这个存档来自当前版本无法读取的新格式。",
    whatIsSafe: "存档文件没有被修改。",
    nextAction: "请更新 Cloud Inn 后再试。",
  },
  "migration.backup-failed": {
    whatHappened: "升级前保护副本未能完成。",
    whatIsSafe: "原存档没有开始迁移。",
    nextAction: "请检查可用空间后重试。",
  },
  "migration.failed": {
    whatHappened: "存档升级未能完成。",
    whatIsSafe: "原存档仍保持升级前的完整版本。",
    nextAction: "请重启应用后重试，或查看诊断信息。",
  },
  "migration.validation-failed": {
    whatHappened: "升级后的候选存档未通过验证。",
    whatIsSafe: "候选存档没有替换原存档。",
    nextAction: "请保留原存档并查看诊断信息。",
  },
  "recovery.not-found": {
    whatHappened: "找不到所选恢复点。",
    whatIsSafe: "当前存档没有改变。",
    nextAction: "请刷新恢复记录并重新选择。",
  },
  "recovery.corrupt": {
    whatHappened: "所选恢复点不完整或校验失败。",
    whatIsSafe: "当前存档没有被替换。",
    nextAction: "请选择另一个已验证的恢复点。",
  },
  "recovery.restore-failed": {
    whatHappened: "恢复操作未能完成。",
    whatIsSafe: "当前存档或恢复前保护副本仍然可用。",
    nextAction: "请重启后检查恢复记录，再决定是否重试。",
  },
  "archive.cancelled": {
    whatHappened: "文件选择已取消。",
    whatIsSafe: "没有导入、导出或覆盖任何存档。",
    nextAction: "需要时可重新开始。",
  },
  "archive.invalid": {
    whatHappened: "所选文件不是有效的 Cloud Inn 存档包。",
    whatIsSafe: "现有存档没有改变。",
    nextAction: "请选择来源可信且完整的 .cloudinn 文件。",
  },
  "archive.unsupported-version": {
    whatHappened: "存档包版本不受当前应用支持。",
    whatIsSafe: "现有存档没有改变。",
    nextAction: "请更新 Cloud Inn 或使用兼容版本导出的文件。",
  },
  "archive.too-large": {
    whatHappened: "存档包超过安全大小限制。",
    whatIsSafe: "文件没有被导入。",
    nextAction: "请检查文件来源，或使用较小的有效存档包。",
  },
  "archive.insufficient-space": {
    whatHappened: "可用磁盘空间不足。",
    whatIsSafe: "现有存档没有被覆盖。",
    nextAction: "请释放空间后重新操作。",
  },
  "archive.expired-inspection": {
    whatHappened: "导入检查已过期。",
    whatIsSafe: "没有发布不再受验证保护的内容。",
    nextAction: "请重新选择并检查同一个存档包。",
  },
  "archive.conflict": {
    whatHappened: "导入目标在发布前发生冲突。",
    whatIsSafe: "现有存档没有被覆盖。",
    nextAction: "请返回存档管理器后重新导入。",
  },
  "archive.import-failed": {
    whatHappened: "存档包未能导入。",
    whatIsSafe: "现有存档保持不变。",
    nextAction: "请检查文件与磁盘空间后重试。",
  },
  "archive.export-failed": {
    whatHappened: "存档包未能导出。",
    whatIsSafe: "游戏存档本身没有改变。",
    nextAction: "请选择可写位置并确认有足够空间。",
  },
  "asset.not-found": {
    whatHappened: "找不到这张本地图片。",
    whatIsSafe: "酒店数据仍可打开，缺失位置会显示占位图。",
    nextAction: "请查看恢复记录或重新生成图片。",
  },
  "asset.corrupt": {
    whatHappened: "本地图片未通过完整性检查。",
    whatIsSafe: "可疑图片不会被采用。",
    nextAction: "请查看恢复记录或重新生成图片。",
  },
  "asset.unsupported-type": {
    whatHappened: "图片格式不受支持。",
    whatIsSafe: PROVIDER_SAFE,
    nextAction: "请使用 PNG、JPEG 或 WebP 图片。",
  },
  "asset.too-large": {
    whatHappened: "图片超过安全大小或尺寸限制。",
    whatIsSafe: PROVIDER_SAFE,
    nextAction: "请使用更小的参考图或结果图。",
  },
  "asset.write-failed": {
    whatHappened: "图片未能安全写入本地资产库。",
    whatIsSafe: "未完成的图片不会被酒店采用。",
    nextAction: "请检查磁盘空间后重试。",
  },
  "keychain.missing": {
    whatHappened: "尚未设置图片服务凭据。",
    whatIsSafe: "离线游戏功能保持完整。",
    nextAction: "可在设置中添加凭据，或继续离线游玩。",
  },
  "keychain.locked": {
    whatHappened: "macOS 钥匙串当前处于锁定状态。",
    whatIsSafe: "凭据没有离开钥匙串。",
    nextAction: "请解锁 Mac 或钥匙串后重试。",
  },
  "keychain.denied": {
    whatHappened: "macOS 拒绝了本次钥匙串访问。",
    whatIsSafe: "凭据没有被复制到应用存储。",
    nextAction: "请在系统提示中允许访问，或稍后重试。",
  },
  "keychain.unavailable": {
    whatHappened: "macOS 钥匙串当前不可用。",
    whatIsSafe: "应用没有降级为明文保存凭据。",
    nextAction: "请检查系统状态后重试。",
  },
  "keychain.invalid-token": {
    whatHappened: "凭据格式不符合安全要求。",
    whatIsSafe: "无效内容没有写入钥匙串。",
    nextAction: "请重新粘贴完整凭据，不要添加首尾空格。",
  },
  "provider.control-invalid": {
    whatHappened: "图片服务的本地计费控制记录无效或缺失。",
    whatIsSafe: "应用已停止发送可能计费的请求。",
    nextAction: "请查看诊断信息并修复控制记录后再试。",
  },
  "provider.quota-exceeded": {
    whatHappened: "今天的图片请求额度已经用完。",
    whatIsSafe: PROVIDER_SAFE,
    nextAction: "请等待下一个 UTC 日期，或谨慎调整每日上限。",
  },
  "provider.confirmation-required": {
    whatHappened: "下一次可能计费的请求需要确认。",
    whatIsSafe: "尚未发送新的计费请求。",
    nextAction: "请核对模型、额度与目标后确认一次发送。",
  },
  "provider.job-not-found": {
    whatHappened: "找不到这项图片任务。",
    whatIsSafe: PROVIDER_SAFE,
    nextAction: "请刷新任务列表。",
  },
  "provider.job-stale": {
    whatHappened: "图片任务已被更新。",
    whatIsSafe: "过期操作没有覆盖较新的任务状态。",
    nextAction: "请刷新后重新确认。",
  },
  "provider.invalid-transition": {
    whatHappened: "图片任务当前不能执行这项操作。",
    whatIsSafe: PROVIDER_SAFE,
    nextAction: "请刷新并根据当前任务状态选择操作。",
  },
  "provider.model-unavailable": {
    whatHappened: "所需图片模型当前不可用。",
    whatIsSafe: PROVIDER_SAFE,
    nextAction: "请稍后重试，或在兼容的 1K 任务中明确选择备用模型。",
  },
  "provider.authentication-failed": {
    whatHappened: "图片服务未接受当前凭据。",
    whatIsSafe: PROVIDER_SAFE,
    nextAction: "请在设置中更新凭据并重新检查服务。",
  },
  "provider.safety-rejected": {
    whatHappened: "图片服务因安全规则拒绝了请求。",
    whatIsSafe: PROVIDER_SAFE,
    nextAction: "请调整图片描述或参考内容后创建新请求。",
  },
  "provider.invalid-request": {
    whatHappened: "图片服务无法处理这项请求。",
    whatIsSafe: PROVIDER_SAFE,
    nextAction: "请检查描述、分辨率和参考图片后重试。",
  },
  "provider.malformed-response": {
    whatHappened: "图片服务返回了无法安全读取的结果。",
    whatIsSafe: "无效结果没有写入资产库或酒店。",
    nextAction: "请稍后重新创建请求。",
  },
  "network.offline": {
    whatHappened: "当前没有可用网络连接。",
    whatIsSafe: "任务已等待，酒店可以继续离线游玩。",
    nextAction: "网络恢复后由你明确重试。",
  },
  "network.timeout": {
    whatHappened: "图片服务请求超时。",
    whatIsSafe: "若计费结果不明确，应用不会自动重发。",
    nextAction: "请查看任务状态并确认是否重试。",
  },
  "network.rate-limited": {
    whatHappened: "图片服务暂时限制了请求频率。",
    whatIsSafe: PROVIDER_SAFE,
    nextAction: "请等待任务显示的重试时间，再确认下一次请求。",
  },
  "network.unavailable": {
    whatHappened: "暂时无法连接图片服务。",
    whatIsSafe: PROVIDER_SAFE,
    nextAction: "请检查网络后稍后重试。",
  },
  "unknown.unexpected": {
    whatHappened: "发生了未预期的问题。",
    whatIsSafe: "应用没有根据未知错误自动覆盖数据或重复发送请求。",
    nextAction: "请重试；若问题持续，请查看已脱敏的诊断信息。",
  },
} satisfies Record<ReliabilityErrorCode, PlayerErrorCopy>;

function extractErrorCode(value: unknown): ReliabilityErrorCode | null {
  if (isReliabilityErrorCode(value)) return value;
  if (typeof value !== "object" || value === null) return null;

  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "code");
    if (descriptor === undefined || !("value" in descriptor)) return null;
    return isReliabilityErrorCode(descriptor.value) ? descriptor.value : null;
  } catch {
    return null;
  }
}

export function toPlayerError(value: unknown): PlayerError {
  const code = extractErrorCode(value) ?? "unknown.unexpected";
  return { code, ...PLAYER_ERROR_COPY[code] };
}

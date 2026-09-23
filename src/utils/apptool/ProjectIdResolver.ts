/**
 * 🔥 共享的 projectId 解析器
 *
 * 统一所有工具（文件读写/本地执行/GPU训练）的 projectId 解析规则：
 * 1. 完整 UUID（36位）→ 直接通过
 * 2. 8位 hex 前缀 → 查库匹配唯一项目（原有缩写交互习惯）
 * 3. 任意 ID 字符串（如 base-extensiontool / base-ext）→ 查库精确/前缀匹配
 *    🔙 覆盖固定 ID 的系统基础项目（app_type=system_base，ID 非 UUID 格式），
 *    不做格式特例白名单——任何固定 ID 项目自然兼容
 */

import { desktopAppStorage } from '@/services/storage';

const UUID_REGEX = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HEX_PREFIX_REGEX = /^[a-f0-9]{8}$/i;

/**
 * 解析 projectId：写入 resolved.id，成功返回 null，失败返回错误信息
 */
export async function resolveProjectId(
  appId: string,
  resolved: { id: string },
  userId?: string
): Promise<string | null> {
  // 1. 完整 UUID 直接通过
  if (UUID_REGEX.test(appId)) {
    resolved.id = appId;
    return null;
  }

  // 2. 其余情况（8位hex前缀 / 固定ID如 base-ext）统一查库解析
  try {
    const effectiveUserId = userId || 'local';
    const apps = await desktopAppStorage.getByUserId(effectiveUserId);
    const lower = appId.toLowerCase();
    // 精确匹配优先，其次前缀匹配
    const exact = apps.filter((app: any) => app.id?.toLowerCase() === lower);
    if (exact.length === 1) {
      resolved.id = exact[0].id;
      return null;
    }
    const matched = apps.filter((app: any) => app.id?.toLowerCase().startsWith(lower));
    if (matched.length === 1) {
      resolved.id = matched[0].id;
      return null;
    }
    if (matched.length > 1) {
      const ids = matched.map((app: any) => app.id).join(', ');
      return `projectId "${appId}" 匹配到多个项目(${matched.length}个): ${ids}。请使用更长的前缀或完整 ID。`;
    }
    return `projectId "${appId}" 未匹配到任何项目。可先用 list_projects 查看项目列表确认 ID。`;
  } catch (error) {
    return `projectId "${appId}" 解析失败: ${error}。请使用完整的 36 位 UUID。`;
  }
}

/**
 * 长短 id 兼容比对（存量数据可能登记短 id，新数据统一完整 id）：
 * 完全相等，或一方是另一方的前缀且较短一方 >= 8 位（短 id 约定长度）
 */
export function isSameProjectId(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la === lb) return true;
  const [short, long] = la.length <= lb.length ? [la, lb] : [lb, la];
  return short.length >= 8 && long.startsWith(short);
}

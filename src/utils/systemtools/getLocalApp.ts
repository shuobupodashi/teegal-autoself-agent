/**
 * Teegal Tool: 列出平台上的项目 (list_projects / list_train_projects)
 *
 * 功能：从平台获取项目列表
 * 支持多种查询方式：
 * 1. 精确匹配 projectId (UUID格式)
 * 2. 关键词搜索 (名称、描述模糊匹配)
 * 3. 特殊查询 (如"所有项目"、"检查项目"等)
 *
 * 🔥 已迁移到本地存储
 * 🔥 向后兼容：旧名称 teegal_list_apps、teegal_list_train_projects 仍然可用
 */

import { desktopAppStorage, trainingTaskStorage } from '@/services/storage';
import { resolveProjectId } from '@/utils/apptool/ProjectIdResolver';
import { getAppBasePath } from '@/utils/apptool/AppPathHelper';

export interface AppInfo {
  id: string;
  name: string;
  description?: string;
  activity?: string; // 🔥 活跃度摘要（最近训练/更新时间），帮 LLM 判断项目状态
  localPath?: string; // 🔥 项目磁盘目录（LLM ssh 传文件/读代码直接用，不必从 id 推导）
}

export interface GetLocalAppResult {
  success: boolean;
  message: string;
  appId?: string;
  apps?: AppInfo[];
  source?: 'appId' | 'keyword' | 'special' | 'context' | 'list' | 'none';
  error?: string;
}

// 🔥 特殊查询关键词映射
const SPECIAL_QUERIES: Record<string, string> = {
  '所有': 'list_all',
  '全部': 'list_all',
  '列表': 'list_all',
  '检查': 'list_all',
  '查看': 'list_all',
  '多少': 'list_all',
  '几个': 'list_all',
  '运行中': 'list_all',
  '上班': 'list_all',
};

/**
 * 🔥 长短 id 置换表：完整 id → 8 位短 id（LLM 交流习惯用短 id，与 read_project_file 等工具一致）
 * 同批内前 8 位撞车时自动延长前缀，保证短 id 能唯一解析回完整 id
 */
function computeShortIds(ids: string[]): Map<string, string> {
  const result = new Map<string, string>();
  const assigned = new Set<string>();
  for (const id of ids) {
    let len = Math.min(8, id.length);
    let sid = id.substring(0, len);
    while (assigned.has(sid.toLowerCase()) && len < id.length) {
      sid = id.substring(0, ++len);
    }
    assigned.add(sid.toLowerCase());
    result.set(id, sid);
  }
  return result;
}

/**
 * 🔥 检查是否为特殊查询
 */
function checkSpecialQuery(query: string): 'list_all' | null {
  if (!query) return null;
  const lowerQuery = query.toLowerCase();

  for (const [keyword, action] of Object.entries(SPECIAL_QUERIES)) {
    if (lowerQuery.includes(keyword)) {
      return action as 'list_all';
    }
  }
  return null;
}

/**
 * 🔥 根据关键词搜索应用
 */
function searchAppsByKeyword(apps: AppInfo[], keyword: string): AppInfo[] {
  if (!keyword || keyword.trim() === '') {
    return apps;
  }

  const lowerKeyword = keyword.toLowerCase().trim();

  return apps.filter(app => {
    const nameMatch = app.name.toLowerCase().includes(lowerKeyword);
    const descMatch = app.description?.toLowerCase().includes(lowerKeyword) || false;
    return nameMatch || descMatch;
  }).sort((a, b) => {
    // 名称匹配优先
    const aNameMatch = a.name.toLowerCase().includes(lowerKeyword);
    const bNameMatch = b.name.toLowerCase().includes(lowerKeyword);
    if (aNameMatch && !bNameMatch) return -1;
    if (!aNameMatch && bNameMatch) return 1;
    return 0;
  });
}

/**
 * 🔥 相对时间描述（喂给 LLM 的人类可读格式）
 */
function formatDaysAgo(ms: number): string {
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days}天前`;
  if (days < 365) return `${Math.floor(days / 30)}个月前`;
  return `${Math.floor(days / 365)}年前`;
}

/**
 * 🔥 计算用户所有项目的训练活跃度（appId → 摘要）
 * 数据源：training_tasks 全量（一次查询，内存分组），无训练记录的项目不进 Map
 */
async function buildTrainActivityMap(userId: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const tasks = (await trainingTaskStorage.getByUserId(userId, 200, 0)) || [] as any[];
    const stat = new Map<string, { last: number; count: number; lastStatus?: string }>();
    for (const t of tasks) {
      const appId = t?.app_id || t?.appId;
      if (!appId) continue;
      const created = typeof t?.created_at === 'number' ? t.created_at : (Date.parse(t?.created_at) || 0);
      const s = stat.get(appId) || { last: 0, count: 0 };
      s.count++;
      if (created > s.last) {
        s.last = created;
        s.lastStatus = t?.status;
      }
      stat.set(appId, s);
    }
    for (const [appId, s] of stat) {
      const status = s.lastStatus ? `,最近:${s.lastStatus}` : '';
      map.set(appId, `${formatDaysAgo(s.last)}训练过(共${s.count}次${status})`);
    }
  } catch (e) {
    console.warn('[GET-LOCAL-APP] 训练活跃度计算失败(忽略):', e);
  }
  return map;
}

/**
 * 🔥 单项目活跃度摘要：训练活动优先，其次代码/元信息更新时间
 */
function buildActivity(appId: string, updatedAt: any, trainMap: Map<string, string>): string {
  const train = trainMap.get(appId);
  const updatedMs = typeof updatedAt === 'number' ? updatedAt : (Date.parse(updatedAt) || 0);
  if (train) return train;
  if (updatedMs > 0) return `${formatDaysAgo(updatedMs)}更新过`;
  return '无活动记录';
}

/**
 * 🔥 主函数：获取本地应用
 *
 * 查询策略（按优先级）：
 * 1. 如果 query 是有效 UUID → 精确匹配 appId
 * 2. 如果 query 是特殊关键词 → 返回所有应用
 * 3. 使用 query 作为关键词搜索
 */
export async function handleGetLocalApp(
  query: string,
  userId: string,
  conversationId?: string
): Promise<GetLocalAppResult> {
  console.log('📱 [GET-LOCAL-APP] 查询:', query || '(空)');

  try {
    // 获取所有应用（用于后续搜索）
    // 🔥 baseFirst=true：基础项目（扩展工具）置顶，防止项目太多时被淹没在 100 条限制外，
    //    LLM 需要能稳定看到 base-extensiontool 以便帮用户维护扩展工具
    const allApps = await desktopAppStorage.getByUserId(userId, 100, 0, undefined, true);
    // 🔥 一次全量训练任务查询 → 内存按项目分组，生成活跃度摘要
    const trainMap = await buildTrainActivityMap(userId);
    // 🔥 长短 id 置换表：LLM 看到的 id 用短 id（省 token），localPath 用完整 id 解析真实磁盘目录
    const shortIds = computeShortIds((allApps || []).map((a: any) => a.id));
    const toAppInfo = async (dbApp: any): Promise<AppInfo> => ({
      id: shortIds.get(dbApp.id) || dbApp.id.substring(0, 8),
      name: dbApp.name,
      description: dbApp.description,
      activity: buildActivity(dbApp.id, dbApp.updated_at, trainMap),
      localPath: await getAppBasePath(dbApp.id).catch(() => undefined),
    });
    const mappedApps: AppInfo[] = await Promise.all((allApps || []).map(toAppInfo));

    // 1. 🔥 检查特殊查询（如"所有app"、"检查app"等）
    const specialAction = checkSpecialQuery(query);
    if (specialAction === 'list_all' || !query) {
      console.log('📱 [GET-LOCAL-APP] 返回所有应用');

      if (mappedApps.length === 0) {
        const noAppMessage = '您还没有创建任何应用。\n\n您可以使用 code 工具创建单代码文件型应用，例如 Python、JavaScript 等脚本应用。';
        return {
          success: false,
          message: noAppMessage,
          error: noAppMessage,  // 🔥 同时返回 error 字段
          source: 'none',
        };
      }

      return {
        success: true,
        message: `您共有 ${mappedApps.length} 个本地应用`,
        apps: mappedApps.slice(0, 20),
        source: 'list',
      };
    }

    // 2. 🔥 长短 id 置换：完整 UUID / 8 位短 id / slug（如 base-boo → base-bootcode）统一查库解析
    if (query) {
      const resolved = { id: '' };
      const resolveErr = await resolveProjectId(query, resolved, userId);
      if (!resolveErr) {
        const app = allApps?.find((a: any) => a.id === resolved.id);
        if (app) {
          console.log('📱 [GET-LOCAL-APP] id 解析命中:', query, '→', app.id);
          return {
            success: true,
            message: `找到应用: ${app.name}`,
            appId: shortIds.get(app.id) || app.id.substring(0, 8),
            apps: [await toAppInfo(app)],
            source: 'appId',
          };
        }
      }
      // 解析失败（含多义前缀）→ 落到关键词搜索兜底
    }

    // 3. 🔥 使用 query 作为关键词搜索
    console.log('📱 [GET-LOCAL-APP] 关键词搜索:', query);
    const matchedApps = searchAppsByKeyword(mappedApps, query);

    if (matchedApps.length === 1) {
      return {
        success: true,
        message: `找到应用: ${matchedApps[0].name}`,
        appId: matchedApps[0].id,
        apps: matchedApps,
        source: 'keyword',
      };
    } else if (matchedApps.length > 1) {
      return {
        success: true,
        message: `找到 ${matchedApps.length} 个匹配的应用`,
        apps: matchedApps.slice(0, 10),
        source: 'keyword',
      };
    }

    // 4. 没有匹配，返回所有应用供选择
    const failMessage = `未找到匹配 "${query}" 的应用。\n\n可能原因：\n1. 搜索词可能不准确，请尝试其他关键词\n2. 这里搜索的是 Teegal 平台的应用，如果您想操作自己电脑上的软件或扩展，请使用 userpc_shell 工具执行系统命令`;
    return {
      success: false,
      message: failMessage,
      error: failMessage,  // 🔥 同时返回 error 字段，供 ReactionExecutor 使用
      apps: mappedApps.slice(0, 10),
      source: 'list',
    };

  } catch (error) {
    console.error('❌ [GET-LOCAL-APP] 执行异常:', error);
    return {
      success: false,
      message: '获取应用失败',
      error: error instanceof Error ? error.message : '未知错误',
      source: 'none',
    };
  }
}

/**
 * 工具执行入口（供 ToolHandler 调用）
 */
interface AutoStep {
  toolParams?: Record<string, any>;
  parameters?: Record<string, any>;
}

export async function executeGetLocalAppTool(
  step: AutoStep,
  _planId: string,
  context: { userId: string; conversationId?: string }
): Promise<any> {
  const params = step.toolParams || step.parameters || {};
  const query = params.query || params.appId || '';

  const result = await handleGetLocalApp(query, context.userId, context.conversationId);

  return {
    success: result.success,
    data: {
      message: result.message,
      appId: result.appId,
      apps: result.apps,
      source: result.source,
    },
    error: result.error || null,
  };
}



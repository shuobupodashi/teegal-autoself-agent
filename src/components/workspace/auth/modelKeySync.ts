/**
 * 模型密钥自动同步（轻量镜像同步）
 *
 * 🔥 设计：始终同步，无开关
 * - 凭据池镜像「我的模型」中带 API Key 的模型 + 「搜索源」中带 API Key 的搜索源（增/改/删跟随）
 * - 想移除某个 key → 到模型/搜索源管理里删掉对应 key 即可，凭据会自动跟着移除
 *
 * 🔥 同步标记：描述末尾带「（自动同步）」的 env 凭据归本模块管理；
 *    手工创建的凭据（无标记）永远不碰。
 *    - 模型：「模型 {modelId} 的 API Key（自动同步）」
 *    - 搜索源：「搜索源 {name} 的 API Key（自动同步）」
 */

import { ModelManager } from '@/utils/llm/ModelManager';

const SYNC_MARK = '（自动同步）';
const SYNC_DESC_RE = /^模型 (.+?) 的 API Key（自动同步）/;
const SEARCH_SYNC_DESC_RE = /^搜索源 (.+?) 的 API Key（自动同步）/;

// 🔥 按接口域名推荐 LLM 惯用的官方环境变量名（写代码时更自然）
// ⚠️ 顺序即优先级：火山引擎域名含 ark，而 volces 是其 API 域名主体，两者都指向 ARK_API_KEY
const PROVIDER_ENV_NAMES: Array<[string, string]> = [
  ['dashscope', 'DASHSCOPE_API_KEY'],
  ['deepseek', 'DEEPSEEK_API_KEY'],
  ['openai', 'OPENAI_API_KEY'],
  ['moonshot', 'MOONSHOT_API_KEY'],
  ['bigmodel', 'ZHIPU_API_KEY'],
  ['anthropic', 'ANTHROPIC_API_KEY'],
  ['openrouter', 'OPENROUTER_API_KEY'],
  ['minimaxi', 'MINIMAX_API_KEY'],
  ['xiaomimimo', 'MIMO_API_KEY'],
  // 火山引擎方舟（豆包 / Seedance / Seed 系列模型）
  ['volces', 'ARK_API_KEY'],
];

// 🔥 搜索源环境变量名：providerType 优先，其次 url 域名
const SEARCH_ENV_NAMES: Array<[string, string]> = [
  ['tavily', 'TAVILY_API_KEY'],
  ['serpapi', 'SERPAPI_API_KEY'],
  ['bing', 'BING_API_KEY'],
  ['firecrawl', 'FIRECRAWL_API_KEY'],
];

export function suggestEnvVarName(modelUrl: string, modelId: string): string {
  const url = (modelUrl || '').toLowerCase();
  for (const [domain, envName] of PROVIDER_ENV_NAMES) {
    if (url.includes(domain)) return envName;
  }
  const slug = (modelId || 'MODEL').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return `MODEL_${slug}_KEY`;
}

/** 搜索源环境变量名推荐（providerType 优先，url 域名兜底，名称转 slug 最后兜底） */
export function suggestSearchEnvVarName(providerType: string, url: string, name: string): string {
  const pt = (providerType || '').toLowerCase();
  for (const [type, envName] of SEARCH_ENV_NAMES) {
    if (pt === type) return envName;
  }
  const lowerUrl = (url || '').toLowerCase();
  for (const [domain, envName] of SEARCH_ENV_NAMES) {
    if (lowerUrl.includes(domain)) return envName;
  }
  const slug = (name || 'SEARCH').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return `SEARCH_${slug}_KEY`;
}

export interface SyncResult {
  created: number;
  updated: number;
  removed: number;
}

/**
 * 🔥 执行一次镜像同步（幂等，可随时安全调用）
 * - 模型/搜索源有 key 但池里没有 → 创建
 * - key 变了 → 更新值（解决"快照过期"问题）
 * - 模型/搜索源已删除/不再有 key → 移除对应的自动同步凭据
 */
export async function syncModelKeyCredentials(userId: string): Promise<SyncResult> {
  const electron = (window as any).electron;
  const result: SyncResult = { created: 0, updated: 0, removed: 0 };

  await ModelManager.initialize(userId);
  const creds = (await electron.localStorage.listCredentials(userId)) || [];
  const envCreds = creds.filter((c: any) => c.type !== 'param');
  // 已占用的环境变量名（模型与搜索源共享一个命名空间，防止撞名）
  const takenNames = new Set(envCreds.map((c: any) => c.env_var));

  /** 生成不重名的环境变量名（生成后立即占位，避免循环内撞名） */
  const allocEnvVar = (preferred: string): string => {
    if (!takenNames.has(preferred)) {
      takenNames.add(preferred);
      return preferred;
    }
    let i = 2;
    while (takenNames.has(`${preferred}_${i}`)) i++;
    const name = `${preferred}_${i}`;
    takenNames.add(name);
    return name;
  };

  // ========== 1. 模型 key 同步 ==========
  const models = ModelManager.getUserModels().filter((m: any) => m.apiKey);
  const syncedModels = envCreds
    .filter((c: any) => SYNC_DESC_RE.test(c.description || ''))
    .map((c: any) => ({ cred: c, modelId: (c.description.match(SYNC_DESC_RE) || [])[1] }));

  for (const model of models) {
    const hit = syncedModels.find(s => s.modelId === model.modelId);
    if (!hit) {
      const envVar = allocEnvVar(suggestEnvVarName(model.url, model.modelId));
      await electron.localStorage.createCredential({
        userId,
        name: envVar,
        type: 'env',
        description: `模型 ${model.modelId} 的 API Key${SYNC_MARK}`,
        envVar,
        value: model.apiKey,
      });
      result.created++;
    } else if (hit.cred.value !== model.apiKey) {
      await electron.localStorage.updateCredential(hit.cred.id, { value: model.apiKey });
      result.updated++;
    }
  }

  // 删（模型已不存在或不再有 key）
  for (const s of syncedModels) {
    const alive = models.find((m: any) => m.modelId === s.modelId);
    if (!alive) {
      await electron.localStorage.deleteCredential(s.cred.id);
      takenNames.delete(s.cred.env_var);
      result.removed++;
    }
  }

  // ========== 2. 搜索源 key 同步（LLM 拿 key 可直接写脚本调搜索 API，不依赖内置工具） ==========
  const providers = ModelManager.getSearchProviders().filter((p: any) => p.apiKey);
  const syncedProviders = envCreds
    .filter((c: any) => SEARCH_SYNC_DESC_RE.test(c.description || ''))
    .map((c: any) => ({ cred: c, name: (c.description.match(SEARCH_SYNC_DESC_RE) || [])[1] }));

  for (const provider of providers) {
    const hit = syncedProviders.find(s => s.name === provider.name);
    if (!hit) {
      const envVar = allocEnvVar(suggestSearchEnvVarName(provider.providerType, provider.url, provider.name));
      await electron.localStorage.createCredential({
        userId,
        name: envVar,
        type: 'env',
        description: `搜索源 ${provider.name} 的 API Key${SYNC_MARK}`,
        envVar,
        value: provider.apiKey,
      });
      result.created++;
    } else if (hit.cred.value !== provider.apiKey) {
      await electron.localStorage.updateCredential(hit.cred.id, { value: provider.apiKey });
      result.updated++;
    }
  }

  // 删（搜索源已不存在或不再有 key）
  for (const s of syncedProviders) {
    const alive = providers.find((p: any) => p.name === s.name);
    if (!alive) {
      await electron.localStorage.deleteCredential(s.cred.id);
      takenNames.delete(s.cred.env_var);
      result.removed++;
    }
  }

  return result;
}

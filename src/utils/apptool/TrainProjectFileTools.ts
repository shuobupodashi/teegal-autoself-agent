/**
 * Train Project File Tools
 * 项目文件操作工具集 + 训练任务工具
 *
 * 🔥 项目文件操作：
 * - list_project_files: 列出文件树
 * - read_project_file: 读取单个文件
 * - save_project_file: 保存/创建文件
 * - edit_project_file: 局部编辑文件（search/replace，节省 token）
 * - delete_project_file: 删除文件
 *
 * 🔥 训练任务工具：
 * - list_train_tasks: 列出训练任务
 * - get_train_task_detail: 获取训练任务详情
 * - stop_gpu_train: 停止 GPU 训练
 * - upsert_project: 创建/更新项目（不带 projectId=创建；带 projectId=更新 name/description）
 */

import { AutoStep, AutoToolResult } from "../auto/types";
import { BASE_PROJECT_ID } from '../auto/BaseProjectToolLoader';
import { desktopAppStorage } from '@/services/storage';
import { desktopAppEventService } from '@/services/events/DesktopAppEventService';
import { v4 as uuidv4 } from 'uuid';
import { getUserDataPath, getAppBasePath, getAppHistoryPath, getCodePath } from './AppPathHelper';
import { resolveProjectId } from './ProjectIdResolver';

// ============================================================================
// 🔥 更新 app 的 updatedAt（touch 活跃度），使经常使用的项目排在列表前面
async function touchAppUpdatedAt(appId: string): Promise<void> {
  try { await desktopAppStorage.update(appId, {}); } catch (e) {}
}

/**
 * 🔥 .json 文件自动 pretty-print（save/edit_project_file 共用）
 * LLM 常写紧凑单行 JSON（省 token 但打开没法看），保存前格式化为 2 空格缩进；
 * 解析失败（JSON 不合法）或已是多行格式则原样返回，不拦截保存。
 */
function prettyPrintJsonIfNeeded(filePath: string, content: string): string {
  if (!filePath.toLowerCase().endsWith('.json') || !content) return content;
  try {
    const parsed = JSON.parse(content);
    const pretty = JSON.stringify(parsed, null, 2);
    // 只有原本是紧凑/无缩进格式时才重排，避免反复保存产生无意义 diff
    return pretty !== content ? pretty : content;
  } catch {
    return content;
  }
}

/**
 * 🔥 基础项目 tools/ 文件变更后触发热重载（await 确保下一轮 prompt 必然包含新工具）
 * save/edit/delete_project_file 三条写路径统一调用。
 * 之前只挂在 save 上：registry.json 已存在时 LLM 走 edit 更新 → 不重载 → 工具不进 prompt。
 */
async function triggerBaseToolReload(fullAppId: string, filePath: string, userId?: string): Promise<void> {
  if (fullAppId !== BASE_PROJECT_ID || !filePath.replace(/\\/g, '/').startsWith('tools/') || !userId) {
    return;
  }
  try {
    const { loadBaseProjectTools } = await import('@/utils/auto/BaseProjectToolLoader');
    const count = await loadBaseProjectTools(String(userId), true);
    console.log(`[BASE-TOOLS] 基础项目工具已热重载: ${count} 个工具生效`);
  } catch (e) {
    console.warn('[BASE-TOOLS] 基础项目工具热重载失败:', e);
  }
}

// 类型定义
// ============================================================================

export interface FileNode {
  name: string;
  path: string;
  relativePath: string;
  type: 'file' | 'directory';
  ext?: string;
  size?: number;
  children?: FileNode[];
}

export interface FileHistory {
  fileName: string;
  version: {
    versionName: string;
    path: string;
    createdAt: string;
  };
}

export interface ListFilesResult {
  files: FileNode[];
  history: FileHistory[];
}

export interface ReadFileResult {
  content: string;
  language: string;
  size: number;
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 扫描目录获取文件树（递归扫描所有层级）
 */
async function scanDirectory(dir: string): Promise<FileNode[]> {
  try {
    const electron = (window as any).electron;

    // 🔥 使用递归扫描 API，获取完整的嵌套文件树
    if (electron?.readDirectoryRecursive) {
      const result = await electron.readDirectoryRecursive(dir, { maxDepth: 10 });
      if (result.success && result.files) {
        return result.files.map((f: any) => ({
          name: f.name,
          path: f.path,
          relativePath: f.relativePath || f.name,
          type: f.type,
          ext: f.ext,
          size: f.size,
          children: f.children,
        }));
      }
    }

    return [];
  } catch (error) {
    console.error('[scanDirectory] 扫描失败:', dir, error);
    return [];
  }
}

/**
 * 扫描 history 目录
 */
async function scanHistoryDirectory(dir: string): Promise<FileHistory[]> {
  try {
    const electron = (window as any).electron;

    if (!electron?.readDirectory) return [];

    const result = await electron.readDirectory(dir);
    if (!result.success) return [];

    const histories: FileHistory[] = [];
    await scanHistoryRecursive(dir, '', histories);
    return histories;
  } catch (error) {
    console.error('[scanHistoryDirectory] 扫描失败:', dir, error);
    return [];
  }
}

/**
 * 递归扫描 history 目录
 */
async function scanHistoryRecursive(
  currentDir: string,
  relativePath: string,
  histories: FileHistory[]
): Promise<void> {
  try {
    const electron = (window as any).electron;
    if (!electron?.readDirectory) return;

    const result = await electron.readDirectory(currentDir);
    if (!result.success || !result.files) return;

    for (const item of result.files) {
      if (item.type === 'directory') {
        const newRelativePath = relativePath ? `${relativePath}/${item.name}` : item.name;
        await scanHistoryRecursive(item.path, newRelativePath, histories);
      } else if (item.type === 'file' && item.name.match(/^v\d+\./)) {
        const fileName = relativePath || item.name.replace(/^v\d+\./, '');
        histories.push({
          fileName,
          version: {
            versionName: item.name,
            path: item.path,
            createdAt: item.modifiedTime || new Date().toISOString(),
          },
        });
      }
    }
  } catch (error) {
    console.error('[scanHistoryRecursive] 扫描失败:', currentDir, error);
  }
}

/**
 * 🔥 需要过滤的目录名（不区分大小写）
 * 与 main.ts read-directory-recursive 保持一致
 */
const IGNORED_DIRS = new Set([
  'node_modules', '__pycache__', '.venv', 'venv', 'env',
  '.git', '.svn', '.hg', 'dist', 'build', '.next', '.nuxt',
  '.cache', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  'logs', 'wandb', 'runs', 'checkpoints', '.ipynb_checkpoints',
  'history',
]);

/**
 * 🔥 递归过滤隐藏文件和特殊目录
 * 过滤自身及所有子节点中的无用条目
 */
function filterFileNodes(nodes: FileNode[]): FileNode[] {
  return nodes
    .filter(node => {
      // 过滤隐藏文件（以 . 开头）
      if (node.name.startsWith('.')) return false;
      // 过滤缓存/依赖目录
      if (node.type === 'directory' && IGNORED_DIRS.has(node.name.toLowerCase())) return false;
      return true;
    })
    .map(node => {
      // 🔥 递归过滤子节点
      if (node.children && node.children.length > 0) {
        return { ...node, children: filterFileNodes(node.children) };
      }
      return node;
    });
}

/**
 * 排序文件节点（目录优先）
 */
function sortFileNodes(nodes: FileNode[]): FileNode[] {
  return nodes.sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * 🔥 read_project_file 路径定位兜底
 * LLM 传的 filePath 可能是裸文件名（server.ts）或层级猜错的相对路径——
 * 典型如 base-bootcode：仓库 clone 在项目子目录 teegal-autoprojects/ 下，
 * 从项目根拼路径必然差层。按请求在项目文件树中定位真实文件：
 * 唯一命中 → 返回真实相对路径；多个命中 → 返回候选列表；没有 → none
 * （扫描根与 read 的 baseDir 同为 getAppBasePath，relativePath 与拼接路径一致）
 */
async function relocateProjectFile(
  fullAppId: string,
  filePath: string
): Promise<{ status: 'unique'; relativePath: string } | { status: 'multiple'; candidates: string[] } | { status: 'none' }> {
  try {
    const filesDir = await getAppBasePath(fullAppId);
    const rootNodes = filterFileNodes(await scanDirectory(filesDir));
    const files: FileNode[] = [];
    const collect = (nodes: FileNode[]) => {
      for (const n of nodes) {
        if (n.type === 'file') files.push(n);
        if (n.children) collect(n.children);
      }
    };
    collect(rootNodes);
    if (files.length === 0) return { status: 'none' };

    const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    const wanted = norm(filePath);
    const baseName = wanted.split('/').pop() || wanted;

    const matched = files.filter((n) => {
      const rel = norm(n.relativePath || n.name);
      return rel === wanted || rel.endsWith(`/${wanted}`) || n.name.toLowerCase() === baseName;
    });

    if (matched.length === 1) {
      return { status: 'unique', relativePath: (matched[0].relativePath || matched[0].name).replace(/\\/g, '/') };
    }
    if (matched.length > 1) {
      return { status: 'multiple', candidates: matched.map((n) => (n.relativePath || n.name).replace(/\\/g, '/')) };
    }
    return { status: 'none' };
  } catch {
    return { status: 'none' };
  }
}

/**
 * 获取语言类型
 */
function getLanguage(ext: string): string {
  const languages: Record<string, string> = {
    py: 'python',
    js: 'javascript',
    ts: 'typescript',
    jsx: 'javascript',
    tsx: 'typescript',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown',
    txt: 'text',
    html: 'html',
    css: 'css',
    sql: 'sql',
    sh: 'bash',
  };
  return languages[ext.toLowerCase()] || 'text';
}

// ============================================================================
// 工具实现
// ============================================================================

/**
 * 🔥 辅助函数：从参数中提取 appId/projectId
 * 支持多种参数名：appId, app_id, projectId, project_id, id
 * 支持从 query 字符串中提取 UUID
 * 校验 UUID 格式（8-4-4-4-12），缩写或不完整的 ID 会报错
 */
function extractAppId(params: any, stepAppId?: string): string | undefined {
  // 🔥 支持多种参数名
  let appId = stepAppId ||
    params?.appId || params?.appid || params?.app_id ||
    params?.projectId || params?.projectid || params?.project_id ||
    params?.id;

  // 🔥 从 query 字符串中提取 UUID
  if (!appId && params?.query) {
    const uuidMatch = (params.query as string).match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
    if (uuidMatch) appId = uuidMatch[1];
  }

  return appId;
}

/**
 * 🔥 解析 projectId 已抽取为共享实现：见 ./ProjectIdResolver.ts
 * （UUID / 8位前缀 / 固定ID如 base-extensiontool 均可解析）
 */

/**
 * 🔥 search 模式：在文件树中递归查找名称匹配的文件（大小写不敏感）
 * 返回匹配节点 + 相对路径 + 父目录节点（用于列出同级文件）
 */
interface FileSearchHit {
  node: FileNode;
  relPath: string;
  parentNode: FileNode | null;
}

function searchFileNodes(
  nodes: FileNode[],
  queryLower: string,
  parentNode: FileNode | null,
  parentRel: string,
  hits: FileSearchHit[],
  depth = 0
): void {
  if (depth > 12 || hits.length > 50) return; // 防御：超深/超多时停止
  for (const node of nodes) {
    const rel = parentRel ? `${parentRel}/${node.name}` : node.name;
    if (node.name.toLowerCase().includes(queryLower)) {
      hits.push({ node, relPath: rel, parentNode });
    }
    if (node.children) {
      searchFileNodes(node.children, queryLower, node, rel, hits, depth + 1);
    }
  }
}

/**
 * 🔥 search 模式：文件名 + 文件内容双搜索
 * - 文件名命中：相对路径 + 同级文件 + 上级目录（原有逻辑）
 * - 内容命中：按文件分组（每文件最多3行片段带行号，同一文件50处匹配也只送一条）
 *   LLM 看到片段后可自行 read_project_file 读全文
 */
async function buildFileSearchResult(files: FileNode[], query: string): Promise<string> {
  const hits: FileSearchHit[] = [];
  searchFileNodes(files, query.toLowerCase(), null, '', hits);

  const parts: string[] = [];

  // ---------- 1. 文件名命中 ----------
  if (hits.length > 0) {
    const MAX_MATCHES = 15;
    const shown = hits.slice(0, MAX_MATCHES);
    parts.push(`### 文件名包含「${query}」的文件（${hits.length} 个${hits.length > MAX_MATCHES ? `，只显示前 ${MAX_MATCHES}` : ''}）`);

    const shownParents = new Set<string>();
    for (const hit of shown) {
      const parentKey = hit.parentNode?.path || '(根目录)';
      const isNewParent = !shownParents.has(parentKey);
      shownParents.add(parentKey);

      parts.push(`\n${hit.relPath}${hit.node.type === 'directory' ? '/' : ''}`);

      if (isNewParent && hit.parentNode?.children) {
        const siblings = hit.parentNode.children
          .slice(0, 30)
          .map(c => (c.name.toLowerCase().includes(query.toLowerCase()) ? `${c.name} ←匹配` : c.name));
        parts.push(`  同级（${hit.parentNode.name}/）：${siblings.join(', ')}`);
      }
    }
  }

  // ---------- 2. 内容命中（grep）----------
  const contentParts = await searchFileContents(files, query);
  if (contentParts) {
    parts.push(`\n${contentParts}`);
  }

  if (parts.length === 0) {
    return `文件名和内容中均未找到「${query}」。可尝试更换关键词，或用 mode='tree' 查看文件树。`;
  }
  return parts.join('\n');
}

/**
 * 🔥 内容搜索：遍历项目文件 grep 关键词，按文件分组返回片段
 * - 跳过二进制/大文件（>512KB）/超长行文件
 * - 每文件最多 3 行片段（带行号），最多 15 个文件，最多扫描 400 个文件（防大项目拖慢）
 */
async function searchFileContents(files: FileNode[], query: string): Promise<string | null> {
  const electron = (window as any).electron;
  if (!electron?.userpcFile?.read) return null;

  // 🔥 收集所有文件（带相对路径）
  const allFiles: { node: FileNode; relPath: string }[] = [];
  const collect = (nodes: FileNode[], parentRel: string) => {
    for (const node of nodes) {
      const rel = parentRel ? `${parentRel}/${node.name}` : node.name;
      if (node.type === 'file') allFiles.push({ node, relPath: rel });
      if (node.children) collect(node.children, rel);
    }
  };
  collect(files, '');

  // 🔥 跳过二进制/压缩产物（搜了也没意义还浪费 IO）
  const SKIP_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'svg', 'pdf', 'zip', 'gz', 'tar', 'exe', 'dll', 'so', 'dylib', 'pt', 'pth', 'onnx', 'bin', 'h5', 'lock', 'woff', 'woff2', 'ttf', 'mp4', 'mp3', 'wav', 'csv'];
  const queryLower = query.toLowerCase();
  const MAX_SCAN = 400;      // 最多扫描文件数
  const MAX_HIT_FILES = 15;  // 最多返回文件数
  const MAX_LINES_PER_FILE = 3;

  const hitFiles: { relPath: string; lines: { no: number; text: string }[]; total: number }[] = [];
  let scanned = 0;

  for (const { node, relPath } of allFiles) {
    if (hitFiles.length >= MAX_HIT_FILES || scanned >= MAX_SCAN) break;
    const ext = (node.name.split('.').pop() || '').toLowerCase();
    if (SKIP_EXTS.includes(ext)) continue;
    if ((node.size || 0) > 512 * 1024) continue; // 跳过大文件

    scanned++;
    try {
      const r = await electron.userpcFile.read(node.path);
      if (!r?.success || !r?.data?.content) continue;
      const lines = r.data.content.split('\n');
      const matched: { no: number; text: string }[] = [];
      let total = 0;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(queryLower)) {
          total++;
          if (matched.length < MAX_LINES_PER_FILE) {
            // 截断超长行，防止 minified 文件一行刷屏
            const text = lines[i].trim().slice(0, 200);
            matched.push({ no: i + 1, text });
          }
          if (total >= 200) break; // 单文件 200 处封顶
        }
      }
      if (matched.length > 0) {
        hitFiles.push({ relPath, lines: matched, total });
      }
    } catch (e) {
      // 单文件读取失败跳过
    }
  }

  if (hitFiles.length === 0) return null;

  const out = [`### 内容包含「${query}」的文件（${hitFiles.length} 个文件命中）`];
  for (const f of hitFiles) {
    out.push(`\n${f.relPath}（${f.total} 处匹配）`);
    for (const l of f.lines) {
      out.push(`  L${l.no}: ${l.text}`);
    }
  }
  out.push(`\n💡 用 read_project_file 读取上述文件全文（可配 pattern 精确定位）`);
  return out.join('\n');
}

/**
 * 🔥 overview 模式：构建项目线索文件概览（README + 关键配置 + 入口候选 + 探索策略）
 * 让 LLM 一次调用就理解项目是干啥的、入口在哪，无需逐层遍历文件树
 */
async function buildProjectOverview(files: FileNode[], fileCount: number): Promise<string> {
  const electron = (window as any).electron;
  const parts: string[] = [];

  // 🔥 递归收集所有文件节点（带相对路径）
  const allNodes: { node: FileNode; relPath: string }[] = [];
  const collect = (nodes: FileNode[], parentRel: string) => {
    for (const node of nodes) {
      const rel = parentRel ? `${parentRel}/${node.name}` : node.name;
      if (node.type === 'file') allNodes.push({ node, relPath: rel });
      if (node.children) collect(node.children, rel);
    }
  };
  collect(files, '');

  // 🔥 关键线索文件优先级：README > 依赖配置 > 入口候选
  const readmeEntry = allNodes.find(n => /^readme/i.test(n.node.name));
  const CONFIG_FILES = ['package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'go.mod', 'Cargo.toml', 'environment.yml', 'pom.xml'];
  const configEntries = allNodes.filter(n => CONFIG_FILES.includes(n.node.name.toLowerCase()));
  const ENTRY_PATTERNS = ['main.py', 'app.py', 'run.py', 'server.py', 'manage.py', 'index.js', 'index.ts', 'app.js', 'app.ts', 'main.ts', 'cli.py'];
  const entryEntries = allNodes.filter(n => ENTRY_PATTERNS.includes(n.node.name.toLowerCase()));

  parts.push(`项目共 ${fileCount} 个文件。关键线索：`);

  // 🔥 读文件辅助（读取失败静默跳过，不阻塞概览）
  const readFileSafe = async (absPath: string, maxLen: number): Promise<string | null> => {
    try {
      const r = await electron?.userpcFile?.read?.(absPath);
      if (r?.success && r?.data?.content) return r.data.content.slice(0, maxLen);
    } catch (e) { /* ignore */ }
    return null;
  };

  // 1. README 摘要（过滤 badge/图片行）
  if (readmeEntry) {
    const content = await readFileSafe(readmeEntry.node.path, 4000);
    if (content) {
      const summary = content
        .split('\n')
        .filter((l: string) => !l.trim().startsWith('![') && !l.trim().startsWith('<img'))
        .slice(0, 40)
        .join('\n')
        .slice(0, 1200);
      parts.push(`\n## ${readmeEntry.node.name}（摘要）\n${summary}`);
    }
  }

  // 2. 依赖配置（截断展示，package.json 的 scripts/dependencies 最关键）
  for (const cfg of configEntries.slice(0, 3)) {
    const content = await readFileSafe(cfg.node.path, 1500);
    if (content) {
      parts.push(`\n## ${cfg.relPath}\n${content}`);
    }
  }

  // 3. 入口候选
  if (entryEntries.length > 0) {
    parts.push(`\n## 入口文件候选\n${entryEntries.map(e => `- ${e.relPath}`).join('\n')}`);
  }

  // 4. 探索策略
  parts.push(`\n## 推荐探索策略
1) 已知项目性质后，用 mode='search' 按关键词定位具体实现文件（返回同级+上级上下文）
2) 用 read_project_file 的 pattern 参数在单文件内搜索关键类/函数
3) 需要整体结构时再用 mode='tree'（depth 建议从 2 开始）`);

  return parts.join('\n');
}

/**
 * 列出训练项目的文件树
 * 
 * @param step - AutoStep
 * @param planId - 计划ID（未使用）
 * @param context - 上下文
 * @returns 文件树结构
 */
export async function executeListProjectFilesTool(
  step: AutoStep,
  _planId: string,
  context?: { userId?: string }
): Promise<AutoToolResult> {
  const params = step.toolParams || step.parameters || {};
  
  // 🔥 提取 appId（支持多种参数名）
  const appId = extractAppId(params, step.appId);

  if (!appId) {
    return {
      success: false,
      error: "缺少 projectId 参数。用法: list_project_files(projectId='xxx') 或 list_project_files(projectId='xxx', depth=1)",
    };
  }

  // 🔥 解析 projectId（支持完整UUID或前8位缩写）
  const resolved = { id: '' };
  const resolveError = await resolveProjectId(appId, resolved, context?.userId);
  if (resolveError) {
    return { success: false, error: resolveError };
  }
  const fullAppId = resolved.id;

  // 🔥 depth 参数：控制文件树展开深度，默认2层
  // depth=1 只看顶层，depth=2 展开一层子目录，depth=0/不限制则全量展开
  const rawDepth = params?.depth !== undefined ? parseInt(params.depth) : 2;
  const maxDepth = isNaN(rawDepth) ? 2 : rawDepth;

  try {
    console.log(`[LIST-FILES] 获取文件树: appId=${fullAppId}, depth=${maxDepth}`);

    const filesDir = await getAppBasePath(fullAppId);
    const historyDir = await getAppHistoryPath(fullAppId);

    // 扫描文件目录
    const allFiles = await scanDirectory(filesDir);
    let files = sortFileNodes(filterFileNodes(allFiles.filter(f => f.name !== 'history')));

    // 🔥 如果顶层只有一个目录（导入的 git 项目常见），自动展开为项目根
    // 避免 "repo-name/" 出现在每个路径前缀，浪费大量 token
    if (files.length === 1 && files[0].type === 'directory' && files[0].children) {
      files = sortFileNodes(filterFileNodes(files[0].children));
    }

    // 扫描历史目录
    const history = await scanHistoryDirectory(historyDir);

    // 🔥 统计文件总数
    const countFiles = (nodes: FileNode[]): number => {
      let count = 0;
      for (const node of nodes) {
        if (node.type === 'file') count++;
        if (node.children) count += countFiles(node.children);
      }
      return count;
    };
    const fileCount = countFiles(files);

    // 🔥 阅读模式分发：tree（默认，纯文件树）/ overview（关键线索文件）/ search（按文件名搜索+局部上下文）
    // 容错：只传了 query 没传 mode 时，自动按 search 处理（传什么参数就是什么模式）
    let mode = String(params?.mode || (params?.query ? 'search' : 'tree')).toLowerCase();
    if (mode !== 'tree' && mode !== 'overview' && mode !== 'search') {
      mode = params?.query ? 'search' : 'tree'; // 未知 mode 值兜底
    }
    const query = params?.query ? String(params.query).trim() : '';

    if (mode === 'overview') {
      const overviewMessage = await buildProjectOverview(files, fileCount);
      return {
        success: true,
        data: { type: 'overview', appId: fullAppId, fileCount, message: overviewMessage },
      };
    }

    if (mode === 'search') {
      if (!query) {
        return {
          success: false,
          error: "search 模式需要 query 参数。用法: list_project_files(projectId='xxx', mode='search', query='config')",
        };
      }
      const searchMessage = await buildFileSearchResult(files, query);
      return {
        success: true,
        data: { type: 'search', appId: fullAppId, query, message: searchMessage },
      };
    }

    // 🔥 构建紧凑的 tree 格式（受 depth 限制）
    // 类似 `tree` 命令输出，层级靠缩进表达，文件名不重复路径前缀
    const buildTree = (nodes: FileNode[], currentDepth: number): string[] => {
      const lines: string[] = [];
      for (const node of nodes) {
        if (node.type === 'file') {
          lines.push(node.name);
        } else if (node.type === 'directory' || node.children) {
          if (maxDepth > 0 && currentDepth >= maxDepth) {
            const childFiles = countFiles([node]);
            const subDirs = (node.children || []).filter(c => c.type === 'directory' || c.children).length;
            const hint = subDirs > 0
              ? `${node.name}/ (${childFiles}个文件, ${subDirs}个子目录, 用depth=${currentDepth + 1}展开)`
              : `${node.name}/ (${childFiles}个文件, 用depth=${currentDepth + 1}展开)`;
            lines.push(hint);
          } else {
            const childLines = buildTree(node.children || [], currentDepth + 1);
            if (childLines.length > 0) {
              lines.push(`${node.name}/`);
              for (const cl of childLines) {
                lines.push(`  ${cl}`);
              }
            } else {
              lines.push(`${node.name}/ (空)`);
            }
          }
        }
      }
      return lines;
    };

    const treeLines = buildTree(files, 1);

    console.log(`[LIST-FILES] 获取成功: ${fileCount} 个文件, depth=${maxDepth}, 树${treeLines.length}行`);

    // 🔥 输出大小保护：限制消息长度，防止撑爆 LLM 上下文
    const MAX_MESSAGE_LENGTH = 30000; // 约 8K tokens
    let treeMessage = `项目包含 ${fileCount} 个文件，${history.length} 个历史版本\n\n`;
    const treeText = treeLines.join('\n');

    if (treeText.length > MAX_MESSAGE_LENGTH) {
      treeMessage += treeText.slice(0, MAX_MESSAGE_LENGTH);
      treeMessage += `\n\n⚠️ 文件列表过长已截断（共${fileCount}个文件）。请使用 depth 参数缩小范围，或用 read_project_file 按需读取。`;
    } else {
      treeMessage += treeText;
      if (maxDepth > 0 && maxDepth < 10) {
        treeMessage += `\n\n💡 提示：当前显示 depth=${maxDepth} 层，使用 list_project_files(projectId='${appId}', depth=${maxDepth + 1}) 展开更多。`;
      }
    }

    // 🔥 大项目指引：指向其他阅读模式，避免 LLM 逐层遍历文件树
    if (fileCount > 30) {
      treeMessage += `\n\n💡 这是大项目（${fileCount}个文件）。建议：mode='overview' 看关键线索文件（README/配置/入口）；mode='search', query='关键词' 按文件名搜索定位。`;
    }

    // 🔥 不再返回扁平路径数组 files[]
    // tree 格式已经通过缩进表达了层级关系，agent 可从 tree 推导路径
    // 扁平数组每个文件都重复完整前缀，token 浪费严重
    return {
      success: true,
      data: {
        type: 'fileTree',
        appId: fullAppId,
        fileCount,
        depth: maxDepth,
        historyCount: history.length,
        history: history.map(h => ({
          fileName: h.fileName,
          version: h.version.versionName,
        })),
        message: treeMessage,
      },
    };
  } catch (error) {
    console.error('[LIST-FILES] 异常:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "获取文件树失败",
    };
  }
}

/**
 * 读取训练项目的单个文件
 * 
 * @param step - AutoStep
 * @param planId - 计划ID（未使用）
 * @param context - 上下文
 * @returns 文件内容
 */
export async function executeReadProjectFileTool(
  step: AutoStep,
  _planId: string,
  context?: { userId?: string }
): Promise<AutoToolResult> {
  const params = step.toolParams || step.parameters || {};
  
  // 🔥 入口日志：记录原始参数
  console.log(`[READ-FILE] 🔍 入口参数:`, JSON.stringify(params));
  
  // 🔥 提取 appId（支持多种参数名）
  const appId = extractAppId(params, step.appId);
  console.log(`[READ-FILE] 🔍 提取 appId: ${appId}`);
  
  // 提取 filePath（let：路径定位兜底命中后会被改写为真实相对路径）
  let filePath = params?.filePath || params?.filepath || params?.file_path || params?.path || params?.fileName;
  console.log(`[READ-FILE] 🔍 提取 filePath: ${filePath}`);

  // 🔥 提取可选的搜索参数
  const pattern = params?.pattern || params?.search || params?.query;
  if (pattern) {
    console.log(`[READ-FILE] 🔍 提取 pattern: ${pattern}`);
  }

  // 🔥 提取可选的行号范围参数（支持多种参数名风格）
  // LLM 常见习惯：offset/limit, startLine/endLine, lineNumber, start/end
  let offset: number | undefined;
  let limit: number | undefined;
  
  // 方式1: offset + limit（最常见）
  if (params?.offset) offset = parseInt(params.offset, 10);
  if (params?.limit) limit = parseInt(params.limit, 10);
  
  // 方式2: startLine + endLine
  if (params?.startLine) offset = parseInt(params.startLine, 10);
  if (params?.endLine && offset) limit = parseInt(params.endLine, 10) - offset + 1;
  
  // 方式3: start + end
  if (params?.start && !offset) offset = parseInt(params.start, 10);
  if (params?.end && offset) limit = parseInt(params.end, 10) - offset + 1;
  
  // 方式4: lineNumber（单行）
  if (params?.lineNumber) {
    offset = parseInt(params.lineNumber, 10);
    limit = 1;
  }
  if (params?.line) {
    offset = parseInt(params.line, 10);
    limit = 1;
  }
  
  if (offset !== undefined || limit !== undefined) {
    console.log(`[READ-FILE] 🔍 行号范围: offset=${offset}, limit=${limit}`);
  }

  if (!appId) {
    console.warn(`[READ-FILE] ❌ 失败原因: 缺少 projectId 参数`);
    return {
      success: false,
      error: "缺少 projectId 参数。用法: read_project_file(projectId='xxx', filePath='main.py')",
    };
  }

  // 🔥 解析 projectId（支持完整UUID或前8位缩写）
  const resolved = { id: '' };
  const resolveError = await resolveProjectId(appId, resolved, context?.userId);
  if (resolveError) {
    console.warn(`[READ-FILE] ❌ 失败原因: projectId 解析失败 - ${resolveError}`);
    return { success: false, error: resolveError };
  }
  const fullAppId = resolved.id;
  console.log(`[READ-FILE] 🔍 解析后完整 projectId: ${fullAppId}`);

  if (!filePath) {
    console.warn(`[READ-FILE] ❌ 失败原因: 缺少 filePath 参数`);
    return {
      success: false,
      error: "缺少 filePath 参数。用法: read_project_file(projectId='xxx', filePath='main.py')",
    };
  }

  try {
    console.log(`[READ-FILE] 📖 开始读取: appId=${fullAppId}, filePath=${filePath}`);

    const electron = (window as any).electron;

    if (!electron?.userpcFile) {
      return {
        success: false,
        error: "非 Electron 环境，无法读取文件",
      };
    }

    const baseDir = await getAppBasePath(fullAppId);
    
    // 标准化路径
    const normalizedPath = filePath.replace(/\//g, '\\');
    const fullPath = `${baseDir}\\${normalizedPath}`;

    // 读取文件
    let result = await electron.userpcFile.read(fullPath);

    if (!result.success) {
      // 🔥 路径定位兜底：LLM 传的 filePath 可能是裸文件名（server.ts）或层级猜错的
      // 相对路径——典型如 base-bootcode 仓库套层项目，文件在 teegal-autoprojects/ 子目录下
      const relocated = await relocateProjectFile(fullAppId, filePath);
      if (relocated.status === 'unique') {
        console.log(`[READ-FILE] 🔁 路径定位兜底: ${filePath} → ${relocated.relativePath}`);
        filePath = relocated.relativePath;
        result = await electron.userpcFile.read(`${baseDir}\\${filePath.replace(/\//g, '\\')}`);
        if (!result.success) {
          return { success: false, error: result.error || `文件不存在: ${filePath}` };
        }
      } else if (relocated.status === 'multiple') {
        const list = relocated.candidates.slice(0, 10).join('\n  ');
        return {
          success: false,
          error: `文件不存在: ${filePath}。项目内找到 ${relocated.candidates.length} 个同名/同路径文件，请用完整相对路径重试：\n  ${list}`,
        };
      } else {
        return { success: false, error: result.error || `文件不存在: ${filePath}` };
      }
    }

    const content = result.data?.content || '';
    const ext = filePath.split('.').pop() || 'txt';
    const language = getLanguage(ext);

    // 🔥 按 pattern/offset/limit 截取内容
    let displayContent = content;
    let lineInfo = '';

    // 🔥 优先使用 pattern 搜索
    if (pattern) {
      const lines = content.split('\n');

      try {
        const regex = new RegExp(pattern, 'i'); // 不区分大小写

        // 🔥 找到所有匹配行
        const matchIndices: number[] = [];
        for (let idx = 0; idx < lines.length; idx++) {
          if (regex.test(lines[idx])) {
            matchIndices.push(idx);
          }
          // 🔥 最多搜索 100 个匹配，避免大文件卡死
          if (matchIndices.length >= 100) break;
        }

        if (matchIndices.length === 0) {
          return {
            success: false,
            error: `未找到匹配内容: pattern="${pattern}"`,
          };
        }

        const contextLines = limit || 20; // 默认每个匹配取 20 行（从匹配行开始往后）
        const MAX_TOTAL_LINES = 1000; // 🔥 搜索结果总行数预算：命中密集时自动收缩每处上下文，防止覆盖整个大文件

        // 🔥 将命中区间合并（重叠/相邻的区间合为一段，消除相邻命中导致的重复内容）
        const mergeRanges = (indices: number[], ctx: number): Array<[number, number]> => {
          const merged: Array<[number, number]> = [];
          for (const idx of indices) {
            const end = Math.min(lines.length, idx + ctx);
            const last = merged[merged.length - 1];
            if (last && idx <= last[1]) {
              last[1] = Math.max(last[1], end); // 与上一段重叠/相邻，扩展
            } else {
              merged.push([idx, end]);
            }
          }
          return merged;
        };
        const totalLinesOf = (ranges: Array<[number, number]>) =>
          ranges.reduce((sum, r) => sum + (r[1] - r[0]), 0);

        let ctx = contextLines;
        let mergedRanges = mergeRanges(matchIndices, ctx);
        // 🔥 总行数超预算时逐级减半收缩上下文（下限 20 行），命中越多每处取得越少
        while (totalLinesOf(mergedRanges) > MAX_TOTAL_LINES && ctx > 20) {
          ctx = Math.max(20, Math.floor(ctx / 2));
          mergedRanges = mergeRanges(matchIndices, ctx);
        }

        const results = mergedRanges.map(([start, end]) =>
          `--- 第 ${start + 1}-${end} 行 ---\n${lines.slice(start, end).join('\n')}`
        );

        displayContent = results.join('\n\n');
        lineInfo = `（搜索 "${pattern}" 匹配 ${matchIndices.length} 处，合并为 ${mergedRanges.length} 段，每处取 ${ctx} 行上下文，共 ${totalLinesOf(mergedRanges)} 行）`;

        console.log(`[READ-FILE] 搜索匹配: "${pattern}" 匹配 ${matchIndices.length} 处，合并为 ${mergedRanges.length} 段，每处取 ${ctx} 行`);
      } catch (e) {
        return {
          success: false,
          error: `正则表达式错误: pattern="${pattern}", 错误信息: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }
    // 🔥 否则使用 offset/limit 定点读取
    else if (offset !== undefined || limit !== undefined) {
      const lines = content.split('\n');
      const startLine = Math.max(0, (offset || 1) - 1); // offset 从 1 开始，转换为 0-based index
      const lineCount = limit || 50; // 默认 50 行

      const selectedLines = lines.slice(startLine, startLine + lineCount);
      displayContent = selectedLines.join('\n');

      const endLine = Math.min(lines.length, startLine + lineCount);
      lineInfo = `（第 ${startLine + 1}-${endLine} 行，共 ${lines.length} 行）`;

      console.log(`[READ-FILE] 按行号截取: ${startLine + 1}-${endLine} 行`);
    }

    console.log(`[READ-FILE] 读取成功: ${filePath}${lineInfo}, 大小: ${displayContent.length} 字符`);

    return {
      success: true,
      data: {
        type: 'fileContent',
        appId: fullAppId,
        filePath,
        content: displayContent,
        language,
        size: displayContent.length,
        totalSize: content.length,
        lineInfo,
        message: `读取文件 "${filePath}"${lineInfo} 成功，共 ${displayContent.length} 字符`,
      },
    };
  } catch (error) {
    console.error('[READ-FILE] 异常:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "读取文件失败",
    };
  }
}

/**
 * 保存/创建训练项目文件
 * 
 * @param step - AutoStep
 * @param planId - 计划ID（未使用）
 * @param context - 上下文
 * @returns 操作结果
 */
export async function executeSaveProjectFileTool(
  step: AutoStep,
  _planId: string,
  context?: { userId?: string; conversationId?: string }
): Promise<AutoToolResult> {
  const params = step.toolParams || step.parameters || {};
  
  // 🔥 提取 appId（支持多种参数名）
  const appId = extractAppId(params, step.appId);
  
  // 提取 filePath
  const filePath = params?.filePath || params?.filepath || params?.file_path || params?.path || params?.fileName;
  
  // 提取 content
  let content = params?.content || params?.code;

  // 🔥 检查 content 是否是 JSON 字符串（被转义了）
  // 如果 content 以引号开头，可能是 JSON.stringify 转义后的字符串
  if (content && typeof content === 'string') {
    // 检查是否是 JSON 字符串格式（以 " 开头，包含转义字符）
    const trimmedContent = content.trim();
    if (trimmedContent.startsWith('"') && trimmedContent.endsWith('"')) {
      try {
        // 尝试解析 JSON 字符串
        const parsedContent = JSON.parse(trimmedContent);
        if (typeof parsedContent === 'string') {
          console.log(`[SAVE-FILE] 检测到 JSON 字符串格式，已解析: 原长度=${content.length}, 解析后长度=${parsedContent.length}`);
          content = parsedContent;
        }
      } catch (e) {
        // 解析失败，保持原样
        console.warn(`[SAVE-FILE] JSON 字符串解析失败，保持原样`);
      }
    }
    
    // 🔥 检测并修复字面量转义序列（\n → 真正的换行）
    // LLM 常见问题：在 JSON 参数中输出 "content": "line1\\nline2"
    // JSON.parse 后得到 "line1\nline2"（字面量 \n，两个字符），而非真正的换行
    // 判断标准：content 包含字面量 \n 但没有真正的换行符 → 说明是转义残留
    const hasLiteralEscape = /\\[nrt]/.test(content);
    const hasRealNewline = content.includes('\n');
    if (hasLiteralEscape && !hasRealNewline) {
      try {
        // 用 JSON.parse 解码转义序列
        const decodedContent = JSON.parse(`"${content}"`);
        if (typeof decodedContent === 'string' && decodedContent.includes('\n')) {
          console.log(`[SAVE-FILE] 修复字面量转义: 原长度=${content.length}, 修复后长度=${decodedContent.length}`);
          content = decodedContent;
        }
      } catch (e) {
        // JSON.parse 失败，手动替换常见转义
        content = content.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r');
        console.log(`[SAVE-FILE] 手动修复字面量转义`);
      }
    }

    // 🔥 解码 Unicode 转义序列（如 \u5f00\u76d8 -> 开盘）
    // LLM 可能输出 Unicode 转义的中文字符
    if (content.includes('\\u')) {
      try {
        // 使用 JSON.parse 来解码 Unicode 转义
        const decodedContent = JSON.parse(`"${content}"`);
        if (typeof decodedContent === 'string') {
          console.log(`[SAVE-FILE] 检测到 Unicode 转义，已解码: 原长度=${content.length}, 解码后长度=${decodedContent.length}`);
          content = decodedContent;
        }
      } catch (e) {
        // 解析失败，尝试手动解码
        content = content.replace(/\\u([0-9a-fA-F]{4})/g, (match, hex) => {
          return String.fromCharCode(parseInt(hex, 16));
        });
        console.log(`[SAVE-FILE] 手动解码 Unicode 转义完成`);
      }
    }
  }

  if (!appId) {
    return {
      success: false,
      error: "缺少 projectId 参数。用法: save_project_file(projectId='xxx', filePath='main.py', content='...')",
    };
  }

  // 🔥 .json 文件自动 pretty-print：LLM 常写紧凑单行 JSON（省 token 但没法看），
  // 保存前格式化为 2 空格缩进；解析失败（JSON 不合法）则原样保存不拦截
  content = prettyPrintJsonIfNeeded(filePath, content);

  // 🔥 解析 projectId（支持完整UUID或前8位缩写）
  const resolved = { id: '' };
  const resolveError = await resolveProjectId(appId, resolved, context?.userId);
  if (resolveError) {
    return { success: false, error: resolveError };
  }
  const fullAppId = resolved.id;

  if (!filePath) {
    return {
      success: false,
      error: "缺少 filePath 参数。用法: save_project_file(projectId='xxx', filePath='main.py', content='...')",
    };
  }

  if (!content || typeof content !== 'string') {
    return {
      success: false,
      error: "缺少 content 参数。用法: save_project_file(projectId='xxx', filePath='main.py', content='...')",
    };
  }

  try {
    console.log(`[SAVE-FILE] 保存文件: appId=${fullAppId}, filePath=${filePath}`);

    const electron = (window as any).electron;

    if (!electron?.saveAppCodeFile) {
      return {
        success: false,
        error: "非 Electron 环境，无法保存文件",
      };
    }

    const codePath = await getCodePath(fullAppId);
    
    // 标准化路径
    const normalizedPath = filePath.replace(/\//g, '\\');

    // 检查文件是否存在
    const existsResult = await electron.checkAppCodeFileExists({ appId: fullAppId, fileName: normalizedPath, codePath: codePath || undefined });
    const isNewFile = !existsResult?.exists;

    console.log(`[SAVE-FILE] 文件存在检查: exists=${existsResult?.exists}, isNewFile=${isNewFile}`);

    // 保存文件（历史版本备份已在 electron 主进程中处理）
    const result = await electron.saveAppCodeFile({ appId: fullAppId, fileName: normalizedPath, content, codePath: codePath || undefined });

    if (!result?.success) {
      return {
        success: false,
        error: result?.error || "保存失败",
      };
    }

    console.log(`[SAVE-FILE] 保存成功: ${filePath}`);

    // 🔥 热重载：保存的是基础项目的 tools/ 文件（工具代码或 registry.json）时，
    // 自动重新加载动态工具；await 确保下一轮 prompt 的工具列表必然包含新工具
    await triggerBaseToolReload(fullAppId, filePath, context?.userId);

    // 🔥 发送事件通知 FileTree 刷新 + DesktopAppCard 显示修改图标
    window.dispatchEvent(new CustomEvent('trainProjectFilesChanged', {
      detail: { appId: fullAppId, filePath, action: 'save' }
    }));

    // 🔥 touch 活跃度
    await touchAppUpdatedAt(fullAppId);

    return {
      success: true,
      data: {
        type: 'fileSaved',
        appId: fullAppId,
        filePath,
        isNewFile,
        size: content.length,
        message: isNewFile 
          ? `创建文件 "${filePath}" 成功` 
          : `保存文件 "${filePath}" 成功`,
      },
    };
  } catch (error) {
    console.error('[SAVE-FILE] 异常:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "保存文件失败",
    };
  }
}

/**
 * 删除训练项目文件
 * 
 * @param step - AutoStep
 * @param planId - 计划ID（未使用）
 * @param context - 上下文
 * @returns 操作结果
 */
export async function executeDeleteProjectFileTool(
  step: AutoStep,
  _planId: string,
  context?: { userId?: string }
): Promise<AutoToolResult> {
  const params = step.toolParams || step.parameters || {};
  
  // 🔥 提取 appId（支持多种参数名）
  const appId = extractAppId(params, step.appId);
  
  // 提取 filePath
  const filePath = params?.filePath || params?.filepath || params?.file_path || params?.path || params?.fileName;

  if (!appId) {
    return {
      success: false,
      error: "缺少 projectId 参数。用法: delete_project_file(projectId='xxx', filePath='old.py')",
    };
  }

  // 🔥 解析 projectId（支持完整UUID或前8位缩写）
  const resolved = { id: '' };
  const resolveError = await resolveProjectId(appId, resolved, context?.userId);
  if (resolveError) {
    return { success: false, error: resolveError };
  }
  const fullAppId = resolved.id;

  if (!filePath) {
    return {
      success: false,
      error: "缺少 filePath 参数。用法: delete_project_file(projectId='xxx', filePath='old.py')",
    };
  }

  try {
    console.log(`[DELETE-FILE] 删除文件: appId=${fullAppId}, filePath=${filePath}`);

    const electron = (window as any).electron;

    if (!electron?.userpcFile?.delete) {
      return {
        success: false,
        error: "非 Electron 环境，无法删除文件",
      };
    }

    const baseDir = await getAppBasePath(fullAppId);

    // 标准化路径
    const normalizedPath = filePath.replace(/\//g, '\\');
    const fullPath = `${baseDir}\\${normalizedPath}`;

    // 检查文件是否存在
    const existsResult = await electron.userpcFile.exists(fullPath);

    if (!existsResult?.success || !existsResult?.data?.exists) {
      return {
        success: false,
        error: `文件不存在: ${filePath}`,
      };
    }

    // 删除文件
    const result = await electron.userpcFile.delete(fullPath);

    if (!result?.success) {
      return {
        success: false,
        error: result?.error || "删除失败",
      };
    }

    // 同时删除 history 中的备份（history 始终在默认路径下）
    const historyDir = await getAppHistoryPath(fullAppId);
    const historyPath = `${historyDir}\\${normalizedPath}`;
    try {
      const historyExists = await electron.userpcFile.exists(historyPath);
      if (historyExists?.success && historyExists?.data?.exists) {
        await electron.userpcFile.delete(historyPath);
      }
    } catch (e) {
      // history 删除失败不影响主流程
    }

    console.log(`[DELETE-FILE] 删除成功: ${filePath}`);

    // 🔥 热重载：删除的是基础项目的 tools/ 文件时，同步刷新动态工具（registry 清理后注销旧工具）
    await triggerBaseToolReload(fullAppId, filePath, context?.userId);

    // 🔥 发送事件通知 FileTree 刷新
    window.dispatchEvent(new CustomEvent('trainProjectFilesChanged', {
      detail: { appId: fullAppId, filePath, action: 'delete' }
    }));

    // 🔥 touch 活跃度
    await touchAppUpdatedAt(fullAppId);

    return {
      success: true,
      data: {
        type: 'fileDeleted',
        appId: fullAppId,
        filePath,
        message: `删除文件 "${filePath}" 成功`,
      },
    };
  } catch (error) {
    console.error('[DELETE-FILE] 异常:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "删除文件失败",
    };
  }
}

// ============================================================================
// edit_project_file: 局部编辑文件（search/replace 模式）
// ============================================================================

/**
 * 局部编辑项目文件（edit_project_file）
 *
 * 🔥 使用 search/replace 模式，只传需要修改的代码片段，不需要传整个文件内容
 * 支持多个 edits，按顺序依次应用
 * 比save_project_file更省token，尤其适合大文件的局部修改
 *
 * 用法:
 *   edit_project_file(projectId='xxx', filePath='main.py', edits=[
 *     {oldText: 'lr=0.001', newText: 'lr=0.0001'},
 *     {oldText: 'epochs=10', newText: 'epochs=50'}
 *   ])
 *
 * 也可以单个编辑:
 *   edit_project_file(projectId='xxx', filePath='main.py', oldText='lr=0.001', newText='lr=0.0001')
 */
export async function executeEditProjectFileTool(
  step: AutoStep,
  _planId: string,
  context?: { userId?: string; conversationId?: string }
): Promise<AutoToolResult> {
  const params = step.toolParams || step.parameters || {};

  // 🔥 提取 projectId
  const appId = extractAppId(params, step.appId);

  // 提取 filePath
  const filePath = params?.filePath || params?.filepath || params?.file_path || params?.path || params?.fileName;

  if (!appId) {
    return {
      success: false,
      error: "缺少 projectId 参数。用法: edit_project_file(projectId='xxx', filePath='main.py', edits=[{oldText:'...', newText:'...'}])",
    };
  }

  // 🔥 解析 projectId（支持完整UUID或前8位缩写）
  const resolved = { id: '' };
  const resolveError = await resolveProjectId(appId, resolved, context?.userId);
  if (resolveError) {
    return { success: false, error: resolveError };
  }
  const fullAppId = resolved.id;

  if (!filePath) {
    return {
      success: false,
      error: "缺少 filePath 参数。用法: edit_project_file(projectId='xxx', filePath='main.py', edits=[{oldText:'...', newText:'...'}])",
    };
  }

  // 🔥 提取 edits：支持数组和单个 oldText/newText 两种形式
  let edits: Array<{ oldText: string; newText: string }> = [];

  if (Array.isArray(params?.edits)) {
    edits = params.edits.filter((e: any) => e.oldText && e.newText !== undefined).map((e: any) => ({
      oldText: String(e.oldText),
      newText: String(e.newText),
    }));
  } else if (params?.oldText !== undefined) {
    // 单个编辑模式
    edits = [{ oldText: String(params.oldText), newText: String(params.newText ?? '') }];
  }

  if (edits.length === 0) {
    return {
      success: false,
      error: "缺少 edits 参数。用法: edit_project_file(projectId='xxx', filePath='main.py', edits=[{oldText:'...', newText:'...'}]) 或 edit_project_file(projectId='xxx', filePath='main.py', oldText='...', newText='...')",
    };
  }

  try {
    console.log(`[EDIT-FILE] 编辑文件: appId=${fullAppId}, filePath=${filePath}, edits=${edits.length}`);

    const electron = (window as any).electron;

    if (!electron?.readAppCodeFile || !electron?.saveAppCodeFile) {
      return {
        success: false,
        error: "非 Electron 环境，无法编辑文件",
      };
    }

    const codePath = await getCodePath(fullAppId);
    const normalizedPath = filePath.replace(/\//g, '\\');

    // 1. 读取当前文件内容
    const readResult = await electron.readAppCodeFile({ appId: fullAppId, fileName: normalizedPath, codePath: codePath || undefined });
    if (!readResult?.success) {
      return {
        success: false,
        error: `读取文件失败: ${readResult?.error || '文件不存在'}`,
      };
    }

    let content: string = readResult.content || '';
    const appliedEdits: string[] = [];
    const failedEdits: string[] = [];
    // 🔥 记录每个成功 edit 的 diff 片段（用于返回值展示）
    const diffParts: string[] = [];

    // 🔥 将文本转为 diff 格式：每行加 -/+ 前缀
    const toDiffLines = (text: string, prefix: '-' | '+'): string => {
      return text.replace(/\r\n/g, '\n').split('\n').map(line => `${prefix} ${line}`).join('\n');
    };

    // 🔥 规范化空白符的匹配函数：忽略行尾空白和换行符差异
    const normalizeForMatch = (text: string): string => {
      return text.replace(/\r\n/g, '\n').replace(/\t/g, '  ');
    };

    // 2. 按顺序应用每个 edit
    for (let i = 0; i < edits.length; i++) {
      const { oldText, newText } = edits[i];

      // 精确匹配
      if (content.includes(oldText)) {
        content = content.replace(oldText, newText);
        appliedEdits.push(`编辑${i + 1}: 成功替换`);
        diffParts.push(toDiffLines(oldText, '-') + '\n' + toDiffLines(newText, '+'));
        continue;
      }

      // 🔥 容错匹配：规范化空白符后再匹配
      const normalizedContent = normalizeForMatch(content);
      const normalizedOldText = normalizeForMatch(oldText);

      if (normalizedContent.includes(normalizedOldText)) {
        // 找到规范化匹配的位置，在原内容中定位并替换
        const normStartIdx = normalizedContent.indexOf(normalizedOldText);
        // 计算原始内容中对应的起止位置
        let charCount = 0;
        let origStartIdx = 0;
        let origEndIdx = 0;
        let found = false;

        for (let ci = 0; ci < content.length; ci++) {
          const normalizedChar = normalizeForMatch(content[ci]);
          for (const ch of normalizedChar) {
            if (charCount === normStartIdx) {
              origStartIdx = ci;
            }
            charCount++;
            if (charCount === normStartIdx + normalizedOldText.length) {
              origEndIdx = ci + 1;
              found = true;
              break;
            }
          }
          if (found) break;
        }

        if (found) {
          content = content.substring(0, origStartIdx) + newText + content.substring(origEndIdx);
          appliedEdits.push(`编辑${i + 1}: 成功替换（规范化匹配）`);
          diffParts.push(toDiffLines(oldText, '-') + '\n' + toDiffLines(newText, '+'));
          continue;
        }
      }

      // 🔥 最后尝试：模糊匹配（跳过空白符差异）
      // 将 oldText 和 content 都压缩空白符后匹配
      const compressWhitespace = (text: string): string => {
        return text.replace(/\s+/g, ' ').trim();
      };

      const compressedContent = compressWhitespace(content);
      const compressedOldText = compressWhitespace(oldText);

      if (compressedContent.includes(compressedOldText)) {
        // 模糊匹配成功，但无法精确定位，使用精确的 oldText 匹配结果
        // 这种情况下，我们提示 LLM 提供更精确的 oldText
        failedEdits.push(`编辑${i + 1}: 未找到精确匹配（空白符差异过大，请使用read_project_file后精确复制代码片段）`);
        continue;
      }

      failedEdits.push(`编辑${i + 1}: 未找到匹配的代码片段 (oldText前50字符: "${oldText.substring(0, 50)}...")`);
    }

    // 3. 如果有成功的编辑，保存文件
    const hasChanges = appliedEdits.length > 0;

    if (hasChanges) {
      // 🔥 .json 自动 pretty-print（与 save_project_file 一致）
      content = prettyPrintJsonIfNeeded(filePath, content);
      const saveResult = await electron.saveAppCodeFile({ appId: fullAppId, fileName: normalizedPath, content, codePath: codePath || undefined });

      if (!saveResult?.success) {
        return {
          success: false,
          error: `编辑成功但保存失败: ${saveResult?.error || '未知错误'}`,
        };
      }

      console.log(`[EDIT-FILE] 编辑保存成功: ${filePath}, 成功${appliedEdits.length}项, 失败${failedEdits.length}项`);

      // 🔥 热重载：编辑的是基础项目的 tools/ 文件时（典型：LLM 用 edit 更新已存在的 registry.json），
      // 同步重新加载动态工具——之前此路径无钩子，是"工具注册了但不进 prompt"的根因
      await triggerBaseToolReload(fullAppId, filePath, context?.userId);

      // 🔥 发送事件通知 FileTree 刷新 + DesktopAppCard 显示修改图标
      window.dispatchEvent(new CustomEvent('trainProjectFilesChanged', {
        detail: { appId: fullAppId, filePath, action: 'save' }
      }));
    }

    // 4. 构造结果
    const resultParts: string[] = [];
    if (appliedEdits.length > 0) {
      resultParts.push(`✅ 成功 ${appliedEdits.length} 项:\n${appliedEdits.join('\n')}`);
    }
    if (failedEdits.length > 0) {
      resultParts.push(`❌ 失败 ${failedEdits.length} 项:\n${failedEdits.join('\n')}`);
    }

    // 🔥 如果有成功的编辑，附带完整 diff（markdown diff 代码块，前端可高亮渲染）
    // 不截断：截断会导致 LLM 重新读文件确认，反而浪费更多 token
    if (diffParts.length > 0) {
      const diffText = diffParts.join('\n');
      resultParts.push(`\`\`\`diff\n${diffText}\n\`\`\``);
    }

    // 🔥 touch 活跃度
    if (hasChanges) {
      await touchAppUpdatedAt(fullAppId);
    }

    return {
      success: hasChanges,
      data: {
        type: 'fileEdited',
        appId: fullAppId,
        filePath,
        appliedCount: appliedEdits.length,
        failedCount: failedEdits.length,
        message: resultParts.join('\n\n'),
      },
    };
  } catch (error) {
    console.error('[EDIT-FILE] 异常:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "编辑文件失败",
    };
  }
}

// ============================================================================
// 训练任务历史工具
// ============================================================================

/**
 * 训练任务列表项（简化版）
 */
export interface TrainTaskListItem {
  id: string;
  app_id: string | null;
  status: string;
  instance_type: string | null;
  duration: number | null;
  cost: number | null;
  flag: string | null;
  remark: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * 训练任务详情（完整版）
 */
export interface TrainTaskDetail {
  id: string;
  app_id: string | null;
  user_id: string;
  status: string;
  stdout_output: string | null;
  charts_json: any[];
  files_json: Record<string, any>;
  model_oss_url: string | null;
  instance_type: string | null;
  gpu_instance_id: string | null;
  duration: number | null;
  cost: number | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * 列出训练任务
 * 
 * @param step - AutoStep
 * @param planId - 计划ID（未使用）
 * @param context - 上下文
 * @returns 任务列表（简化版）
 */
export async function executeListTrainTasksTool(
  step: AutoStep,
  _planId: string,
  context?: { userId?: string }
): Promise<AutoToolResult> {
  const params = step.toolParams || step.parameters || {};
  
  // 🔥 提取 appId（支持多种参数名）
  const appId = extractAppId(params, step.appId);

  if (!appId) {
    return {
      success: false,
      error: "缺少 appId/projectId 参数。用法: list_train_tasks(appId='xxx')",
    };
  }

  // 🔥 解析 projectId（支持完整UUID或前8位缩写）
  const resolved = { id: '' };
  const resolveError = await resolveProjectId(appId, resolved, context?.userId);
  if (resolveError) {
    return { success: false, error: resolveError };
  }
  const fullAppId = resolved.id;

  try {
    console.log(`[LIST-TASKS] 获取训练任务列表: appId=${fullAppId}`);

    // 🔥 使用 trainingTaskStorage 而不是直接 fetch
    const { trainingTaskStorage } = await import('@/services/storage');
    const tasks = await trainingTaskStorage.getByAppId(fullAppId);

    // 🔥 只返回简化字段，不返回 stdout_output、charts_json 等大字段
    const simplifiedTasks: TrainTaskListItem[] = tasks.map((task: any) => ({
      id: task.id,
      app_id: task.app_id,
      status: task.status,
      instance_type: task.instance_type,
      duration: task.duration,
      cost: task.cost,
      flag: task.flag,
      remark: task.remark,  // 🔥 训练备注
      created_at: task.created_at,
      updated_at: task.updated_at,
    }));

    console.log(`[LIST-TASKS] 获取成功: ${simplifiedTasks.length} 个任务`);

    const totalCount = simplifiedTasks.length;

    // 🔥 分页：解析 morePage 参数（格式如 "11-20"）
    const morePage = params?.morePage || params?.more_page;
    let startIdx = 0;
    let endIdx = 10;
    if (morePage && typeof morePage === 'string') {
      const match = morePage.match(/^(\d+)-(\d+)$/);
      if (match) {
        startIdx = Math.max(0, parseInt(match[1]) - 1);
        endIdx = Math.min(totalCount, parseInt(match[2]));
      }
    }

    const pagedTasks = simplifiedTasks.slice(startIdx, endIdx);

    // 🔥 构造更友好的返回信息
    let taskSummary = `项目共有 ${totalCount} 个训练任务，当前展示第 ${startIdx + 1}-${Math.min(endIdx, totalCount)} 个：\n\n`;
    pagedTasks.forEach((task, index) => {
      taskSummary += `${startIdx + index + 1}. 任务ID: ${task.id}\n`;
      taskSummary += `   状态: ${task.status}\n`;
      if (task.flag) taskSummary += `   标记: ${task.flag}\n`;
      if (task.remark) taskSummary += `   备注: ${task.remark}\n`;
      if (task.duration) taskSummary += `   时长: ${task.duration}秒\n`;
      if (task.cost) taskSummary += `   费用: ¥${task.cost}\n`;
      taskSummary += `   创建时间: ${new Date(task.created_at).toLocaleString()}\n\n`;
    });

    taskSummary += `\n💡 提示：使用 get_train_task_detail(taskId='完整的UUID') 获取任务详情`;
    if (totalCount > 10 && !morePage) {
      taskSummary += `\n⚠️ 总共有 ${totalCount} 个任务，默认返回最近 10 个。如需查看更早任务，请使用 list_train_tasks(appId='${appId}', morePage='11-20')`;
    }

    return {
      success: true,
      data: {
        type: 'taskList',
        appId: fullAppId,
        tasks: pagedTasks,
        taskCount: totalCount,
        message: taskSummary,
      },
    };
  } catch (error) {
    console.error('[LIST-TASKS] 异常:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "获取训练任务列表失败",
    };
  }
}

/**
 * 获取训练任务详情
 * 
 * @param step - AutoStep
 * @param planId - 计划ID（未使用）
 * @param context - 上下文
 * @returns 任务详情（完整版）
 */
export async function executeGetTrainTaskDetailTool(
  step: AutoStep,
  _planId: string,
  context?: { userId?: string }
): Promise<AutoToolResult> {
  const params = step.toolParams || step.parameters || {};
  
  // 提取 taskId
  const taskId = params?.taskId || params?.taskid || params?.task_id || params?.id;

  if (!taskId) {
    return {
      success: false,
      error: "缺少 taskId 参数。用法: get_train_task_detail(taskId='xxx')",
    };
  }

  try {
    console.log(`[TASK-DETAIL] 获取训练任务详情: taskId=${taskId}`);

    // 🔥 使用 trainingTaskStorage 而不是直接 fetch
    const { trainingTaskStorage } = await import('@/services/storage');
    const task = await trainingTaskStorage.getById(taskId);

    if (!task) {
      return {
        success: false,
        error: `训练任务不存在: ${taskId}`,
      };
    }

    console.log(`[TASK-DETAIL] 获取成功: taskId=${taskId}, status=${task.status}`);

    // 🔥 构造更友好的返回信息
    let outputSummary = '';
    if (task.stdout_output && task.stdout_output.length > 0) {
      const lines = task.stdout_output.split('\n');
      outputSummary = `\n\n📝 输出日志摘要 (共${lines.length}行):\n`;
      outputSummary += `前10行:\n${lines.slice(0, 10).join('\n')}\n`;
      if (lines.length > 10) {
        outputSummary += `...\n后10行:\n${lines.slice(-10).join('\n')}\n`;
      }
      // 🔥 日志完整性提示
      if (lines.length >= 9000) {
        outputSummary += `\n⚠️ 注意：日志行数接近或超过云端日志服务上限（约10000行），早期轮次的日志可能已被截断。\n`;
        outputSummary += `如需完整日志，请查看 OSS 中的 full_log.txt 文件（如果训练脚本有保存）。\n`;
      }
    }

    const chartsCount = Array.isArray(task.charts_json) ? task.charts_json.length : 0;
    const filesCount = task.files_json && typeof task.files_json === 'object' ? Object.keys(task.files_json).length : 0;

    return {
      success: true,
      data: {
        type: 'taskDetail',
        taskId,
        task: {
          id: task.id,
          app_id: task.app_id,
          status: task.status,
          stdout_output: task.stdout_output,
          charts_json: task.charts_json,
          files_json: task.files_json,
          model_oss_url: task.model_oss_url,
          instance_type: task.instance_type,
          gpu_instance_id: task.gpu_instance_id,
          duration: task.duration,
          cost: task.cost,
          error_message: task.error_message,
          flag: task.flag,
          remark: task.remark,  // 🔥 训练备注
          created_at: task.created_at,
          updated_at: task.updated_at,
        },
        message: `任务状态: ${task.status}${task.flag ? ` | 标记: ${task.flag}` : ''}${task.remark ? ` | 备注: ${task.remark}` : ''}${outputSummary}\n\n📊 图表数量: ${chartsCount}\n📁 文件数量: ${filesCount}`,
      },
    };
  } catch (error) {
    console.error('[TASK-DETAIL] 异常:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "获取训练任务详情失败",
    };
  }
}

/**
 * 🔥 更新训练任务备注（训练阶段总结/评估备注）
 *
 * 让 LLM 或用户为训练任务添加备注，记录主要修改内容、训练结果等
 * 便于后续迭代时快速了解每次训练的重点和结论
 *
 * @param step - AutoStep，需要 taskId + remark 参数
 * @param _planId - 计划ID（未使用）
 * @returns 更新结果
 */
export async function executeUpdateTrainTaskRemarkTool(
  step: AutoStep,
  _planId: string,
): Promise<AutoToolResult> {
  const params = step.toolParams || step.parameters || {};

  const taskId = params?.taskId || params?.taskid || params?.task_id || params?.id;
  const remark = params?.remark || params?.note || params?.comment;

  if (!taskId) {
    return {
      success: false,
      error: "缺少 taskId 参数。用法: update_train_task_remark(taskId='xxx', remark='本次训练主要修改了kl离散度，loss从2.3降到1.8')",
    };
  }
  if (!remark || typeof remark !== 'string') {
    return {
      success: false,
      error: "缺少 remark 参数。用法: update_train_task_remark(taskId='xxx', remark='备注内容（最多200字）')",
    };
  }

  // 🔥 限制备注长度（200字）
  const trimmedRemark = remark.trim().slice(0, 200);

  try {
    const { trainingTaskStorage } = await import('@/services/storage');
    await trainingTaskStorage.update(taskId, { remark: trimmedRemark });

    console.log(`[UPDATE-REMARK] 任务 ${taskId} 备注已更新: ${trimmedRemark}`);

    return {
      success: true,
      data: {
        type: 'remarkUpdated',
        taskId,
        remark: trimmedRemark,
        message: `任务备注已更新: ${trimmedRemark}`,
      },
    };
  } catch (error) {
    console.error('[UPDATE-REMARK] 异常:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "更新训练备注失败",
    };
  }
}

/**
 * 🔥 停止 GPU 训练任务
 *
 * 调用后端 /api/codeexecution/stop 接口，停止云端 ECI 实例并更新任务状态
 *
 * @param step - AutoStep，需要 taskId 参数
 * @param _planId - 计划ID（未使用）
 * @param context - 上下文
 * @returns 停止结果
 */
export async function executeStopGpuTrainTool(
  step: AutoStep,
  _planId: string,
  context?: { userId?: string }
): Promise<AutoToolResult> {
  const params = step.toolParams || step.parameters || {};

  // 🔥 提取 taskId（支持多种参数名）
  const taskId = params?.taskId || params?.taskid || params?.task_id || params?.id;
  // 🔥 提取停止原因（可选，用户手动 kill 时填写）
  const reason = params?.reason || '';

  if (!taskId) {
    return {
      success: false,
      error: "缺少 taskId 参数。用法: stop_gpu_train(taskId='xxx')。可以使用 list_train_tasks 先获取 taskId。",
    };
  }

  try {
    console.log(`[STOP-GPU-TRAIN] 停止训练任务: taskId=${taskId}`);

    // 🔥 先查询任务状态，只有 running/pending 的任务才能停止
    const { trainingTaskStorage } = await import('@/services/storage');
    const task = await trainingTaskStorage.getById(taskId);

    if (!task) {
      return {
        success: false,
        error: `训练任务不存在: ${taskId}`,
      };
    }

    // 🔥 检查任务状态
    if (task.status === 'success' || task.status === 'failed' || task.status === 'stopped') {
      return {
        success: false,
        error: `任务已完成（状态: ${task.status}），无需停止。`,
        data: {
          type: 'taskStatus',
          taskId,
          status: task.status,
        },
      };
    }

    // 🔥 通过 AppExecutionService 统一调用后端停止接口
    const { appExecutionService } = await import('./AppExecutionService');
    const result = await appExecutionService.stopGpuTask(taskId, task.app_id);

    if (result.success) {
      const reasonText = reason ? ` 原因: ${reason}` : '';
      return {
        success: true,
        data: {
          type: 'taskStopped',
          taskId,
          message: `训练任务已停止。云端实例已释放，不再计费。${reasonText}`,
        },
      };
    } else {
      return {
        success: false,
        error: result.error || '停止训练失败',
      };
    }
  } catch (error) {
    console.error('[STOP-GPU-TRAIN] 异常:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "停止训练任务失败",
    };
  }
}

/**
 * 🔥 upsert_project：创建项目 / 更新项目元信息（name、description）
 * - 带 projectId（支持 8 位短 ID）→ 更新模式，只改 name/description
 * - 不带 projectId → 创建模式
 * 项目 description 是 LLM 跨会话理解项目的唯一线索（list_projects 回传），值得单独维护
 */
// 🔥 GPU 训练代码规范提示：随 upsert_project 创建模式的返回下发给 LLM（约 130 字），
//    创建项目后正是 LLM 决定下一步的时机，先讲清规范可大幅减少训练代码返工
//    （产物不存 _OUTPUT_DIR / 不输出结果 JSON / 云端下载数据集走外网卡死，是最高频的三类错误）
const TRAIN_CODE_SPEC_HINT = `⚠️ GPU训练代码三规则：①产物（模型/图表）保存到系统注入的 _OUTPUT_DIR（用 os.path.join 拼路径，勿用相对路径）；②finally 中 print 一行 JSON：{"success":true,"output":"摘要","files":["_OUTPUT_DIR/best.pt"],"charts":["_OUTPUT_DIR/x.png"]}；③云端外网受限，数据集用 list_cloud_files 返回的内网地址下载；完整模板见 use_guide('GPU训练代码约束')`;

export async function executeUpsertProjectTool(
  step: AutoStep,
  _planId: string,
  context?: { userId?: string; conversationId?: string }
): Promise<AutoToolResult> {
  const params = step.toolParams || step.parameters || {};
  const userId = context?.userId;

  if (!userId) {
    return {
      success: false,
      error: "缺少 userId，无法操作项目",
    };
  }

  const projectId = params?.projectId || params?.appId || params?.id;

  // ---------- 更新模式 ----------
  if (projectId) {
    const resolved = { id: '' };
    const resolveError = await resolveProjectId(String(projectId), resolved, userId);
    if (resolveError) {
      return { success: false, error: resolveError };
    }

    // 🔥 基础项目保护：元信息（name/description）是系统资产，不允许 LLM 修改
    // 基础项目内的文件（README/工具等）可正常用 save_project_file/edit_project_file 修改
    if (resolved.id === BASE_PROJECT_ID) {
      return {
        success: false,
        error: "扩展工具项目（base-extensiontool）是系统项目，不允许修改其元信息（name/description）。如需增删工具或修改内容，请用 save_project_file/edit_project_file 操作项目内的文件。",
      };
    }

    const updates: { name?: string; description?: string } = {};
    const newName = params?.name || params?.projectName || params?.project_name;
    const newDesc = params?.description || params?.desc;
    if (newName) updates.name = String(newName);
    if (newDesc) updates.description = String(newDesc);

    if (!updates.name && !updates.description) {
      return {
        success: false,
        error: "更新项目需至少提供 name 或 description（projectId 只用于定位项目）",
      };
    }

    const updated = await desktopAppStorage.update(resolved.id, updates);
    if (!updated) {
      return { success: false, error: "项目不存在或更新失败" };
    }

    const u = updated as any;
    return {
      success: true,
      data: {
        type: 'projectUpdated',
        appId: resolved.id.substring(0, 8),
        name: u.name,
        description: u.description,
        message: `项目 "${u.name}" 元信息已更新`,
      },
    };
  }

  // ---------- 创建模式 ----------
  // 🔥 提取参数（支持多种参数名）
  const name = params?.name || params?.projectName || params?.project_name || `新应用 ${new Date().toLocaleTimeString()}`;
  const description = params?.description || params?.desc || '通过 LLM 工具创建的训练项目';

  try {
    console.log(`[CREATE-PROJECT] 创建项目: name="${name}", userId=${userId}`);

    // 🔥 与 QuickCreateApp / AppDatabaseService.createDesktopApp 逻辑一致
    const newApp = {
      id: uuidv4(),
      name,
      description,
      current_code: '',
      code: '',
      config: {},
      env_vars: {},
      preview: '',
      user_id: userId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const data = await desktopAppStorage.create(newApp);

    if (!data) {
      return {
        success: false,
        error: "创建项目失败：数据库返回空",
      };
    }

    const appId = (data as any).id || (data as any).appId;

    console.log(`[CREATE-PROJECT] 创建成功: appId=${appId}`);

    // 🔥 通知 UI 刷新（与 QuickCreateApp 一致）
    try {
      desktopAppEventService.emitAppCreated(appId, userId, data);
    } catch (e) {
      // 事件通知失败不影响主流程
    }

    return {
      success: true,
      data: {
        type: 'projectCreated',
        appId,
        name,
        description,
        message: `项目 "${name}" 创建成功。appId: ${appId}\n\n现在可以使用 save_project_file(appId='${appId}', filePath='main.py', content='...') 写入代码文件，然后用 run_project_oncloud(projectId='${appId}', instanceType='...') 在云端运行。\n\n${TRAIN_CODE_SPEC_HINT}`,
        nextSteps: {
          saveFile: `save_project_file(appId='${appId}', filePath='main.py', content='...')`,
          listFiles: `list_project_files(appId='${appId}')`,
          runTrain: `run_project_oncloud(projectId='${appId}', instanceType='...')`,
        },
      },
    };
  } catch (error) {
    console.error('[CREATE-PROJECT] 异常:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "创建训练项目失败",
    };
  }
}

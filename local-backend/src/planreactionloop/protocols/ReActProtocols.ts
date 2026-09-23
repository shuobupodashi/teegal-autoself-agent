/**
 * ReAct (Reasoning + Acting) 协议模块
 * 集中管理 ReAct 循环的系统提示词和 prompt 模板
 *
 * 优势：
 * 1. 便于调整和优化提示词效果
 * 2. 支持多套协议切换，增强结果鲁棒性
 * 3. 便于版本管理和 A/B 测试
 * 4. 降低 Service 类的复杂度
 */

export interface ReActProtocolConfig {
  /** 系统提示词 */
  systemPrompt: string;
  /** ReAct 循环提示词模板 */
  reactPromptTemplate: string;
}

/**
 * 标准 ReAct 协议
 *
 * 核心理念：
 * - letMeDo: 简要说明当前行动方案（简洁，用于展示）
 * - tools: 调用工具或完成任务
 * - Observation: 观察执行结果
 * - 循环直到任务完成
 */
const STANDARD_REACT_PROTOCOL: ReActProtocolConfig = {
  systemPrompt: `你的任务: {letAgentTodo}

请你使用 ReAct模式完成任务。

输出格式必须严格遵循JSON:
\`\`\`json
{
  "writeNotes": "记忆关键信息：【已确认】信息1 | 【已确认】信息2 | 【待确认】xxx | 【关键线索】xxx  ",
  "letMeDo": "简要说明action resoning，不透露工具名称",
  "tools": [
    {
      "name": "工具名称",
      "parameters": { "query": "指令内容" }
    }
  ],
  "completeReport": "（可选）任务完成或最后一轮才需总结：关键成果（文件路径/数据/结论）"
}
\`\`\`

任务完成，提前跳出循环:
- 必须总结，且 tools 传空数组 []`,

  // 🔥 排列顺序优化缓存命中率：固定前缀尽可能长
  // staticEnvironment（固定）→ executionHistory（早期round可命中）→ dynamicEnvironment（动态）→ 轮次（动态）
  reactPromptTemplate: `{staticEnvironment}

{executionHistory}

{dynamicEnvironment}

轮次: {roundNumber}/{maxRounds} | 剩余: {remainingRounds}
⚠️请仔细参考执行历史，切勿重复执行操作。
⚠️请遵从systemprompt的格式返回JSON，不要包含其他文本。`,
};

/**
 * 构建环境上下文文本
 */
function buildEnvironmentContext(relevantFiles: any[]): string {
  if (!relevantFiles?.length) {
    return '';
  }
  return `相关文件:\n${relevantFiles.map((f: any) => `- ${f.path}`).join('\n')}\n\n`;
}

/**
 * 🔥 从 writeNotes 中按 Round 拆分出每轮的笔记
 * writeNotes 格式: "【Round 1 笔记】\nxxx\n---\n【Round 2 笔记】\nxxx"
 * 返回 Map<roundNumber, noteContent>
 */
function parseNotesByRound(writeNotes?: string): Map<number, string> {
  const notesMap = new Map<number, string>();
  if (!writeNotes) return notesMap;

  const segments = writeNotes.split(/\n---\n/);
  for (const segment of segments) {
    const match = segment.match(/【Round (\d+) 笔记】\n?([\s\S]*)/);
    if (match) {
      const roundNum = parseInt(match[1], 10);
      const content = match[2].trim();
      if (content) {
        notesMap.set(roundNum, content);
      }
    }
  }
  return notesMap;
}

/**
 * 🔥 构建执行历史文本（按 Round 堆叠，笔记和执行记录内聚，优化缓存命中率）
 * 截断/折叠逻辑统一在此处理：
 * - clearWindow 外的旧轮次折叠为一行摘要（折叠边界按批次移动，两次移动之间历史纯追加，保住缓存前缀）
 * - 窗口内超大结果按单条上限截断
 * - 🔥 动态防护：历史总体积超预算时自动缩小 clearWindow 直到达标；缩到 1 仍超则收紧单条截断兜底
 * @param clearWindow 期望保留完整结果的轮数（从 ReActService.ts 传入）
 * @param writeNotes 累积的工作笔记，按 Round 拆分后与执行记录合并
 * @param maxHistoryChars 执行历史体积预算（字符），超出触发动态压缩
 */
interface ToolResultItem {
  toolName: string;
  parameters: Record<string, any>;
  /** 🔥 真实轮号（executor push 时写入）：折叠行内容只由条目自身决定，历史窗口平移后内容仍不变 */
  roundNumber?: number;
  result: {
    success: boolean;
    data?: any;
    error?: string;
  };
}

/**
 * 🔥 渲染执行历史主体（按指定窗口与单条上限）
 */
function renderRounds(
  toolResults: ToolResultItem[],
  notesByRound: Map<number, string>,
  clearWindow: number,
  maxResultChars: number
): string {
  // 🔥 缓存友好：折叠边界按批次移动（而非每轮 +1），两次移动之间历史纯追加，保住 prompt 前缀缓存
  const BATCH = Math.max(1, Math.floor(clearWindow / 2));
  const overflow = Math.max(0, toolResults.length - clearWindow);
  const startIndex = Math.floor(overflow / BATCH) * BATCH;

  return toolResults
    .map((tool, index) => {
      // 🔥 优先用真实轮号：不用 index 重编号，避免历史窗口平移后折叠行内容每轮变化
      const roundNum = tool.roundNumber ?? index + 1;
      const paramsStr = tool.parameters?.query
        ? `"${tool.parameters.query}"`
        : JSON.stringify(tool.parameters || {}).substring(0, 100);
      let resultData = tool.result?.success
        ? (typeof tool.result.data === 'string' ? tool.result.data : JSON.stringify(tool.result.data))
        : (tool.result?.error || '执行失败');

      // 🔥 超大结果截断（历史里已有笔记机制承载关键信息）
      if (resultData.length > maxResultChars) {
        resultData = resultData.substring(0, maxResultChars) +
          `\n...[结果已截断，原始大小 ${resultData.length} 字符。如需完整内容请重新调用工具]`;
      }

      // 🔥 clearWindow 之外的旧轮次：只留摘要行，防止长会话线性膨胀
      if (index < startIndex) {
        return `--- Round ${roundNum} ---\n工具: ${tool.toolName || 'unknown'} 参数: ${paramsStr}\n结果: (已折叠，详见笔记)\n`;
      }

      // 🔥 将该轮的笔记和执行记录放在一起
      const roundNote = notesByRound.get(roundNum);
      let block = `--- Round ${roundNum} ---\n`;
      if (roundNote) {
        block += `笔记: ${roundNote}\n`;
      }
      block += `工具: ${tool.toolName || 'unknown'}\n` +
        `参数: ${paramsStr}\n` +
        `结果: ${resultData}\n`;
      return block;
    })
    .join('\n');
}

function buildExecutionHistory(
  toolResults: ToolResultItem[],
  clearWindow: number = 1,
  writeNotes?: string,
  maxHistoryChars: number = 60000
): string {
  if (!toolResults.length && !writeNotes) {
    return '';
  }

  // 🔥 按 Round 拆分笔记
  const notesByRound = parseNotesByRound(writeNotes);

  // 🔥 单轮结果截断上限（字符）：防止超大工具返回（大文件全文/超长日志）撑爆 prompt
  const MAX_RESULT_CHARS = 30000;

  // 🔥 动态防护第一级：历史体积超预算时逐级缩小 clearWindow，直到达标或缩到 1
  let effectiveWindow = Math.max(1, clearWindow);
  let compressed = false;
  let body = renderRounds(toolResults, notesByRound, effectiveWindow, MAX_RESULT_CHARS);

  while (body.length > maxHistoryChars && effectiveWindow > 1) {
    effectiveWindow--;
    compressed = true;
    body = renderRounds(toolResults, notesByRound, effectiveWindow, MAX_RESULT_CHARS);
  }

  // 🔥 动态防护第二级：缩到 1 轮仍超预算，说明单条结果过大，收紧单条截断上限兜底
  let effectiveMaxChars = MAX_RESULT_CHARS;
  if (body.length > maxHistoryChars) {
    compressed = true;
    effectiveMaxChars = Math.max(2000, maxHistoryChars - 2000);
    body = renderRounds(toolResults, notesByRound, effectiveWindow, effectiveMaxChars);
  }

  let header = '';
  if (toolResults.length) {
    // 🔥 header 固定写 clearWindow 配置值（不用 effectiveWindow 动态数字），保证 header 每轮完全一致
    header = `执行历史（仅保留最近 ${clearWindow} 轮完整结果，请勤快记录笔记防止重要内容丢失）:\n`;
  }

  // 🔥 防护触发时告知 LLM 原因与建议，引导其缩小读取范围
  // 🔥 放在历史末尾而非 header：即使出现/消失也只在末段打断缓存，不影响前面的前缀命中
  let footer = '';
  if (compressed) {
    footer += `\n⚠️ 注意：近期工具返回内容体积过大（超出预算 ${maxHistoryChars} 字符），已自动将完整结果窗口压缩至 ${effectiveWindow} 轮` +
      (effectiveMaxChars < MAX_RESULT_CHARS ? `，并将单条结果截断上限收紧至 ${effectiveMaxChars} 字符` : '') +
      `。建议缩小读取范围（如分段读取文件、限制返回条数），并勤快记录笔记保存关键信息，避免反复获取大体积内容。`;
  }

  return header + body + footer;
}

export const ReActProtocols = {
  STANDARD: STANDARD_REACT_PROTOCOL,

  /**
   * 获取 ReAct 协议
   * @param mode 协议模式
   */
  get: (mode: 'standard' = 'standard'): ReActProtocolConfig => {
    return mode === 'standard' ? STANDARD_REACT_PROTOCOL : STANDARD_REACT_PROTOCOL;
  },

  /**
   * 构建 ReAct Prompt
   */
  buildPrompt: (params: {
    roundNumber: number;
    maxRounds: number;
    userQuery: string;
    letAgentTodo: string;
    relevantFiles: any[];
    toolResults: Array<{
      toolName: string;
      parameters: Record<string, any>;
      roundNumber?: number;
      result: {
        success: boolean;
        data?: any;
        error?: string;
      };
    }>;
    environmentText?: string;
    /** 🔥 固定部分环境文本（ExecutionTools、UserPC 等，每轮不变） */
    staticEnvironmentText?: string;
    /** 🔥 动态部分环境文本（ImportantObjects、UserInjectMessages 等，可能每轮变化） */
    dynamicEnvironmentText?: string;
    writeNotes?: string;
    clearWindow?: number; // 🔥 保留完整结果的轮数
    maxHistoryChars?: number; // 🔥 执行历史体积预算（字符），超出自动压缩窗口
  }): { systemPrompt: string; userPrompt: string } => {
    const { roundNumber, maxRounds, userQuery, letAgentTodo, relevantFiles, toolResults, environmentText, staticEnvironmentText, dynamicEnvironmentText, writeNotes, clearWindow = 1, maxHistoryChars = 60000 } = params;

    const executionHistory = buildExecutionHistory(toolResults, clearWindow, writeNotes, maxHistoryChars);
    const remainingRounds = maxRounds - roundNumber;

    // 🔥 letAgentTodo 放在 systemPrompt 中，同一 session 内 Round 1→2→3 的 systemPrompt 完全相同，提高缓存命中率
    const systemPrompt = STANDARD_REACT_PROTOCOL.systemPrompt
      .replace('{letAgentTodo}', letAgentTodo);

    // 🔥 环境文本拆分：static 在 executionHistory 前（可缓存），dynamic 在 executionHistory 后
    const staticEnv = staticEnvironmentText || '';
    const dynamicEnv = dynamicEnvironmentText || environmentText || buildEnvironmentContext(relevantFiles);

    const userPrompt = STANDARD_REACT_PROTOCOL.reactPromptTemplate
      .replace('{roundNumber}', String(roundNumber))
      .replace('{maxRounds}', String(maxRounds))
      .replace('{remainingRounds}', String(remainingRounds))
      .replace('{staticEnvironment}', staticEnv)
      .replace('{dynamicEnvironment}', dynamicEnv)
      .replace('{executionHistory}', executionHistory);

    // 🔥 prompt 体积监控：超过 200KB 说明有内容异常膨胀（正常 1-2 万 token ≈ 40-80KB）
    const promptSize = systemPrompt.length + userPrompt.length;
    if (promptSize > 200 * 1024) {
      console.warn(`⚠️ [REACT-PROTOCOL] Round ${roundNumber} prompt 异常庞大: ${(promptSize / 1024).toFixed(0)}KB ` +
        `(staticEnv=${(staticEnv.length / 1024).toFixed(0)}KB dynamicEnv=${(dynamicEnv.length / 1024).toFixed(0)}KB ` +
        `executionHistory=${(executionHistory.length / 1024).toFixed(0)}KB)`);
    }

    return {
      systemPrompt,
      userPrompt,
    };
  },
};

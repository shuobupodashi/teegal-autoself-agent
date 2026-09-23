/**
 * ReActService - ReAct (Reasoning + Acting) 推理服务
 *
 * 职责:
 * - 只负责 LLM 推理：生成 letMeDo 和 Tools
 * - 不执行工具，工具执行由前端完成
 * - 返回每轮的 letMeDo + Tools 给前端
 */

import { ReActProtocols } from './protocols';
import { llmService } from '../utils/LLMService';
import { unifiedModelRegistry } from '../utils/llm/UnifiedModelRegistry';
import { OrganizationSubCategory } from '../utils/llm/types';
import { safeJSONParse } from './utils/JSONParser';
import { tokenUsageService } from '../utils/TokenUsageService';
import { credentialDAO } from '../local-storage/dao/CredentialDAO';

/**
 * 🔥 从凭据表读取 param 型参数（明文存储，后端可直接读 encrypted_value）
 * 没有配置或读取失败时返回默认值
 */
function getParamValue(name: string, userId: string, defaultValue: number): number {
  try {
    const param = credentialDAO.getByName(name, userId);
    if (param && param.type === 'param') {
      const parsed = parseInt(param.encrypted_value, 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
  } catch (error) {
    console.warn(`[REACT-SERVICE] 读取参数 ${name} 失败，使用默认值 ${defaultValue}:`, error);
  }
  return defaultValue;
}

export interface ReActRoundRequest {
  roundNumber: number;
  maxRounds: number;
  sessionId: string;
  userId: string;
  conversationId: string;
  letAgentTodo: string;
  toolResults?: Array<{
    toolName: string;
    parameters: Record<string, any>;
    /** 🔥 真实轮号（executor push 时写入）：后端折叠行按真实轮号渲染，保证内容稳定 */
    roundNumber?: number;
    result: {
      success: boolean;
      data?: any;
      error?: string;
    };
  }>;
  environmentText?: string; // 🔥 环境文本（向后兼容）
  staticEnvironmentText?: string; // 🔥 固定部分环境文本（ExecutionTools、UserPC 等，每轮不变）
  dynamicEnvironmentText?: string; // 🔥 动态部分环境文本（ImportantObjects、UserInjectMessages 等）
  writeNotes?: string; // 🔥 工作笔记，防止遗忘
}

export interface ReActRoundResponse {
  success: boolean;
  roundNumber: number;
  letMeDo: string;
  writeNotes?: string; // 🔥 工作笔记
  completeReport?: string; // 🔥 任务完成总结报告
  tools: Array<{
    name: string;
    parameters: Record<string, any>;
  }>;
  error?: string;
}

export class ReActService {
  private static instance: ReActService;

  static getInstance(): ReActService {
    if (!ReActService.instance) {
      ReActService.instance = new ReActService();
    }
    return ReActService.instance;
  }

  /**
   * 执行单轮 ReAct 推理
   * 返回 letMeDo + Tools，不执行工具
   */
  async executeRound(request: ReActRoundRequest): Promise<ReActRoundResponse> {
    const {
      roundNumber,
      maxRounds,
      sessionId,
      userId,
      letAgentTodo,
      toolResults,
      environmentText,
      staticEnvironmentText,
      dynamicEnvironmentText,
      writeNotes,
    } = request;

    // 从 environmentText 中提取 userQuery（第一行通常是用户查询）
    const userQuery = environmentText?.split('\n')[0]?.replace('用户查询:', '').trim() || '';

    try {
      // 🔥 clearWindow / maxHistoryChars 可从凭据表的 param 型参数读取，默认 6 / 60000
      // 截断/折叠/动态压缩逻辑统一在 ReActProtocols.buildExecutionHistory 中处理
      const CLEAR_WINDOW = getParamValue('clearWindow', userId, 6);
      const MAX_HISTORY_CHARS = getParamValue('maxHistoryChars', userId, 60000);

      // 构建 Prompt
      const { systemPrompt, userPrompt } = ReActProtocols.buildPrompt({
        roundNumber,
        maxRounds,
        userQuery,
        letAgentTodo,
        relevantFiles: [],
        toolResults: toolResults || [],
        environmentText,
        staticEnvironmentText,
        dynamicEnvironmentText,
        writeNotes,
        clearWindow: CLEAR_WINDOW, // 🔥 传入 clearWindow，保持与截断逻辑一致
        maxHistoryChars: MAX_HISTORY_CHARS, // 🔥 历史体积预算，超出自动压缩窗口
      });


      // 🔥 每轮 prompt 体积监控（一行，简洁）：字符按 ~3字符/token 估算
      const promptKB = (systemPrompt.length + userPrompt.length) / 1024;
      console.log(`[REACT-SERVICE] Round ${roundNumber} prompt: ${promptKB.toFixed(1)}KB (~${Math.round((systemPrompt.length + userPrompt.length) / 3)} tokens)`);

      // 调用 LLM
      const llmResponse = await this.callLLM(systemPrompt, userPrompt, userId, sessionId, roundNumber);

      if (!llmResponse.success) {
        return {
          success: false,
          roundNumber,
          letMeDo: '',
          tools: [],
          error: llmResponse.error,
        };
      }

      // 解析 letMeDo、writeNotes、completeReport 和 Tools
      const content = llmResponse.data || '';
      const { letMeDo, writeNotes: parsedWriteNotes, completeReport, tools } = this.parseReActResponse(content);

      // 🔥 如果有 completeReport，在末尾添加提示：report 内容对用户不可见
      const finalCompleteReport = completeReport
        ? `${completeReport}\n\n【注意：报告结果对用户不可见】`
        : completeReport;

      return {
        success: true,
        roundNumber,
        letMeDo,
        writeNotes: parsedWriteNotes,
        completeReport: finalCompleteReport,
        tools,
      };
    } catch (error) {
      console.error('[REACT-SERVICE] 推理失败:', { sessionId, roundNumber, error });

      return {
        success: false,
        roundNumber,
        letMeDo: '',
        tools: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 调用 LLM
   */
  private async callLLM(
    systemPrompt: string,
    userPrompt: string,
    userId?: string,
    sessionId?: string,
    roundNumber?: number
  ): Promise<{ success: boolean; data?: string; error?: string }> {
    try {
      // 获取用户的 LLM 配置
      const resolvedModel = unifiedModelRegistry.getModelForSubCategory(
        OrganizationSubCategory.EXECUTION,
        userId
      );

      if (!resolvedModel) {
        return { success: false, error: '未找到用户 LLM 配置' };
      }

      const response = await llmService.callWithConfig(
        {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.3,
        },
        resolvedModel.callConfig,
        600000  // 🔥 10分钟超时，前沿模型如 K2.6 响应较慢
      );

      if (!response.success) {
        return { success: false, error: response.error };
      }

      if (response.usage) {
        // 🔥 缓存命中率日志
        const cacheHit = response.usage.prompt_cache_hit_tokens || 0;
        const promptTotal = response.usage.prompt_tokens || 0;
        const cacheRate = promptTotal > 0 ? ((cacheHit / promptTotal) * 100).toFixed(1) : '0.0';
        console.log(`[REACT-SERVICE] 缓存命中: ${cacheHit}/${promptTotal} tokens (${cacheRate}%) | Round ${roundNumber} | Session ${sessionId}`);

        tokenUsageService.recordUsage(
          'react',
          resolvedModel.callConfig.model,
          response.usage,
          sessionId,
          roundNumber,
          response.duration
        );
      }

      // 提取 content
      const content = response.content || '';
      return { success: true, data: content };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 解析 ReAct 响应 (JSON 格式)
   */
  private parseReActResponse(content: string): {
    letMeDo: string;
    writeNotes?: string;
    completeReport?: string;
    tools: Array<{ name: string; parameters: Record<string, any> }>;
    parseError?: string;
  } {
    // 提取 JSON
    const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) ||
                      content.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      console.warn('[REACT-SERVICE] 未找到 JSON 响应');
      return {
        letMeDo: 'JSON 解析失败：未找到 JSON 响应，请重新输出正确的 JSON 格式',
        parseError: '未找到 JSON 响应',
        tools: [],
      };
    }

    const jsonStr = jsonMatch[1] || jsonMatch[0];
    const parsed = safeJSONParse(jsonStr);

    if (!parsed) {
      const errorPreview = jsonStr.substring(0, 200);
      console.error('[REACT-SERVICE] JSON 解析失败，原始内容:', errorPreview);
      return {
        letMeDo: `JSON 解析失败，请检查输出格式。上次输出开头: ${errorPreview}`,
        parseError: `JSON 解析失败: ${errorPreview}`,
        tools: [],
      };
    }

    const letMeDo = parsed.letMeDo || '继续执行任务';
    const writeNotes = parsed.writeNotes;
    const completeReport = parsed.completeReport;
    const tools = parsed.tools || [];

    // 验证 tools 格式
    const validTools = tools.filter((t: any) =>
      t && typeof t === 'object' && t.name
    ).map((t: any) => ({
      name: t.name,
      parameters: t.parameters || {},
    }));

    return { letMeDo, writeNotes, completeReport, tools: validTools };
  }
}

// 导出单例
export const reActService = ReActService.getInstance();

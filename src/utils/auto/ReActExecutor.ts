import { AutoStep, AutoToolResult } from './types';
import { ApiClient } from '@/utils/ApiClient';
import { ToolHandler } from './ToolHandler';
import { AbortManager } from '@/utils/abort/AbortManager';
import { EnvironmentBuilder } from './environment/EnvironmentBuilder';
import { ExecuteCommandProgress } from '@/utils/systemtools/executeCommand';
import { importantObjectTracker } from './context/ImportantObjectTracker';
import { getToolDisplayName } from './AvailableToolsRegistry';

/**
 * 截断笔记，只保留最近 N 轮的内容
 * @param notes 完整笔记字符串
 * @param maxRounds 最大保留轮数
 */
function truncateWriteNotes(notes: string, maxRounds: number): string {
  if (!notes) return notes;
  
  // 按轮次分割笔记（格式：【Round X 笔记】）
  const rounds = notes.split('\n---\n');
  
  if (rounds.length <= maxRounds) {
    return notes;
  }
  
  // 只保留最近 maxRounds 轮
  const recentRounds = rounds.slice(-maxRounds);

  // 添加省略提示
  const omittedCount = rounds.length - maxRounds;
  return `[省略了前 ${omittedCount} 轮笔记]\n---\n${recentRounds.join('\n---\n')}`;
}

/**
 * 🔥 缓存友好：不丢弃旧轮条目（丢弃会让后端折叠行整体平移、每轮打断 prompt 前缀缓存），
 * 只把最近 keepFull 轮之外的旧条目结果体裁剪成短摘要，减小请求体积。
 * 后端折叠行只渲染工具名+参数，不渲染结果体，因此裁剪不影响 prompt 渲染。
 * 注意：clearWindow 建议不超过 keepFull，避免"完整渲染区"落进裁剪区导致内容变化。
 */
function trimToolResultsForPayload(toolResults: ToolResult[], keepFull: number): ToolResult[] {
  if (toolResults.length <= keepFull) return toolResults;
  return toolResults.map((t, i) => {
    if (i >= toolResults.length - keepFull) return t;
    const dataStr = t.result?.success
      ? (typeof t.result.data === 'string' ? t.result.data : JSON.stringify(t.result.data ?? ''))
      : (t.result?.error || '');
    const brief = dataStr.length > 200 ? `${dataStr.substring(0, 200)}…[旧轮结果已省略]` : (dataStr || '(旧轮结果已省略)');
    return { ...t, result: { ...t.result, data: brief } };
  });
}

export interface ReActCallbacks {
  onMessage: (callId: string, message: Partial<{
    role: 'user' | 'assistant' | 'system' | 'auto';
    content: string;
    apiRole: 'summarizer' | 'reactor';
    result: string;
    status: 'pending' | 'streaming' | 'completed' | 'failed';
    iconText: string;
    metadata: Record<string, any>;
    sessionId: string;
  }>) => Promise<void>;

  onError?: (error: string) => Promise<void>;
}

export interface ReActExecuteParams {
  sessionId: string;
  userId: string;
  conversationId: string;
  userEmail?: string;
  userQuery: string;
  letAgentTodo: string;
  callbacks: ReActCallbacks;
  abortSignal?: AbortSignal;
}

interface ToolResult {
  toolName: string;
  parameters: Record<string, any>;
  /** 🔥 真实轮号：后端折叠行用真实轮号渲染，保证内容只由条目自身决定 */
  roundNumber?: number;
  result: AutoToolResult;
}

export interface ReActExecutionResult {
  success: boolean;
  executionTrace: string;
  toolResults: ToolResult[];
  completeReport?: string; // 🔥 任务完成总结报告
}

interface ReActRoundResponse {
  success: boolean;
  roundNumber: number;
  letMeDo: string;
  writeNotes?: string;
  completeReport?: string; // 🔥 任务完成总结报告
  tools: Array<{
    name: string;
    parameters: Record<string, any>;
  }>;
  error?: string;
}

/**
 * ReActExecutor - 前端 ReAct 执行器
 */
export class ReActExecutor {
  private static instance: ReActExecutor;
  private abortManager: AbortManager = new AbortManager();
  private abortedConversations: Set<string> = new Set();

  /** 🔥 供长轮询工具检查所属会话是否已被用户中止（如 run_project_oncloud 的 wait 轮询） */
  isConversationAborted(conversationId: string): boolean {
    return this.abortedConversations.has(conversationId);
  }

  // 🔥 连续错误计数器（用于检测连续超时等错误）
  private consecutiveTimeoutErrors: number = 0;
  private readonly MAX_CONSECUTIVE_TIMEOUTS = 3; // 连续 3 次超时后终止

  // 🔥 通用连续推理失败熔断：可恢复错误连续失败 N 轮也终止（防止未知错误模式撞墙到 MAX_ROUNDS）
  private consecutiveRoundErrors: number = 0;
  private readonly MAX_CONSECUTIVE_ROUND_ERRORS = 5;
  
  private executionLog: Array<{
    toolName: string;
    status: 'success' | 'failed';
    timestamp: number;
  }> = [];

  static getInstance(): ReActExecutor {
    if (!ReActExecutor.instance) {
      ReActExecutor.instance = new ReActExecutor();
    }
    return ReActExecutor.instance;
  }

  private async safeOnMessage(
    callbacks: ReActCallbacks,
    callId: string,
    message: Parameters<ReActCallbacks['onMessage']>[1]
  ): Promise<void> {
    try {
      await callbacks.onMessage(callId, message);
    } catch (error) {
      console.error('⚠️ [REACT-EXECUTOR] onMessage 回调异常:', {
        callId,
        apiRole: message.apiRole,
        status: message.status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 执行 ReAct 循环
   */
  async execute(params: ReActExecuteParams): Promise<ReActExecutionResult> {
    const {
      sessionId,
      userId,
      conversationId,
      userEmail,
      userQuery,
      letAgentTodo,
      callbacks,
      abortSignal,
    } = params;

    console.log(`[REACT-EXECUTOR] 开始 ReAct 执行:`, {
      sessionId,
      userQuery: userQuery.substring(0, 50),
    });

    // 🔥 重置执行日志和计数器
    this.executionLog = [];
    this.consecutiveTimeoutErrors = 0;
    this.consecutiveRoundErrors = 0;

    const startTime = Date.now();

    try {
      // 🔥 递归执行
      const toolResults = await this.handleRound({
        sessionId,
        userId,
        conversationId,
        userEmail,
        userQuery,
        letAgentTodo,
        callbacks,
        abortSignal,
        roundNumber: 1,
        toolResults: [],
        writeNotes: '',
      });

      console.log(`[REACT-EXECUTOR] 任务完成:`, { sessionId, toolCount: toolResults.length });

      // 🔥 构建 Mermaid 格式的执行轨迹
      const actualMermaid = this.buildActualMermaid();

      // 🔥 从 toolResults 中提取 completeReport
      const completeTool = toolResults.find(t => t.toolName === 'complete');
      const completeReport = completeTool?.result?.data?.completeReport;

      return {
        success: true,
        executionTrace: actualMermaid,
        toolResults,
        completeReport,
      };

    } catch (error) {
      console.error(`[REACT-EXECUTOR] 执行失败:`, { sessionId, error });

      if (callbacks.onError) {
        await callbacks.onError(error instanceof Error ? error.message : String(error));
      }

      return {
        success: false,
        executionTrace: `执行失败: ${error instanceof Error ? error.message : String(error)}`,
        toolResults: [],
      };
    } finally {
      this.abortedConversations.delete(conversationId);
    }
  }

  /**
   * 🔥 构建 Mermaid 格式的执行轨迹
   * 格式：A[tool1]:::success --> B[tool2]:::failed --> C[tool3]:::success
   */
  private buildActualMermaid(): string {
    if (this.executionLog.length === 0) return '无工具执行';

    const parts: string[] = [];
    const labels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

    for (let i = 0; i < this.executionLog.length; i++) {
      const log = this.executionLog[i];
      const label = labels[i] || `N${i}`;
      parts.push(`${label}[${log.toolName}]:::${log.status}`);
    }

    return parts.join(' --> ');
  }

  /**
   * 🔥 递归处理每一轮
   */
  private async handleRound(params: {
    sessionId: string;
    userId: string;
    conversationId: string;
    userEmail?: string;
    userQuery: string;
    letAgentTodo: string;
    callbacks: ReActCallbacks;
    abortSignal?: AbortSignal;
    roundNumber: number;
    toolResults: ToolResult[];
    writeNotes: string;
  }): Promise<ToolResult[]> {
    const {
      sessionId,
      userId,
      conversationId,
      userEmail,
      userQuery,
      letAgentTodo,
      callbacks,
      abortSignal,
      roundNumber,
      toolResults,
      writeNotes,
    } = params;

    const MAX_ROUNDS = 500;
    const RESULT_WINDOW = 30;   // 🔥 结果体完整保留最近 30 轮（更早的只留短摘要；条目本身不丢弃，保住缓存前缀）
    const NOTES_WINDOW = 50;    // 滑动窗口：只传递最近 50 轮的笔记摘要

    // 🔥 递归深度限制
    if (roundNumber > MAX_ROUNDS) {
      console.log(`[REACT-EXECUTOR] 达到最大轮数限制:`, { sessionId, roundNumber });
      return toolResults;
    }

    // 检查是否被中断
    if (this.abortedConversations.has(conversationId) || abortSignal?.aborted) {
      console.log(`[REACT-EXECUTOR] 执行被中断:`, { sessionId, roundNumber });
      throw new Error('执行被用户中断');
    }

    // 🔥 缓存友好：不丢弃旧轮条目，只裁剪旧轮结果体（见 trimToolResultsForPayload）
    const windowedToolResults = trimToolResultsForPayload(toolResults, RESULT_WINDOW);
    const windowedWriteNotes = truncateWriteNotes(writeNotes, NOTES_WINDOW);

    const callId = `react-${sessionId}-${roundNumber}`;

    // 调用后端获取 letMeDo + Tools（使用窗口化的数据）
    const roundResponse = await this.callReActRound({
      roundNumber,
      maxRounds: MAX_ROUNDS,
      sessionId,
      userId,
      conversationId,
      userQuery,
      letAgentTodo,
      toolResults: windowedToolResults,   // 🔥 窗口化
      writeNotes: windowedWriteNotes,     // 🔥 窗口化
    });

    if (!roundResponse.success) {
      const errorMsg = roundResponse.error || '推理失败';
      
      // 🔥 检测不可恢复的错误（余额不足、认证失败等），终止循环
      const isUnrecoverableError = this.isUnrecoverableError(errorMsg);
      
      if (isUnrecoverableError) {
        console.error(`[REACT-EXECUTOR] Round ${roundNumber} 遇到不可恢复错误，终止执行:`, errorMsg);
        
        // 🔥 触发错误回调
        if (callbacks.onError) {
          await callbacks.onError(errorMsg);
        }
        
        // 🔥 返回失败结果，不再继续循环
        throw new Error(errorMsg);
      }
      
      // 🔥 检测是否是超时错误
      const isTimeoutError = this.isTimeoutError(errorMsg);
      
      if (isTimeoutError) {
        this.consecutiveTimeoutErrors++;
        console.warn(`[REACT-EXECUTOR] Round ${roundNumber} 请求超时，连续超时次数: ${this.consecutiveTimeoutErrors}/${this.MAX_CONSECUTIVE_TIMEOUTS}`);
        
        // 🔥 连续多次超时，终止循环
      if (this.consecutiveTimeoutErrors >= this.MAX_CONSECUTIVE_TIMEOUTS) {
        const timeoutErrorMsg = `连续 ${this.consecutiveTimeoutErrors} 次请求超时，可能是模型负载过高或网络问题，建议稍后重试`;
        console.error(`[REACT-EXECUTOR] 连续超时达到上限，终止执行`);
        
        if (callbacks.onError) {
          await callbacks.onError(timeoutErrorMsg);
        }
        
        throw new Error(timeoutErrorMsg);
      }
      
      // 🔥 推送"模型繁忙"状态提示到前端（固定 callId，避免消息堆积）
      await this.safeOnMessage(callbacks, `react-${sessionId}-busy`, {
        role: 'auto',
        apiRole: 'reactor',
        content: `⏳ 模型繁忙，第 ${roundNumber} 轮请求超时，连续 ${this.consecutiveTimeoutErrors}/${this.MAX_CONSECUTIVE_TIMEOUTS} 次，正在重试...`,
        result: '',
        status: 'streaming',
        iconText: '模型繁忙',
        sessionId,
      });
    } else {
        // 🔥 非超时错误，重置计数器
        this.consecutiveTimeoutErrors = 0;
      }
      
      // 🔥 可恢复错误：把错误作为 toolResult 带入下一轮，让 LLM 自行修正
      console.warn(`[REACT-EXECUTOR] Round ${roundNumber} 推理失败，带入下一轮:`, errorMsg);

      // 🔥 通用熔断：连续多轮推理失败（同类错误反复出现），终止执行
      this.consecutiveRoundErrors++;
      if (this.consecutiveRoundErrors >= this.MAX_CONSECUTIVE_ROUND_ERRORS) {
        const circuitMsg = `连续 ${this.consecutiveRoundErrors} 轮推理失败，已终止执行。请检查模型配置（模型可能已下线或不可用）：${errorMsg.slice(0, 200)}`;
        console.error(`[REACT-EXECUTOR] 连续推理失败达到上限，熔断终止`);

        if (callbacks.onError) {
          await callbacks.onError(circuitMsg);
        }

        throw new Error(circuitMsg);
      }

      toolResults.push({
        toolName: '_round_error',
        parameters: {},
        roundNumber,
        result: {
          success: false,
          error: errorMsg,
        },
      });

      // 继续下一轮
      return this.handleRound({
        sessionId,
        userId,
        conversationId,
        userEmail,
        userQuery,
        letAgentTodo,
        callbacks,
        abortSignal,
        roundNumber: roundNumber + 1,
        toolResults,
        writeNotes: writeNotes + `\n【Round ${roundNumber} 错误】推理失败: ${errorMsg}`,
      });
    }

    const { letMeDo, tools, writeNotes: newWriteNotes, completeReport } = roundResponse;

    // 🔥 推理成功，重置连续超时/连续失败计数器
    this.consecutiveTimeoutErrors = 0;
    this.consecutiveRoundErrors = 0;

    // 🔥 累加 writeNotes：将新的 notes 追加到原有 notes 后面，并添加轮次标签
    let currentWriteNotes = writeNotes || '';
    if (newWriteNotes) {
      const roundNote = `【Round ${roundNumber} 笔记】\n${newWriteNotes}`;
      if (currentWriteNotes) {
        currentWriteNotes = `${currentWriteNotes}\n---\n${roundNote}`;
      } else {
        currentWriteNotes = roundNote;
      }
    }

    // 🔥 判断是否有工具要执行
    const hasTool = tools && tools.length > 0;

    // 🔥 如果没有工具，检查是否需要结束或继续下一轮
    if (!hasTool) {
      // 🔥 如果有 completeReport，任务完成
      if (completeReport) {
        // 🔥 从 completeReport 中提取重要对象（只记录最终结果，避免中间临时文件）
        if (conversationId) {
          importantObjectTracker.extractFromExecutionResult(conversationId, {
            output: completeReport,
            completeReport,
          });
        }

        await this.safeOnMessage(callbacks, callId, {
          role: 'auto',
          apiRole: 'reactor',
          content: letMeDo,
          result: '', // 🔥 result 设为空，让 Summary 决定如何汇报
          status: 'completed',
          iconText: 'Done!',
          sessionId,
        });
        // 🔥 保存 completeReport 到 toolResults 中，供 Summary 使用
        toolResults.push({
          toolName: 'complete',
          parameters: {},
          roundNumber,
          result: {
            success: true,
            data: { completeReport },
          },
        });
        return toolResults;
      }

      // 🔥 没有 tool 也没有 completeReport，继续下一轮
      console.warn(`[REACT-EXECUTOR] Round ${roundNumber} 无 tool 也无 completeReport，继续下一轮`);
      
      toolResults.push({
        toolName: '_no_action',
        parameters: {},
        roundNumber,
        result: {
          success: true,
          data: { message: letMeDo },
        },
      });

      return this.handleRound({
        sessionId,
        userId,
        conversationId,
        userEmail,
        userQuery,
        letAgentTodo,
        callbacks,
        abortSignal,
        roundNumber: roundNumber + 1,
        toolResults,
        writeNotes: currentWriteNotes,
      });
    }

    // 🔥 有工具，执行工具（即使有 completeReport 也要先执行完工具）
    const tool = tools[0];
    const toolName = tool.name;
    const parameters = tool.parameters;

    await this.safeOnMessage(callbacks, callId, {
      role: 'auto',
      apiRole: 'reactor',
      content: letMeDo,
      result: '',
      status: 'streaming',
      iconText: getToolDisplayName(toolName),
      sessionId,
    });

    // 执行工具（支持流式进度更新）
    const toolResult = await this.executeTool({
      callId,
      toolName,
      parameters,
      userId,
      conversationId,
      userEmail,
      sessionId,
      callbacks,
      letMeDo,
    });

    // 🔥 打印工具执行结果
    if (toolResult.success) {
      const resultPreview = toolResult.data
        ? JSON.stringify(toolResult.data).substring(0, 200)
        : (toolResult.error || '(无输出)');
      console.log(`🔧 [REACT-EXECUTOR] Round ${roundNumber} 工具执行成功: ${toolName}`, {
        parameters: JSON.stringify(parameters).substring(0, 200),
        resultPreview,
      });
    } else {
      console.error(`❌ [REACT-EXECUTOR] Round ${roundNumber} 工具执行失败: ${toolName}`, {
        parameters: JSON.stringify(parameters).substring(0, 200),
        error: toolResult.error,
      });
    }

    // Complete 回调：工具执行完成后
    // 🔥 只有 terminal/appExecution 类型的结果才传递详细 resultData
    const resultData = toolResult.data || {};
    const existingType = resultData.type;
    const shouldIncludeDetail = existingType === 'terminal' || existingType === 'appExecution';
    
    await this.safeOnMessage(callbacks, callId, {
      role: 'auto',
      apiRole: 'reactor',
      content: letMeDo,
      result: shouldIncludeDetail
        ? JSON.stringify({
            type: existingType,
            success: toolResult.success,
            ...resultData,
            error: toolResult.error,
          })
        : '',
      status: toolResult.success ? 'completed' : 'failed',
      iconText: `${getToolDisplayName(toolName)} | 完成`,
      sessionId,
    });

    // 🔥 记录到执行日志
    this.executionLog.push({
      toolName,
      status: toolResult.success ? 'success' : 'failed',
      timestamp: Date.now(),
    });

    // 🔥 记录项目活动到 ImportantObjectTracker
    if (toolResult.success && conversationId) {
      const projectId = parameters.projectId || parameters.appId;
      if (projectId) {
        if (toolName === 'run_project_oncloud' || toolName === 'run_gpu_train') {
          importantObjectTracker.recordProjectActivity(conversationId, projectId, 'train');
        } else if (toolName === 'run_project_onlocal') {
          importantObjectTracker.recordProjectActivity(conversationId, projectId, 'local_run');
        } else if (['list_project_files', 'read_project_file', 'save_project_file', 'edit_project_file', 'delete_project_file'].includes(toolName)) {
          importantObjectTracker.recordProjectActivity(conversationId, projectId, 'file_op');
        } else if (toolName === 'create_train_project') {
          importantObjectTracker.recordProjectActivity(conversationId, projectId, 'create');
        }
      }
    }

    // 🔥 递归调用
    return this.handleRound({
      sessionId,
      userId,
      conversationId,
      userEmail,
      userQuery,
      letAgentTodo,
      callbacks,
      abortSignal,
      roundNumber: roundNumber + 1,
      toolResults: [
        ...toolResults,
        {
          toolName,
          parameters,
          roundNumber,
          result: toolResult,
        },
      ],
      writeNotes: currentWriteNotes,
    });
  }

  /**
   * 调用后端 ReAct Round API
   */
  private async callReActRound(params: {
    roundNumber: number;
    maxRounds: number;
    sessionId: string;
    userId: string;
    conversationId: string;
    userQuery: string;
    letAgentTodo: string;
    toolResults: ToolResult[];
    writeNotes?: string;
  }): Promise<ReActRoundResponse> {
    const {
      roundNumber,
      maxRounds,
      sessionId,
      userId,
      conversationId,
      userQuery,
      letAgentTodo,
      toolResults,
      writeNotes,
    } = params;

    try {
      // 🔥 截断逻辑统一在后端 SummaryModule 处理，这里直接传递原始 toolResults

      // 🔥 构建环境文本
      const environmentBuilder = new EnvironmentBuilder({
        enableDynamicAdjustment: true,
      });
      const environmentResult = await environmentBuilder.build(
        {
          role: 'reactor',
          currentRound: roundNumber,
          maxRounds: maxRounds,
        },
        {
          userQuery: userQuery,
        },
        {
          conversationId: conversationId,
        }
      );

      console.log(`🌍 [ReActExecutor] Round ${roundNumber} 环境构建完成:`, {
        strategy: environmentResult.strategy,
        injectedFields: environmentResult.injectedFields,
        textLength: environmentResult.text.length,
      });

      const response = await ApiClient.react.round({
        sessionId,
        userId,
        conversationId,
        letAgentTodo,
        roundNumber,
        maxRounds,
        toolResults: toolResults,
        environmentText: environmentResult.text,
        staticEnvironmentText: environmentResult.staticText,
        dynamicEnvironmentText: environmentResult.dynamicText,
        writeNotes,
      });

      return response;
    } catch (error) {
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
   * 执行工具（支持流式进度更新）
   */
  private async executeTool(params: {
    callId: string;
    toolName: string;
    parameters: Record<string, any>;
    userId: string;
    conversationId: string;
    userEmail?: string;
    sessionId: string;
    callbacks: ReActCallbacks;
    letMeDo: string;
  }): Promise<AutoToolResult> {
    const { callId, toolName, parameters, userId, conversationId, userEmail, sessionId, callbacks, letMeDo } = params;

    const step: AutoStep = {
      id: callId,
      toolName: toolName,
      toolParams: parameters,
      createdAt: new Date(),
    };

    const toolHandler = new ToolHandler(userId, conversationId, userEmail, sessionId);
    
    // 🔥 流式进度回调：实时更新前端显示
    const outputLines: string[] = [];
    const onProgress = (progress: ExecuteCommandProgress) => {
      // 处理不同类型的进度更新
      if (progress.type === 'stdout' || progress.type === 'stderr' || progress.type === 'start') {
        // 收集输出行
        if (progress.data) {
          outputLines.push(progress.data);
        }
        
        // 终端输出实时更新（包括 start 事件也显示为 terminal 类型）
        // 🔥 包含 executionId，使前端可以终止命令
        callbacks.onMessage(callId, {
          role: 'auto',
          apiRole: 'reactor',
          content: letMeDo,
          result: JSON.stringify({
            type: 'terminal',
            status: 'streaming',
            command: parameters.query || parameters.code || toolName,
          outputs: [...outputLines],
          outputType: progress.type,
          executionId: progress.executionId,
        }),
        status: 'streaming',
        iconText: getToolDisplayName(toolName),
        sessionId,
      }).catch(err => {
          console.error('[REACT-EXECUTOR] 流式更新失败:', err);
        });
      }
      // 'complete' 类型不在这里处理，由工具执行完成后的逻辑统一处理
    };
    
    return await toolHandler.executeToolStep(step, sessionId, onProgress);
  }

  /**
   * 🔥 检测不可恢复的错误
   * 
   * 以下错误类型应该终止循环，而不是继续尝试：
   * - 402: 余额不足 (Insufficient Balance)
   * - 401: 认证失败
   * - 403: 权限不足
   * - 模型不可用
   * - API 配额超限
   */
  private isUnrecoverableError(errorMsg: string): boolean {
    // 🔥 检测 HTTP 状态码错误（不含超时，超时让 LLM 决定下一步）
    const unrecoverablePatterns = [
      /402.*Insufficient Balance/i,
      /402.*余额不足/i,
      /Insufficient Balance/i,
      /余额不足/i,
      /401.*Unauthorized/i,
      /401.*认证失败/i,
      /403.*Forbidden/i,
      /403.*权限不足/i,
      /quota.*exceeded/i,
      /配额.*超限/i,
      /rate.*limit.*exceeded/i,
      /速率限制/i,
      /model.*not.*available/i,
      /模型.*不可用/i,
      /API.*调用失败.*402/i,
      /API.*调用失败.*404/i,      // 模型不存在/已下线（如 stealth/ox-alpha 被供应商下架），重试无意义
      /Not found the model/i,      // OpenRouter 模型不存在提示
      // 🔥 注意：请求超时不在这里终止，让 LLM 决定下一步
    ];

    for (const pattern of unrecoverablePatterns) {
      if (pattern.test(errorMsg)) {
        console.log(`[REACT-EXECUTOR] 检测到不可恢复错误: ${pattern.source}`);
        return true;
      }
    }

    return false;
  }

  /**
   * 🔥 检测是否是超时错误
   * 
   * 超时错误不立即终止循环，而是计数，连续多次超时才终止
   */
  private isTimeoutError(errorMsg: string): boolean {
    const timeoutPatterns = [
      /请求超时.*ms/i,             // 请求超时（如 "请求超时 (120000ms)"）
      /timeout.*exceeded/i,        // 超时 exceeded
      /ETIMEDOUT/i,                // 网络超时
      /请求.*超时/i,               // 中文超时提示
    ];

    for (const pattern of timeoutPatterns) {
      if (pattern.test(errorMsg)) {
        return true;
      }
    }

    return false;
  }

  /**
   * 中断执行
   */
  abort(conversationId: string): void {
    console.log('[REACT-EXECUTOR] 中断执行:', { conversationId });
    this.abortedConversations.add(conversationId);
    this.abortManager.abort(conversationId);
  }
}

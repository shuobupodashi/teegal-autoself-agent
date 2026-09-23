/**
 * ECS Async Worker API Client
 * 专门用于与桌面后端（local-backend）通信
 * 与 home-web 的 CloudApiClient 分离
 */

import { getBackendUrl } from "@/config/api";
import { globalAbortManager } from "./abort/AbortManager";

const getEcsBaseUrl = (): string => {
  return getBackendUrl();
};

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: any;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * 🔥 是否使用全局 abort signal
   * 默认 true，如果设为 false 则不受全局 abort 影响
   */
  useGlobalAbort?: boolean;
}

export const ApiRoutes = {
  AUTO: {
    SUMMARY: '/api/auto/summary',
    REACTION_LOOP_SUMMARY: '/api/auto/reactionLoopSummary',
  },

  REACT: {
    ROUND: '/react/round',
  },

  LLM: {
    ALL_MODELS: '/api/llm-models/all',
    PROXY_CALL: '/api/llm-proxy/call',
    PROXY_MODELS: '/api/llm-proxy/models',
  },
  
  CODE_EXECUTION: {
    EXECUTE: '/api/code-execution/execute',
    STOP: '/api/code-execution/stop',
  },
} as const;

// 🔥 获取当前用户 ID
const getCurrentUserId = (): string | null => {
  try {
    // 从 localStorage 获取用户信息
    const userStr = localStorage.getItem('teegal-user');
    if (userStr) {
      const user = JSON.parse(userStr);
      return user.id || null;
    }
  } catch (e) {
    console.error('[ApiClient] 获取用户 ID 失败:', e);
  }
  return null;
};

async function request<T>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<T> {
  const baseUrl = getEcsBaseUrl();
  const url = `${baseUrl}${endpoint}`;

  const {
    method = 'POST',
    body,
    headers = {},
    signal,
    useGlobalAbort = true,
  } = options;

  // 🔥 合并 signal：如果 useGlobalAbort 为 true，使用全局 abort signal
  const finalSignal = useGlobalAbort && !signal
    ? globalAbortManager.getSignal()
    : signal;

  // 🔥 自动添加 userId 到请求体
  const requestBody = body ? { ...body } : undefined;
  const userId = getCurrentUserId();
  if (userId && requestBody && !requestBody.userId) {
    requestBody.userId = userId;
  }

  const requestHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...headers,
  };

  try {
    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: requestBody ? JSON.stringify(requestBody) : undefined,
      signal: finalSignal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.requestFormat) {
          return errorJson as T;
        }
      } catch {}
      throw new Error(`API 调用失败 [${response.status}]: ${errorText}`);
    }

    return response.json();
  } catch (error) {
    // 🔥 处理 AbortError
    if (error instanceof Error && error.name === 'AbortError') {
      console.log('🛑 [ApiClient] 请求被中断');
      throw error;
    }
    throw error;
  }
}

export const ApiClient = {
  request,

  auto: {
    summary: (body: {
      environmentText: string;
      toolResults?: Array<{
        toolName: string;
        parameters: any;
        result: any;
      }>;
      currentDepth?: number;
      maxDepth?: number;
      writeNotes?: string;
      // 🔥 tools 协议参数
      sessionList?: Array<{
        sessionId: string;
        status: string;
        sessionGoal?: string;
        executionFlow?: {
          actual: string; // 🔥 实际执行轨迹
        };
      }>;
      callHistory?: Array<{
        depth: number;
        actions: string[];
        result: string;
      }>;
      sessionContext?: Array<{
        apiRole?: string;
        content?: string;
        result?: string;
      }>;
      agentMessage?: string; // 🔥 Agent 消息
    }, signal?: AbortSignal) => request<any>(ApiRoutes.AUTO.SUMMARY, { body, signal }),

    reactionLoopSummary: (body: {
      currentSessionId?: string;
      sessionList?: Array<{
        sessionId: string;
        status: string;
        sessionGoal?: string;
        executionFlow?: {
          actual: string; // 🔥 实际执行轨迹
        };
      }>;
      currentSessionContext?: Array<{
        apiRole?: string;
        content?: string;
        result?: string;
        statusCode?: number;
      }>;
      agentMessage?: string;
      context?: any;
      environmentText?: string;
      currentDepth?: number;
    }, signal?: AbortSignal) => request<any>(ApiRoutes.AUTO.REACTION_LOOP_SUMMARY, { body, signal }),
  },

  react: {
    round: (body: {
      roundNumber: number;
      maxRounds: number;
      sessionId: string;
      userId: string;
      conversationId: string;
      letAgentTodo: string;
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
      staticEnvironmentText?: string;
      dynamicEnvironmentText?: string;
      writeNotes?: string;
    }) => request<any>(ApiRoutes.REACT.ROUND, { body }),
  },

  llm: {
    getAllModels: () => request<any>(ApiRoutes.LLM.ALL_MODELS, { 
      method: 'GET',
    }),

    call: (body: {
      modelId?: string;
      purpose?: string;
      requestBody: any;
      stream?: boolean;
    }) => request<{
      success: boolean;
      content?: string;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      model?: string;
      error?: string;
    }>(ApiRoutes.LLM.PROXY_CALL, { body }),

    listModels: (userId?: string) => request<{
      success: boolean;
      models?: Array<{ id: string; name: string; modelId: string; provider: string; requestFormat?: string }>;
      error?: string;
    }>(ApiRoutes.LLM.PROXY_MODELS, { method: 'POST', body: userId ? { userId } : {} }),
  },

  codeExecution: {
    execute: (body: {
      code: string;
      gpuNeeded?: boolean;
      gpuInstanceType?: string;
      taskId?: string;
      userId?: string;
      appId?: string;
      config?: any;
    }) => request<any>(ApiRoutes.CODE_EXECUTION.EXECUTE, { 
      body,
    }),

    stop: (body: { taskId: string; appId?: string }) => 
      request<any>(ApiRoutes.CODE_EXECUTION.STOP, { body }),
  },
};

export default ApiClient;

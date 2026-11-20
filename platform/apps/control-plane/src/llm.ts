export type ModelConfig = { baseUrl: string; name: string; apiKey: string };

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolDefinition = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type ModelClient = (input: {
  config: ModelConfig;
  messages: ChatMessage[];
  tools: ToolDefinition[];
}) => Promise<{ message: { role: "assistant"; content: string | null; tool_calls?: ToolCall[] } } | { reason: string }>;

/**
 * OpenAI Chat Completions 兼容客户端。地址按模型配置拼在 baseUrl 后，
 * 兼容 vLLM、DeepSeek 等只实现该协议的服务；失败时返回原因，不重试。
 */
export function createModelClient(timeoutMs = 60_000): ModelClient {
  return async ({ config, messages, tools }) => {
    const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ model: config.name, messages, tools, tool_choice: "auto" }),
        signal: abort.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        const trimmed = detail.slice(0, 200);
        return { reason: `模型调用失败（HTTP ${response.status}）${trimmed ? `：${trimmed}` : ""}` };
      }
      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>;
      };
      const choice = body.choices?.[0]?.message;
      if (!choice) {
        return { reason: "模型响应为空" };
      }
      const toolCalls: ToolCall[] = (choice.tool_calls ?? []).map((call, index) => ({
        id: call.id ?? `call_${index}`,
        type: "function",
        function: { name: call.function?.name ?? "", arguments: call.function?.arguments ?? "{}" },
      }));
      return { message: { role: "assistant", content: choice.content ?? null, tool_calls: toolCalls.length > 0 ? toolCalls : undefined } };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { reason: `模型调用超时（${Math.round(timeoutMs / 1000)} 秒）` };
      }
      return { reason: `模型调用失败：${error instanceof Error ? error.message : String(error)}` };
    } finally {
      clearTimeout(timer);
    }
  };
}

import { AKASHML_BASE, AKASHML_MODEL, requireEnv } from "../shared/env.js";

// Minimal OpenAI-compatible client for AkashML (open-model inference). This is
// the agent brain that replaces the Claude Agent SDK. The orchestrator drives
// the tool-calling loop; this module only performs a single chat completion.

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export async function chat(params: {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  toolChoice?: "auto" | "none";
  maxTokens?: number;
  temperature?: number;
  model?: string;
}): Promise<ChatMessage> {
  const res = await fetch(`${AKASHML_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${requireEnv("AKASHML_API_KEY")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: params.model ?? AKASHML_MODEL,
      messages: params.messages,
      tools: params.tools,
      tool_choice: params.tools ? (params.toolChoice ?? "auto") : undefined,
      max_tokens: params.maxTokens ?? 1024,
      temperature: params.temperature ?? 0.7,
    }),
  });
  if (!res.ok) throw new Error(`akashml ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { choices?: { message: ChatMessage }[] };
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error("akashml: no message in response");
  return msg;
}

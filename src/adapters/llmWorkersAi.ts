// Real LLM client backed by a Cloudflare Workers AI binding (env.AI). No API key: the binding is authorised by the
// Worker's own account. Uses JSON mode (response_format json_schema) when the caller passes a schema.
// Workers AI includes 10,000 free Neurons per day on every plan (see writeup for per-call cost).
import type { LlmClient, LlmCompleteInput, LlmResult } from '../ports';

/** Minimal structural type for the Workers AI binding, so this file needs no generated runtime types. */
export interface WorkersAiBinding {
  run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
}

export const DEFAULT_WORKERS_AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export class WorkersAiLlm implements LlmClient {
  readonly name: string;
  constructor(private cfg: { ai: WorkersAiBinding; model?: string }) { this.name = `workers-ai:${cfg.model || DEFAULT_WORKERS_AI_MODEL}`; }
  get model() { return this.cfg.model || DEFAULT_WORKERS_AI_MODEL; }
  async complete(input: LlmCompleteInput): Promise<LlmResult> {
    const body: Record<string, unknown> = { messages: input.messages, max_tokens: input.maxTokens ?? 300, temperature: 0.2 };
    if (input.jsonSchema) body.response_format = { type: 'json_schema', json_schema: input.jsonSchema };
    const out = (await this.cfg.ai.run(this.model, body)) as { response?: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number } } | null;
    const r = out?.response;
    // In JSON mode Workers AI may hand back an already-parsed object; normalise to text so one validator handles both.
    const text = typeof r === 'string' ? r : r == null ? '' : JSON.stringify(r);
    return { text, usage: out?.usage ? { inputTokens: out.usage.prompt_tokens ?? 0, outputTokens: out.usage.completion_tokens ?? 0 } : undefined };
  }
}

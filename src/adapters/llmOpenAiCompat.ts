// Optional real LLM client (OpenAI-compatible chat completions). Only constructed when LLM_MODE=openai AND a key is set.
import type { LlmClient, LlmMessage } from '../ports';

export class OpenAiCompatLlm implements LlmClient {
  readonly name: string;
  constructor(private cfg: { apiKey: string; baseUrl: string; model: string; fetch?: typeof fetch }) { this.name = `openai-compat:${cfg.model}`; }
  async complete(input: { purpose: string; messages: LlmMessage[]; json?: boolean; maxTokens?: number }): Promise<string> {
    const f = this.cfg.fetch ?? fetch;
    const res = await f(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({ model: this.cfg.model, messages: input.messages, max_tokens: input.maxTokens ?? 300, temperature: 0.2, ...(input.json ? { response_format: { type: 'json_object' } } : {}) }),
    });
    if (!res.ok) throw new Error(`LLM ${res.status}`);
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return j.choices?.[0]?.message?.content ?? '';
  }
}

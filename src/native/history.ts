/**
 * Konversationshistorie der NativeSession im OpenAI-Chat-Format. Hält den
 * System-Prompt fix und trimmt alte Turns nach Zeichenbudget — dabei bleiben
 * `tool_calls`-Nachrichten immer mit ihren `tool`-Antworten zusammen (eine
 * verwaiste tool-Message quittiert die API mit 400).
 */
import type { ChatMessage, LlmToolCall } from "./types.js";

export class ConversationHistory {
  private readonly system: ChatMessage;
  private turns: ChatMessage[] = [];

  constructor(
    systemPrompt: string,
    /** Zeichenbudget über alle Turn-Inhalte (ohne System-Prompt); undefined/"max" = kein Trim. */
    private readonly contextChars?: number | "max",
  ) {
    this.system = { role: "system", content: systemPrompt };
  }

  addUser(text: string): void {
    this.turns.push({ role: "user", content: text });
    this.trim();
  }

  addAssistant(text: string): void {
    this.turns.push({ role: "assistant", content: text });
    this.trim();
  }

  addAssistantToolCalls(content: string, calls: LlmToolCall[]): void {
    this.turns.push({ role: "assistant", content: content || null, tool_calls: calls });
    this.trim();
  }

  addToolResult(id: string, name: string, result: unknown): void {
    this.turns.push({
      role: "tool",
      tool_call_id: id,
      content: JSON.stringify({ name, result }),
    });
    this.trim();
  }

  messages(): ChatMessage[] {
    return [this.system, ...this.turns];
  }

  private charCount(): number {
    let total = 0;
    for (const m of this.turns) {
      total += (m.content ?? "").length;
      for (const c of m.tool_calls ?? []) total += c.function.arguments.length + c.function.name.length;
    }
    return total;
  }

  private trim(): void {
    const budget = this.contextChars;
    if (budget === undefined || budget === "max") return;
    while (this.turns.length > 1 && this.charCount() > budget) {
      const removed = this.turns.shift();
      // Eine assistant-Nachricht mit tool_calls nimmt ihre tool-Antworten mit.
      if (removed?.tool_calls?.length) {
        while (this.turns[0]?.role === "tool") this.turns.shift();
      }
    }
  }
}

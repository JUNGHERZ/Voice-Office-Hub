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

  /**
   * Letzten Assistententurn ersetzen (0.12.0, Sprechuhr). Nötig, weil der Text
   * geschrieben wird, sobald der LLM-Stream durch ist — die Sprachausgabe braucht
   * danach aber noch Sekunden. Ein Barge-in fällt fast immer in genau dieses
   * Fenster: Historie steht, gehört wurde nur ein Teil.
   *
   * Nur ein REINER Assistententurn wird ersetzt. Steht am Ende ein Tool-Aufruf oder
   * ein Tool-Ergebnis, gehört die Kürzung nicht dorthin.
   *
   * @returns false, wenn nichts Passendes am Ende stand.
   */
  replaceLastAssistant(text: string): boolean {
    const last = this.turns[this.turns.length - 1];
    if (!last || last.role !== "assistant" || last.tool_calls) return false;
    last.content = text;
    this.trim();
    return true;
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

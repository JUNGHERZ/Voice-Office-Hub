/**
 * Modell-Eigenheiten, die mehrere LLM-Aufrufer teilen (Deepgram-Settings-Builder,
 * NativeSession-Streaming-Client).
 */

/**
 * GPT-5-Familie (und OpenAI-Reasoning-Modelle o1/o3) akzeptieren nur die Default-Temperatur;
 * ein abweichender Wert führt zu Upstream-400 → "Failed to think" bzw. Request-Fehler.
 */
export function modelSupportsTemperature(model: string): boolean {
  return !/(^|\/)(gpt-5|o1|o3)/i.test(model);
}

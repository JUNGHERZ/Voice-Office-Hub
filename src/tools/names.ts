/**
 * Namen der eingebauten Tools als Leaf-Modul (ohne Imports), damit sowohl das
 * Agent-Schema (Kollisionsprüfung für customTools) als auch die Tool-Schicht
 * dieselbe Quelle nutzen — ohne Import-Zyklen zwischen db/ und tools/.
 */
export const BUILTIN_TOOL_NAMES = ["transfer_call", "end_call", "get_weather"] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

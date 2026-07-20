/**
 * ENV-Pinning für Tests: MUSS als ERSTER Import jeder Testdatei stehen, damit die Werte
 * vor dem Laden von src/config.ts (dotenv-Seiteneffekt) gesetzt sind. dotenv überschreibt
 * bereits gesetzte Variablen nicht — so bleiben die Tests unabhängig von der lokalen .env.
 */
process.env.UNKNOWN_NUMBER_BEHAVIOR = "reject";
process.env.CALL_DEDUP_WINDOW_MS = "4000";
process.env.SUMMARY_ENABLED = "false";
process.env.ECHO_TEST = "false";
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? "error";

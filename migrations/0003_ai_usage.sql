-- Daily Workers AI budget. One row per UTC day: attempted model calls and token usage (for a Neuron estimate).
-- Kept out of resetDemo on purpose, so a demo reset can never reopen the free-tier budget for the day.
CREATE TABLE IF NOT EXISTS ai_usage (
  day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  neurons REAL NOT NULL DEFAULT 0
);

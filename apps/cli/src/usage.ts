export const USAGE = `role-play - text session (M2/M3b)

Usage:
  npm run chat -- [options]

Options:
  --provider <canned|live>  canned is offline demo output; live calls LiveKit Gemma (default: canned)
  --lang <en|fr>            base session language (default: en)
  --locale <bcp47>          locale variant such as en-GB or fr-CA (default: the base lang)
  --persona <id>            manager, peer or client (canned default: manager)
  --personas <ids>          two comma-separated personas, e.g. manager,peer
  --routing <auto|det-persona>
                            auto uses jev-central for live English two-persona
                            sessions when OPENROUTER_API_KEY is set
  --scenario <id>           scenario id (canned default: request-deadline-extension)
  --log-dir <dir>           where session logs are written (default: sessions)
  --session-id <id>         override the per-process session id (tests only)
  --task <id>               record a task id in the log header
  --prompt-date <date>      pinned YYYY-MM-DD for the prompt (default: today)
  --help                    show this help

Live mode requires LIVEKIT_API_KEY and LIVEKIT_API_SECRET in the environment
(npm loads .env), and an explicit --persona or --personas plus --scenario. The
credentials are never printed. The model is fixed to google/gemma-4-31b-it.

English live two-persona sessions route with jev-central (OpenRouter, pinned
typesafe/jev-1.14) when OPENROUTER_API_KEY is set. A Jev timeout or error is
reported on stderr and recorded as a failed policy call, so the turn stays
incomplete rather than becoming a decline. Canned mode and French keep
det-persona.`

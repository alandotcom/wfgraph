---
"@wfgraph/core": minor
---

The MCP endpoint now serves 2025-era clients (protocol revisions `2024-10-07` through `2025-11-25`) statelessly beside `2026-07-28`, so the official SDK's default client connects instead of failing with "Unsupported protocol version". The server now advertises `listChanged: false` for tools and prompts, since a stateless endpoint sends no list-changed notifications.

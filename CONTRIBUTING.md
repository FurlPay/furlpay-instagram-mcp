# Contributing

Use Node.js 24+. Install with `npm ci --ignore-scripts`, then run typecheck, lint, unit and integration tests, and build. Tests must use mocked Meta responses and never require a live account.

Before adding an Instagram operation, verify the current official Meta endpoint, HTTP method, fields, token type, permissions, and account restrictions. Cite the exact reference in the registry and API research. Add a strict schema, bounded result, ownership checks, and a meaningful failure-path test. Do not add generic HTTP forwarding or legacy compatibility routes.

All writes must pass the existing approval and durable execution framework. A timeout after a mutation must not become an automatic retry. Treat captions/comments/messages as untrusted content and keep secrets out of logs and MCP results.

After changing the registry, run `npm run build` and `npm run docs:generate`; commit the generated tool table. Keep the legacy classifications and selected API version accurate.

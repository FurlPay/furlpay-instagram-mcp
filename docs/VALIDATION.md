# Implementation and validation report

Validated locally on **2026-09-28**, Windows, Node **v26.7.0**, npm **11.19.0**. This is a new standalone repository; existing FurlPay payment/revenue code was not edited.

## Current Meta API research

- Product: **Instagram API with Facebook Login**, Graph **v26.0**. Supported accounts: professional **Business** and **Creator** accounts linked to an authorized Facebook Page. Story publishing requires Business eligibility.
- The separate Instagram Login product, its scopes/token lifecycle, deprecated Basic Display API, and current changes were researched before implementation. Only the Facebook Login configuration is implemented here.
- Base permissions: `instagram_basic`, `pages_read_engagement`; OAuth Page discovery adds `pages_show_list`. Feature permissions are `instagram_content_publish`, `instagram_manage_comments`, `instagram_manage_insights`, `instagram_manage_contents`, `instagram_manage_engagement`, `instagram_manage_messages`, `pages_manage_metadata`, and `pages_messaging` where documented. Hashtag research additionally requires Instagram Public Content Access review. Business Manager role arrangements may require additional reviewed ads permissions.
- Old arbitrary user search, follower/following identity graphs, location/geography discovery, home feeds, liked-media feeds, and popular-media endpoints are unavailable. Removed metrics are rejected. Standalone video publishing uses the current Reel flow.

The [official-source research record](RESEARCH.md) contains dated Meta citations. The [API compatibility report](INSTAGRAM_API.md#legacy-27-operations) individually classifies every original endpoint: **11 Replaced, 16 Unavailable**. A replacement describes the current restricted operation, not compatibility with the old URL, account model, or data access. No legacy URL proxy or scraping fallback exists.

## Implemented tools

The [generated tool reference](TOOLS.md) lists **all 33 tools**, their exact paths/methods, required and conditional permissions, input names, validation, error mapping, and read/write status. The registry is also exposed through the official MCP SDK. Two tools inspect local workflow/event state; several tools share documented Meta endpoints. This is not a claim of 33 distinct Instagram endpoints.

| Area | Tools |
| --- | --- |
| Profile and media | `instagram_get_account`, `instagram_get_media`, `instagram_get_media_by_id`, `instagram_get_stories`, `instagram_get_reels` |
| Comments and moderation | `instagram_get_media_comments`, `instagram_get_comment_replies`, `instagram_create_comment`, `instagram_reply_to_comment`, `instagram_delete_comment`, `instagram_hide_comment`, `instagram_delete_media` |
| Engagement | `instagram_like_media`, `instagram_unlike_media` |
| Publishing | `instagram_publish_image`, `instagram_publish_video`, `instagram_publish_reel`, `instagram_publish_carousel`, `instagram_publish_story`, `instagram_get_publishing_limit`, `instagram_get_publish_status` |
| Analytics | `instagram_get_media_insights`, `instagram_get_account_insights` |
| Content research | `instagram_search_hashtag`, `instagram_get_hashtag_media`, `instagram_get_mentions`, `instagram_get_mentioned_comment`, `instagram_get_tagged_media` |
| Messaging and webhooks | `instagram_get_conversations`, `instagram_get_conversation_messages`, `instagram_send_message`, `instagram_subscribe_webhooks`, `instagram_get_webhook_events` |

## Authentication and security

Browser OAuth uses a one-time state and separate browser-binding cookie, confidential code exchange, long-lived Facebook User token exchange, token inspection, Page authorization checks, and professional-account discovery. User/Page credentials and content are encrypted with AES-256-GCM. Tokens are never tool inputs or MCP outputs. Expiration/revocation maps to reauthorization; no unsupported refresh flow is invented. Local disconnect clears credentials and pending authorization; provider revocation is separately documented.

All writes require exact-input, account-bound human approval in a trusted operator CLI. Deletions additionally require explicit schema confirmation. Ownership checks, encrypted durable jobs, no automatic write retries, audit metadata, bounded pagination, request timeouts, safe-read exponential backoff, rate-limit cooldowns, and a circuit breaker protect execution. Raw webhook signatures, account binding, atomic persistence, and deduplication protect the inbox. Instagram message sends require a signed inbound event within 24 hours and a configured human escalation route. See [operations](OPERATIONS.md) for the OS and deployment trust boundaries.

## Exact local results

| Command | Result |
| --- | --- |
| `npm run typecheck` | **PASS**, exit 0, no TypeScript diagnostics |
| `npm run lint` | **PASS**, exit 0, zero ESLint warnings/errors |
| `npm run test:unit` | **PASS**, 56 tests, 56 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo |
| `npm run test:integration` | **PASS**, 22 tests, 22 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo |
| `npm run build` | **PASS**, exit 0; `tsc -p tsconfig.build.json` emitted the production CLI/server into `dist/` |
| `npm run docs:generate` | **PASS**, generated documentation for all 33 tools |
| `npm run docs:check` | **PASS**, exit 0; documentation matches all 33 registered tools |
| `npm audit --omit=dev --json` | **PASS**, exit 0; 0 production vulnerabilities across all severities |
| Compiled stdio smoke check | **PASS**, SDK client launches `dist/cli.js serve`, initializes, lists 33 tools, and receives sanitized `INSTAGRAM_REAUTH_REQUIRED` for an unconnected account |

**Total: 78 tests passed.** Unit tests mock Meta responses; integration tests use the real MCP SDK and local HTTP listeners with mocked upstream responses. Tests cover OAuth/cancellation/replay, token validation and expiry, account/media lookup, pagination, comments, publishing/container resumption/crash ambiguity, insights, signed webhooks, rate limits, permission errors, invalid IDs, ownership, human approval, destructive confirmation, connection changes, bounded response bodies, and inbox retention.

## Deployment validation still required

- No live Meta OAuth grant, real Instagram publication, real account insights, or live webhook subscription was performed. Meta app review, permission eligibility, Page roles, account-specific limits, and media acceptance must be checked with the deployment's account.
- The optional HTTP transport uses a service bearer credential. Claude Desktop stdio is documented; a hosted Claude connector requiring an OAuth 2.1 authorization server needs an independently configured gateway.
- Docker configuration is supplied, but no Docker engine was available for a local image build. The production TypeScript build above was executed successfully.
- The GitHub workflow targets Node 24 on Ubuntu and Windows. The [initial hosted run](https://github.com/FurlPay/furlpay-instagram-mcp/actions/runs/36409044498) ended with **`startup_failure` before any jobs started**. GitHub Actions is enabled and the YAML parses locally, but the API returned no check-run annotations or job logs identifying the cause. Hosted CI is **not validated**; inspect the signed-in run page to resolve this separately from the completed local Node 26 checks.
- This standalone repository has no existing FurlPay admin UI or vault implementation. It provides operator connection/status/approval commands and secret-manager injection points; it does not claim an integration with an unavailable application.

## Files created

```text
.dockerignore
.env.example
.gitattributes
.github/workflows/ci.yml
.gitignore
CONTRIBUTING.md
Dockerfile
LICENSE
README.md
SECURITY.md
docs/INSTAGRAM_API.md
docs/OPERATIONS.md
docs/RESEARCH.md
docs/TOOLS.md
docs/VALIDATION.md
eslint.config.mjs
package-lock.json
package.json
scripts/tool-docs.mjs
src/api.ts
src/cli.ts
src/config.ts
src/errors.ts
src/metrics.ts
src/normalize.ts
src/oauth.ts
src/publishing.ts
src/registry.ts
src/server.ts
src/store.ts
src/types.ts
src/webhooks.ts
test/helpers.ts
test/integration.test.ts
test/oauth.test.ts
test/transport.test.ts
test/unit.test.ts
tsconfig.build.json
tsconfig.json
```

Generated `dist/`, installed dependencies, live environment files, SQLite databases, and credentials are excluded from Git.

## Repository publication

Created and pushed using GitHub CLI to [FurlPay/furlpay-instagram-mcp](https://github.com/FurlPay/furlpay-instagram-mcp), branch `main`. Visibility is **private**: automatic approval review rejected public disclosure because the request did not explicitly select public visibility. The complete implementation was first pushed as commit `844bb021c39c1e9b00e545719ffa15c504311116`; subsequent documentation records the hosted CI result. No npm package or live service was published.

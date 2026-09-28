# Operations and security

## Deployment boundary

Run one connected Instagram account per database/service instance. This is a single-account team service, not a multi-tenant SaaS identity layer. The MCP execution actor is the service identity `mcp_client`; human approvals record the operator's OS username. Use separate instances and service credentials for distinct teams. No payment or revenue service is imported or modified.

The default persistent state is `~/.furlpay-instagram/state.sqlite`. Use a local durable filesystem, not NFS, OneDrive, or another synchronized folder. SQLite WAL and transactional state coordinate the MCP service and approval CLI on the same host. POSIX state directories/files are created with restrictive modes; on Windows, apply an ACL limited to the dedicated service/operator account. Back up the database consistently with SQLite's backup facilities; copying only the main file while WAL is active is insufficient.

## Environment variables

| Variable | Requirement / meaning |
| --- | --- |
| `INSTAGRAM_API_PRODUCT` | `facebook_login`; other products are rejected by this release |
| `META_GRAPH_API_VERSION` | Pinned `v26.0`; capability changes require code/documentation review |
| `META_APP_ID`, `META_APP_SECRET` | Meta app credentials, from the operator's secret manager |
| `TOKEN_ENCRYPTION_KEY` | Required 32-byte key encoded as 64 hexadecimal characters |
| `INSTAGRAM_DATABASE_PATH` | Optional absolute durable state path |
| `INSTAGRAM_REDIRECT_URI` | Exact registered loopback callback; default `http://localhost:8787/oauth/callback` |
| `FACEBOOK_PAGE_ID` | Required when more than one Page is authorized |
| `FACEBOOK_LOGIN_CONFIG_ID` | Optional Facebook Login for Business configuration, using a User token |
| `INSTAGRAM_SCOPES` | Comma-separated documented Facebook permission names; base read permissions mandatory |
| `MCP_HTTP_HOST`, `MCP_HTTP_PORT` | Default `127.0.0.1:8788`; HTTP command only |
| `MCP_HTTP_BEARER_TOKEN` | Independent service secret of at least 32 characters; mandatory for HTTP |
| `MCP_ALLOWED_ORIGIN` | Exact external HTTPS origin, without a trailing slash; controls Host/Origin acceptance |
| `META_WEBHOOK_VERIFY_TOKEN` | Independent challenge-verification secret matching Meta configuration |
| `INSTAGRAM_HUMAN_SUPPORT_URL` | Working HTTPS human escalation channel; mandatory for message sends |

The new repository has no existing FurlPay vault implementation. Inject the encryption key, Meta secret, and MCP credential through the organization's deployment secret manager. Never put Meta access tokens into agent prompts or tool arguments. Do not reuse any of these secrets for another purpose.

## OAuth and token lifecycle

The operator starts `connect`, opens a one-use loopback link, and grants access in Meta. The callback requires a random OAuth state plus a separate HttpOnly, SameSite browser-binding cookie. Only state/binding hashes are stored. State expires after ten minutes and is consumed atomically, preventing callback replay and concurrent code exchange. Meta's server-side confidential-client flow uses the app secret; the connector does not claim that Meta supports an additional PKCE flow here.

Code exchange obtains a short-lived Facebook User token, then the documented `fb_exchange_token` flow obtains its long-lived form. The server inspects app identity, token type, authorizing user, actual scopes, token expiry, and data-access expiry, verifies `/me`, discovers authorized Pages with bounded cursor traversal, and verifies the selected Page's linked Instagram account. It retains the User token for Instagram Graph operations and the Page token for documented Messenger/subscription operations.

Tokens are encrypted using AES-256-GCM with a fresh random IV and authenticated context. Draft inputs, processing state, results, and webhook content are also encrypted. The key remains outside SQLite. Audit records contain operation metadata, not access tokens, app secrets, authorization codes, captions, or message bodies. OAuth responses are bounded and raw credential-bearing URLs/errors are never printed. Configure any external HTTP tracing/proxy tooling to redact token-exchange URLs and Authorization headers.

Facebook User tokens have a finite lifetime (typically about 60 days) and independent data-access restrictions; Page access can be invalidated by revocation or role changes. `status` performs remote validation. Every API call checks local expiry and maps provider revocation to `INSTAGRAM_REAUTH_REQUIRED`. Reconnect before/after expiry as applicable. There is no fabricated refresh token and no use of the separate Instagram Login `ig_refresh_token` endpoint.

`disconnect` deletes the local connection, revokes pending approvals/resumable jobs, removes OAuth state and webhook content, and retains audit/execution history. Remove the app from Facebook Settings → Business Integrations to revoke the provider grant. Local disconnect alone is not remote Meta revocation. Stop in-flight work before connection maintenance: a request already accepted by Meta cannot be recalled.

Losing the encryption key makes stored credentials/content unreadable. Keep it in managed backups, rotate by an operator-controlled decrypt/re-encrypt migration, and do not replace it in place while services are running. A fresh database plus OAuth reconnection is the recovery path when historical content is not needed.

## Read and write authorization

No agent can choose the target account through a tool argument. Media ownership must be returned by Meta as `owner.id` equal to the connected account. Comment mutations additionally resolve `comment.media.id` and check the media owner. Conversation reads verify participants include the authorized Page or Instagram account. Missing ownership fails closed. Hashtag and mention discovery never authorizes modifying somebody else's content.

Every write first generates a local pending action. The operator reviews the tool, account, and exact arguments in a separate TTY, then approves a one-use grant with a 15-minute expiry. Approval is bound to a canonical input hash and account ID. Destructive schemas require an explicit deletion confirmation. There is no MCP tool or HTTP endpoint that approves an action. Grant consumption and job creation are atomic. Reconnection invalidates outstanding approvals; account changes during a call fail before subsequent API requests.

The operator account and database are trusted. Do not give an AI shell/filesystem access to the state directory, secrets, or approval terminal. TTY presence and the typed phrase prevent accidental/piped authorization; they are not passkeys or cryptographic proof that a person is present. A deployment needing stronger separation should place approval behind its own authenticated human interface and maintain these exact action bindings.

## Publishing recovery

Before any Meta mutation, the server records that phase durably. A creation/publish POST is attempted once. GET status checks may retry transient failures. A processing result is resumed by repeating the original tool, arguments, and approval ID after the returned time; each container is checked at most once per minute, for at most five minutes. Carousels store each child ID before creating the parent. An action approved earlier may finish processing after the initial 15-minute approval window because no content can change during that workflow.

Completed actions return cached results when repeated. Errors before a confirmed result leave a failed or unknown record. A running record left by process termination is also non-replayable. Inspect `instagram_get_publish_status`, current account media/permalinks, and Meta's container state before creating a new approved action. The connector deliberately has no automatic “reset unknown job” command. If Meta accepted a write before a crash, restarting must not publish it again.

Quota is queried from `content_publishing_limit`; the code does not hardcode the conflicting numbers in Meta's guide. URL structure is validated, while Meta validates actual JPEG/video format, dimensions, codecs, duration, reachability, and expiry. Use stable public media assets and the documented `is_ai_generated` declaration where applicable.

## HTTP and webhook deployment

The default stdio transport is intended for Claude Desktop and local MCP clients. Optional `/mcp` Streamable HTTP uses a separate bearer service secret, strict Host/Origin validation, a 256 KiB incoming body limit, a ten-request concurrency ceiling, timeouts, and no ambient browser authentication. Each HTTP request gets a stateless SDK transport while the API client/rate limiter is shared within the process. No wildcard CORS is enabled. Remote deployments require an HTTPS reverse proxy that preserves the configured public Host. `/healthz` reports process availability only; use operator `status` to validate the account.

The HTTP mode is not a general OAuth 2.1 authorization server. Clients must support setting its bearer header or connect through a suitable independently operated gateway. Never use a Meta access token as the MCP bearer credential.

For Docker, build `docker build -t furlpay-instagram-mcp .`, mount a durable `/data` volume with service-user permissions, and inject secrets at runtime. Complete OAuth on the same state/key before serving, using a secure port-forward for the loopback bootstrap. Set the external origin and proxy TLS before exposing the HTTP port. The repository's image configuration does not deploy anything automatically.

The Meta callback is `/webhooks/instagram`. The receiver checks `hub.mode`, compares the configured verification secret, and returns the exact numeric challenge. POST requests require `X-Hub-Signature-256` matching the raw bytes under the Meta app secret. No body is trusted before HMAC verification. Account IDs are checked, content is normalized and encrypted, and event IDs deduplicate delivery. The receiver returns success only after a durable transaction; failures return errors for Meta retry. Events older than 30 days are removed on startup and event reads/writes. An idle or stopped database and its backups can retain encrypted data until cleanup; this is not a scheduled physical-erasure guarantee. A Page-object Facebook Messenger message cannot establish an Instagram reply window.

Configure a single-account callback/app arrangement for this single-account service. A shared Meta app receiving several accounts' events requires an authenticated account-routing layer; foreign-account batches are rejected here. There is no generic media-change subscription. Story insight notifications retain identity only; analytics come from the versioned metrics tools.

## Messaging controls

Conversation APIs require their own permissions and Page token. The sender cannot choose an arbitrary Page. Text replies need a verified Instagram inbound event from that recipient within the last 24 hours, checked again after approval. Customer timestamps supplied in a tool input are never accepted. The action includes the operator-configured support URL; the resulting text appends that human escalation link, with a total limit of 1,000 UTF-8 bytes. Configure a route staffed/operated by FurlPay; merely setting a URL does not provide a human support service.

No cold outreach, unsolicited bulk messaging, or automated use of the HUMAN_AGENT exception is implemented. Meta remains authoritative about recipient eligibility, blocked users, account tasks, permission review, and window enforcement.

## Rate limits, errors, and audits

Requests use a conservative shared process rate of two per second with a bounded local queue. GET requests retry at most three total attempts using exponential jitter and Retry-After. Non-idempotent POST/DELETE calls have one attempt. Usage headers and rate errors open a cooldown; repeated transient failures open a circuit. Meta limits vary by endpoint/account and app configuration. A local limiter does not create a larger Meta quota or coordinate independently deployed instances.

| Error | Operator/client action |
| --- | --- |
| `INSTAGRAM_REAUTH_REQUIRED` | Run OAuth connect again; check app/user/data-access validity |
| `INSTAGRAM_PERMISSION_REQUIRED` | Check actual scopes, App Review, Page tasks, and account eligibility |
| `INSTAGRAM_INVALID_INPUT`, `INSTAGRAM_INVALID_DATE_RANGE` | Correct the strict tool arguments/date range |
| `INSTAGRAM_RESOURCE_FORBIDDEN` | Use a resource owned/authorized by the connected account |
| `INSTAGRAM_APPROVAL_REQUIRED` | Review the pending action in the operator CLI |
| `INSTAGRAM_APPROVAL_INVALID` | Arguments/account changed or the grant is unusable; prepare a new action |
| `INSTAGRAM_CONNECTION_CHANGED` | Reconcile work interrupted by connection maintenance |
| `INSTAGRAM_UNSUPPORTED_METRIC` | Use the returned allowed metric list for the media product |
| `INSTAGRAM_RATE_LIMITED`, `INSTAGRAM_CIRCUIT_OPEN` | Back off; do not loop or create duplicate write approvals |
| `INSTAGRAM_INVALID_MEDIA`, `INSTAGRAM_CONTAINER_FAILED` | Check the source URL and current Meta media specifications |
| `INSTAGRAM_CONTAINER_EXPIRED`, `INSTAGRAM_PROCESSING_TIMEOUT` | Inspect the persisted job/container before another publication |
| `INSTAGRAM_PUBLISHING_LIMIT` | Wait for the account quota to reset according to Meta |
| `INSTAGRAM_OUTCOME_UNKNOWN` | Reconcile the external result; no automatic write retry |
| `INSTAGRAM_MESSAGING_WINDOW_CLOSED` | Wait for a new eligible inbound message; do not fabricate a timestamp |
| `INSTAGRAM_HUMAN_SUPPORT_REQUIRED` | Configure and review the real support/escalation route |
| `INSTAGRAM_WEBHOOK_FORBIDDEN` | Check raw-body HMAC, app secret, verify token, and account routing |
| `INSTAGRAM_STORAGE_ERROR` | Check durable storage and the encryption key; preserve state for recovery |

Responses include a local request ID. Audit rows record actor, tool, connected account, operation, resource ID where known, timestamp, result, and request ID. They are stored in SQLite and can be exported to an internal audit system. They are not a tamper-proof ledger against an operator with database access. Approval/job/audit history is retained for reconciliation until an operator applies the organization's retention policy; do not purge ambiguous jobs while publication outcomes are unresolved.

## Troubleshooting

- **OAuth selects no/multiple Pages:** verify Page roles/linkage and set `FACEBOOK_PAGE_ID`; it is checked against the token's authorized Page list.
- **App works only for developers:** complete Standard/Advanced Access, app-mode, business verification, and permission/feature review as required by Meta.
- **No `account_type` or insight value:** the API may not return that field/data. Do not replace unavailable values with guesses or zero.
- **Empty Reel page with a cursor:** Reels are filtered from one `/media` source page. Continue with the supplied cursor if needed.
- **Repeated hashtag cursor:** current top/recent hashtag APIs can reuse cursors. Fetch only pages the caller explicitly requests; do not loop until a cursor changes.
- **Media processing fails:** check actual URL accessibility and validity during the entire processing period, MIME/codec/size constraints, and account restrictions.
- **HTTP returns 403:** ensure the forwarded Host matches the configured origin and any Origin is exactly allowed.
- **All encrypted state fails to open:** restore the matching key. Never overwrite historical state to hide the error.

Before first live use, verify OAuth and granted scopes with an app-role account, test a non-destructive read, check an actual signed webhook, and explicitly approve a controlled test publication/comment. The mock suite cannot prove Meta App Review eligibility or live platform acceptance for a specific deployment.

# Security policy

Report suspected vulnerabilities privately to the FurlPay maintainers through GitHub private vulnerability reporting when available. Do not include live credentials, authorization codes, private messages, or personal account exports in public issues.

The supported release is the current `main` branch / 0.1.x source. See [operations and threat boundaries](docs/OPERATIONS.md). This connector assumes a trusted operator, a protected local database/key, one connected account, and HTTPS for remotely exposed HTTP. The AI client's filesystem/shell access must not include the approval channel or state store.

Tests use fabricated tokens and mocked Meta responses. No account is connected and no content is published by installation, CI, or tests. Production app review and account acceptance remain deployment responsibilities.

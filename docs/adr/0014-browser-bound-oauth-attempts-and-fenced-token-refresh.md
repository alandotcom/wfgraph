# 14. OAuth uses browser-bound attempts and fenced token refresh

Date: 2026-08-24

## Status

Accepted.

## Context

An integration needed to support OAuth without removing manual credentials.
Slack used a pre-registered confidential client. Resend used a client ID metadata
document, mandatory S256 PKCE, 15-minute access tokens, and rotating refresh
tokens. Resend could revoke a grant when a refresh token was reused.

A signed `state` value could carry callback data without a database write, but it
could not prove that the callback returned to the browser that started the flow.
It also left replay prevention dependent on token expiry. A rotating refresh
introduced a separate concurrency problem. Two processes could read one expired
grant, send its refresh token twice, and invalidate both the old token and the
replacement.

Core could have contained provider branches keyed by integration type. That
would have moved Slack and Resend wire formats out of their integration packages
and required a core release for each provider protocol change.

## Decision

The integration definition owned provider behavior: client registration,
authorization URL construction, code exchange, refresh, and revocation. Core
supplied the public origin, callback URL, client metadata URL, and normalized
grant storage. The extension catalog exposed only an OAuth label.

Each authorization start wrote a short-lived attempt containing a hash of opaque
state, the connection ID, an expiry, a browser-binding hash, and an encrypted
payload. The payload held the exact redirect URI and optional PKCE verifier. Core
set the browser binding in a unique `HttpOnly`, `SameSite=Lax` cookie. The callback
deleted the attempt before checking its expiry and binding, so a rejected callback
also consumed the state.

The client metadata route was public because a provider fetched it outside an
operator session. Start, callback, and disconnect routes remained behind the
host authorization predicate. OAuth responses disabled caching and referrer
forwarding. Request logs omitted query values.

Manual configuration remained in the encrypted connection envelope. A versioned
OAuth grant occupied one reserved private key in that envelope. Browser responses
removed the private key. OAuth credential values overrode matching manual values
until disconnect removed the grant.

Refresh coordination used a committed database claim. One caller changed the
connection from `idle` to `refreshing` with a unique claim ID before contacting
the provider. The claim also carried the configuration revision it read. Completion
replaced the access token, refresh token, expiry, and credential mapping in one
fenced update that advanced that revision. Callback exchange and disconnect used
the same claim, so a provider mutation could not pass an active refresh. Only the
owning claim ID and revision could complete, release, or require reauthorization.
A competing caller waited for the stored replacement and made no provider request.
A stale claim became
`reauthorization_required`; it was never stolen.

An unknown outcome after a refresh request required reauthorization. Core did
not retry the possibly consumed refresh token. A successful reconnect or
disconnect replaced the OAuth configuration and reset refresh state atomically.

## Consequences

OAuth start adds one database write and callback adds one atomic consume. The
attempt table provides replay prevention and browser binding across processes.

Refresh availability favors grant safety. A network timeout or process failure
can require an operator to reconnect even when the provider accepted the refresh.
This avoids reusing a rotating token whose status is unknown.

Provider packages can support registered clients or metadata-document clients
without a registry in core. A Worker can resolve integration factories from its
request environment, so provider secrets remain request-scoped.

The connection row carries refresh coordination columns. PostgreSQL and
Hyperdrive share conditional updates, and SQLite performs the same decisions in
`BEGIN IMMEDIATE` transactions.

## Amendment: New connections were deferred until callback completion

Date: 2026-08-24

The original design created a connection row before opening the provider page.
A browser or process that ended before callback completion could leave a row
without a grant, because client cleanup could not run after that browser ended.

Create-mode attempts instead stored the reserved connection ID, name, type, and
manual configuration inside the encrypted attempt payload. Their nullable
`integration_id` held no foreign key target. The callback inserted the reserved
ID only after exchange and credential validation succeeded. Existing-connection
attempts continued to reference and fence their stored row.

This change made cancellation, provider decline, expiry, and browser loss leave
no provisional connection row. If the provider issued a valid grant but storage
or credential validation failed, Core attempted revocation before returning the
failure.

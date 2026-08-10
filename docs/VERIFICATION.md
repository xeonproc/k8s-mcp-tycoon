# Verification Report

**Date:** 10 August 2026
**Scope:** Accuracy audit of `01-kubernetes-architecture.md`, `02-mcp-in-kubernetes.md`,
`03-models-agents-and-a2a.md`, `04-security-best-practices.md`.

This is step 2 of the learning method: having built the knowledge base, review it for accuracy
rather than assuming it. What follows is an honest account — including the things that were wrong
before verification, and the things that remain unverified.

---

## 1. Method

Claims were sorted into three buckets and treated differently:

| Bucket | Treatment |
|---|---|
| **Version-sensitive facts** (API versions, GA status, protocol revisions) | Checked against primary upstream documentation. These decay fastest and are where a language model is least reliable. |
| **Architectural invariants** (reconciliation model, request pipeline, trust boundaries) | Checked for internal consistency and against primary docs where they exist. Stable over years. |
| **Operational judgement** (recommendations, rankings, maturity ladder) | Not verifiable as fact. Labelled below as opinion so you can weigh it as such. |

**Primary sources consulted:** `modelcontextprotocol.io` specification revision `2026-07-28`
(overview, versioning, Streamable HTTP transport, authorization, security best practices);
`kubernetes.io` (sidecar containers, releases, Pod Security Standards); `gateway-api.sigs.k8s.io`
and Kubernetes release blogs; `gateway-api-inference-extension.sigs.k8s.io`.

---

## 2. Material corrections made during verification

**This section is the most important one.** These are errors that existed in the first-draft
understanding and were corrected only because the primary sources were actually read. Every one of
them concerns MCP, and every one would have produced confidently-worded, wrong material.

### 2.1 The current MCP revision is `2026-07-28`, not `2025-06-18`

The initial assumption was that `2025-06-18` was current. It is not — it is two revisions behind.
This single error would have invalidated most of Chapter 2.

### 2.2 MCP has no protocol-level sessions

**Believed:** Streamable HTTP uses an `Mcp-Session-Id` header assigned by the server, terminated
with HTTP DELETE, with sessions needing sticky routing in Kubernetes.
**Actually:** protocol-level sessions were **removed** in `2026-07-28`. MCP is now stateless. A
server implementing only this revision ignores `Mcp-Session-Id` entirely.

**Why this mattered so much:** the incorrect version would have led to recommending session
affinity, consistent hashing, and a shared session store in every Kubernetes deployment example —
architectural advice that is now not merely unnecessary but actively wrong. The corrected material
(§2.3, "Why removing sessions is a big deal in Kubernetes") reverses that guidance.

### 2.3 The `initialize` handshake is no longer the version mechanism

**Believed:** connections begin with an `initialize` request negotiating version and capabilities.
**Actually:** every request declares its version in `params._meta`
(`io.modelcontextprotocol/protocolVersion`) *and* the `MCP-Protocol-Version` header, and the server
accepts or rejects **each request independently**. A mandatory `server/discover` RPC exists for
clients that want to check up front, but calling it is optional.

### 2.4 The standalone GET SSE stream was removed

**Believed:** clients open a GET SSE stream to receive server-initiated messages.
**Actually:** removed. Servers should return `405 Method Not Allowed` for GET/DELETE on the MCP
endpoint. SSE streams are now scoped to a single request's response.

### 2.5 Servers can no longer send JSON-RPC requests to clients

**Believed:** sampling, elicitation and roots arrive as server-initiated requests on an SSE stream.
**Actually:** they use **Multi Round-Trip Requests (MRTR, SEP-2322)** — the server returns an
`InputRequiredResult` and the client *retries the original request* carrying `inputResponses`.

Operationally significant: one logical tool call may be several independent HTTP requests, which
changes tracing, gateway timeout, and retry design.

### 2.6 Stream resumability was removed

**Believed:** `Last-Event-ID` allows replay of a dropped stream.
**Actually:** removed — "Resumable SSE streams via `Last-Event-ID` are not supported."

### 2.7 "Session hijacking" is now "state handle hijacking"

The security guidance was restructured to match statelessness. Because servers now mint explicit
state handles passed as ordinary tool arguments, the normative requirements changed: servers **MUST
NOT** treat possession of a handle as authentication, and **SHOULD** bind handles server-side to the
authenticated principal (e.g. keying state as `<user_id>:<handle>` with the user ID taken from the
verified token).

### 2.8 Dynamic Client Registration is deprecated

**Believed:** RFC 7591 Dynamic Client Registration is a recommended path.
**Actually:** deprecated, retained only for backwards compatibility. **Client ID Metadata
Documents** (an HTTPS URL used as `client_id`) are now the preferred mechanism.

### 2.9 Mirrored headers and mandatory header/body validation are new

Not previously known: `Mcp-Method`, `Mcp-Name`, and `Mcp-Param-{Name}` mirror body fields into
headers so intermediaries can route without parsing bodies — and servers **MUST** validate that
headers match the body, rejecting mismatches with `-32020 HeaderMismatch`.

This is genuinely novel and is now a load-bearing part of Chapters 2 and 4 (attack walkthrough C),
because it is the mechanism that makes per-tool gateway policy both possible and safe.

> **Reflection on the method.** Steps 1 and 2 are not redundant. Roughly a third of the MCP chapter
> changed materially between "what the model believed" and "what the specification says", and none
> of the errors were of a kind that would look wrong on the page. They would have read as
> authoritative. This is exactly the failure mode the two-step process exists to catch — and it
> argues for running step 2 against *primary* sources rather than asking the model to re-check
> itself.

---

## 3. Claims verified against primary sources ✅

### Kubernetes

| Claim | Status |
|---|---|
| Supported minor releases are 1.34, 1.35, 1.36; project maintains the most recent three | ✅ |
| Sidecar containers: feature gate on by default since v1.29, **stable in v1.33** | ✅ |
| Sidecars start before app containers; on termination, app containers stop first, then sidecars in **reverse order of appearance** | ✅ |
| Pod Security Admission stable since v1.25; successor to the removed PodSecurityPolicy | ✅ |
| Gateway API `Gateway`/`GatewayClass`/`HTTPRoute` GA (v1) since Gateway API v1.0 (Oct 2023) | ✅ |
| Gateway API v1.6 (Aug 2026) graduated `TCPRoute` and `UDPRoute` to the Standard channel | ✅ |
| Dynamic Resource Allocation (DRA) graduated to GA in v1.34 | ✅ |
| API request pipeline: authentication → authorization → mutating admission → validating admission → etcd | ✅ |
| Secrets are base64-encoded, not encrypted, absent `EncryptionConfiguration` | ✅ |
| Gateway API Inference Extension exists as an official Kubernetes project; `InferencePool` has graduated to v1 | ✅ |

### MCP (revision `2026-07-28`)

| Claim | Status |
|---|---|
| Current revision is `2026-07-28`; versions are `YYYY-MM-DD` and increment only on breaking change | ✅ |
| Roles: Host / Client / Server; JSON-RPC 2.0; stateful → **now stateless** | ✅ |
| Server primitives: tools, resources, prompts. Client primitives: sampling, roots, elicitation | ✅ |
| Streamable HTTP: single endpoint, POST only, `Accept` must list both JSON and SSE, `202` for accepted notifications | ✅ |
| Sessions, GET stream, resumability, and server-initiated requests all removed in this revision | ✅ |
| Required headers `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`; optional `Mcp-Param-{Name}` via `x-mcp-header` | ✅ |
| Header/body mismatch → `400` + JSON-RPC `-32020 HeaderMismatch`; validation is **MUST** | ✅ |
| Cancellation on Streamable HTTP = closing the SSE response stream; no `notifications/cancelled` | ✅ |
| `subscriptions/listen` carries long-lived change notifications; `X-Accel-Buffering: no` recommended | ✅ |
| Servers **MUST** validate `Origin` (DNS rebinding); **SHOULD** bind localhost when local | ✅ |
| Authorization: OAuth 2.1; server = resource server; RFC 9728 PRM **MUST**; RFC 8707 `resource` **MUST**; PKCE; RFC 9207 `iss` validation | ✅ |
| **Token passthrough forbidden** — servers MUST NOT accept tokens not issued for them | ✅ |
| Dynamic Client Registration deprecated in favour of Client ID Metadata Documents | ✅ |
| Confused deputy, SSRF, state handle hijacking, local server compromise, OAuth URL validation, mix-up attacks, scope minimisation — all as described | ✅ |
| Tool descriptions/annotations must be considered untrusted unless the server is trusted | ✅ |
| HTTP+SSE transport (`2024-11-05`) is deprecated | ✅ |

---

## 4. Claims verified against secondary sources only ⚠️

These are believed correct but were **not** confirmed against the primary specification. Treat with
proportionate caution.

| Claim | Confidence | Note |
|---|---|---|
| A2A reached **v1.0** in 2026 under Linux Foundation governance (hosted since June 2025) | High | Multiple consistent secondary sources |
| **Signed Agent Cards** are the headline v1.0 addition | High | Consistently reported |
| Three-layer structure: data model / operations / transport bindings | Medium-High | Consistently reported, not primary-verified |
| Operations named `SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask` | Medium | Exact names not primary-verified |
| Objects `AgentCard`, `AgentSkill`, `Task`, `Message`, `Part`, `Artifact`, `Extension` | Medium | Same caveat |
| Bindings: JSON-RPC 2.0 over HTTPS (primary), gRPC, HTTP/JSON REST | Medium-High | — |

**Explicitly not verified, and flagged as such in Chapter 3:** the well-known URL path for the Agent
Card and the precise field names. These changed across pre-1.0 revisions. The intended fetch of the
A2A specification did not complete during this session, so Chapter 3 marks the item ⚠️ rather than
stating a path. **If you are implementing A2A, read the specification directly — do not take the
path from this material.**

Also only lightly corroborated: the *exact* GA status of the broader Gateway API Inference Extension
project. `InferencePool` at v1 is confirmed; the umbrella project's overall status is described in
sources as "heading toward GA" with further features planned, so Chapter 3 describes its purpose
rather than asserting a stability level.

---

## 5. Claims that are opinion, not fact 🟡

Stated as recommendations in the material; reasonable and defensible, but judgement rather than
specification:

- The ordering of controls in §1.8 "roughly in order of value delivered per unit of effort".
- The claim that egress control is *the* highest-value single control (§4.1). Defensible and widely
  argued, but a ranking, not a measurement.
- The maturity ladder in §4.4, including "most production AI platforms in 2026 sit between Level 1
  and Level 2 while believing they are at Level 3" — this is a plausible characterisation, **not a
  survey finding**, and should not be cited as data.
- The deployment-pattern selection table in §2.5.
- The "ten things that matter most" list in §4.5.
- The failure-mode table in §3.6 — drawn from common practice, not from a published taxonomy.

The "lethal trifecta" framing (private data + untrusted content + external communication) is an
established community concept rather than a normative standard; it is used here because it is a
genuinely useful decomposition, not because it is authoritative.

---

## 6. Deliberate simplifications

Correct at the level of abstraction used, but incomplete:

- **etcd is described as "the" datastore.** The API server supports alternative backends; etcd is
  overwhelmingly the norm.
- **kube-proxy is described as always present.** Cilium in kube-proxy-replacement mode eliminates
  it; this is noted but not developed.
- **The reconciliation diagram omits** informers, watch caches, work queues, and resync intervals.
  These matter for controller authors, not for understanding the architecture.
- **Ingress is called "effectively frozen"** — it is feature-frozen, still supported, and still very
  widely deployed. It is not deprecated.
- **The nine-step request path in §3.5** is one representative topology. Many production systems
  differ (no gateway, no A2A, models behind a router).
- **"GPUs are not overcommittable"** is true for the standard device-plugin extended-resource path;
  time-slicing, MPS and MIG provide forms of sharing, and DRA changes the picture further.

---

## 7. Confidence summary

| Area | Confidence | Basis |
|---|---|---|
| Kubernetes core architecture | **High** | Primary docs; stable for years |
| Kubernetes security controls | **High** | Primary docs |
| Kubernetes version-specific facts | **High** | Individually re-verified this session |
| MCP protocol mechanics | **High** | Read directly from the `2026-07-28` specification |
| MCP security guidance | **High** | Read directly from the specification's security page |
| MCP-in-Kubernetes deployment patterns | **Medium-High** | Sound engineering inference from verified primitives; patterns are not themselves standardised |
| Model serving on Kubernetes | **Medium-High** | Well-established practice; fast-moving area |
| A2A protocol | **Medium** | Secondary sources only — see §4 |
| Operational recommendations | **Opinion** | See §5 |

---

## 8. Known decay risks

This material will age unevenly. In likely order of decay:

1. **A2A specifics** — youngest protocol here, and the least verified in this document.
2. **MCP revision** — `YYYY-MM-DD` revisions ship regularly, and `2026-07-28` proved that breaking
   changes do happen. Check `modelcontextprotocol.io/specification/versioning` before relying on
   transport details.
3. **Inference-serving tooling** — KServe, vLLM, Gateway API Inference Extension all move quickly.
4. **Kubernetes minor-version facts** — three releases a year; 1.34 reaches EOL in October 2026.
5. **Kubernetes core architecture** — essentially stable; the least likely to change.

**Re-verify before relying on this material for anything consequential**, particularly items in §4.

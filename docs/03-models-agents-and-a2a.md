# 3. Models, Agents, and Agent-to-Agent Communication

> Model-serving and Kubernetes content verified as in Chapter 1. A2A protocol details are stated at
> the level corroborated by public sources in August 2026; items I could **not** confirm against the
> primary specification are explicitly marked ⚠️ and listed in [`VERIFICATION.md`](./VERIFICATION.md).

---

## 3.1 The four interaction types

The whole system is built from exactly four kinds of conversation. Keeping them distinct is most of
the battle.

| # | Interaction | Protocol | Trust posture |
|---|---|---|---|
| 1 | **User → Agent** | HTTP/WebSocket via Gateway | User authenticated; user *input is untrusted* |
| 2 | **Agent → Model** | OpenAI-compatible HTTP / gRPC | Internal; model output is untrusted |
| 3 | **Agent → Tool** | **MCP** | Server may be untrusted; tool output is untrusted |
| 4 | **Agent → Agent** | **A2A** | Peer may be untrusted; peer output is untrusted |

Notice the pattern in the right-hand column: **everything crossing a boundary is untrusted, in both
directions.** The user's prompt is untrusted. The model's output is untrusted. The tool's result is
untrusted. The peer agent's response is untrusted. A design that trusts any of these has a hole.

### MCP vs A2A — the distinction that confuses everyone

- **MCP** connects an agent to **capabilities**: tools, data, prompts. The other end is a *program*
  that does what it is told. Vertical.
- **A2A** connects an agent to **another agent**: an autonomous, opaque peer that reasons, may run
  long tasks, and may refuse. Horizontal.

The practical difference: an MCP tool call is a function invocation with a result. An A2A
interaction is a *task* delegated to something with its own judgement, which may take minutes,
stream updates, need clarification, or fail in ways a function call cannot.

They compose. A single agent is typically an MCP *client* (to its tools), an A2A *client* (to peers
it delegates to), and an A2A *server* (to peers that delegate to it).

---

## 3.2 Serving models in Kubernetes

### Why model servers are unlike normal workloads

| Property | Typical web service | LLM inference server |
|---|---|---|
| Startup | seconds | **minutes** (loading tens of GB of weights) |
| Memory | hundreds of MB | tens/hundreds of GB, mostly GPU VRAM |
| Scaling signal | CPU % | queue depth, tokens/s, time-to-first-token |
| Request duration | milliseconds | seconds to minutes (streaming) |
| Scale-to-zero | cheap | expensive — cold start is brutal |
| Cost per replica | cents/hour | dollars/hour |

Every one of these breaks a default Kubernetes assumption. The mitigations:

- **Startup probes**, not liveness probes, guard the load phase. Give `failureThreshold ×
  periodSeconds` well beyond the worst-case load time. A liveness probe firing during weight loading
  produces an infinite crash loop that looks like a broken image.
- **Readiness probes** must only pass once the model can actually serve — not when the HTTP port
  opens.
- **`Guaranteed` QoS** (requests == limits). A model server evicted under memory pressure costs
  minutes of cold start.
- **Node affinity + tolerations** to land on GPU nodes; taint GPU nodes so nothing else squats on
  them.
- **Model weights**: bake into the image (fast start, huge images, slow rollouts) or pull from
  object storage / a PVC at boot (small images, slower start). A read-only `ReadOnlyMany` PVC or a
  node-local cache is the usual compromise.
- **`terminationGracePeriodSeconds`** long enough to drain in-flight streaming requests.
- **PodDisruptionBudget** so a node drain cannot take all GPU replicas at once.

### The serving stack

- **vLLM / TGI / SGLang** — the inference engines. Continuous batching, paged attention, tensor
  parallelism. Expose an OpenAI-compatible HTTP API, which is the de-facto interface.
- **KServe** — a Kubernetes-native model-serving control plane. `InferenceService` CRD, autoscaling
  (including scale-to-zero), canary rollouts, and a standard inference protocol.
- **Gateway API Inference Extension** — routes on inference-aware signals (KV-cache utilisation,
  queue depth, LoRA adapter affinity) rather than plain round-robin. Round-robin is actively bad for
  LLM serving: it ignores which replica already has the relevant KV cache warm.
- **Ray Serve** — for multi-node model parallelism when a model exceeds one node's GPUs.

### Autoscaling inference

CPU-based HPA is wrong here. A GPU-saturated server can idle its CPU. Scale on:

- queue depth / requests-in-flight (via KEDA or custom metrics),
- time-to-first-token or p95 latency,
- GPU utilisation from DCGM exporter.

And accept that **scale-up is slow**. Keep warm headroom; over-provision relative to a stateless web
service. Scale-to-zero only where a cold start of minutes is genuinely acceptable.

---

## 3.3 Agents as Kubernetes workloads

An agent is a normal Deployment with unusual runtime characteristics: long-lived requests, heavy
fan-out, and an appetite for credentials.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: research-agent, namespace: agents }
spec:
  replicas: 3
  template:
    spec:
      serviceAccountName: research-agent          # its own identity, not "default"
      automountServiceAccountToken: false         # it doesn't call the k8s API
      securityContext:
        runAsNonRoot: true
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: agent
          image: registry.internal/research-agent@sha256:...
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }
          env:
            - name: MODEL_ENDPOINT
              value: http://llama-3-70b.models.svc.cluster.local:8000/v1
            - name: MCP_GATEWAY
              value: https://mcp-gateway.tools.svc.cluster.local
          resources:
            requests: { cpu: 500m, memory: 1Gi }
            limits:   { cpu: "2",  memory: 2Gi }
      terminationGracePeriodSeconds: 120           # let in-flight tasks finish
```

Design notes that matter:

- **Statelessness.** Conversation state belongs in a database or cache, not in pod memory. Otherwise
  you cannot scale, roll, or survive an eviction.
- **Timeouts and budgets everywhere.** An agent loop with no iteration cap and no token budget is a
  runaway cost incident. Cap iterations, wall-clock time, and spend per task.
- **Idempotency.** Retries are inevitable across four network hops. Tool calls that mutate state need
  idempotency keys.
- **One ServiceAccount per agent.** Shared identities destroy your ability to attribute actions —
  which is the entire point of an audit trail.
- **Long-running work goes to a queue**, not to an HTTP request held open for ten minutes.

---

## 3.4 A2A — agent-to-agent

**A2A (Agent2Agent)** is an open protocol for agent interoperability, donated by Google to the
**Linux Foundation** in June 2025 and reaching **v1.0 in 2026**. It defines how independent agents —
built by different teams, on different frameworks, in different languages — discover each other,
delegate tasks, and exchange results.

### Agent Cards

An agent publishes an **Agent Card**: a JSON metadata document describing its identity, skills,
endpoints, supported transports, and authentication requirements. This is the discovery primitive —
the A2A equivalent of `tools/list`.

The headline change in **v1.0 is signed Agent Cards**: a cryptographic signature lets a receiving
agent verify the card was genuinely issued by the domain owner. This directly addresses agent
impersonation — the A2A analogue of MCP's tool-poisoning problem.

> ⚠️ The exact well-known URL path for the Agent Card, and the precise field names, changed across
> pre-1.0 revisions. Confirm against the specification revision you are implementing rather than
> relying on any secondary source (including this one).

### Specification structure (v1.0)

Three layers:

1. **Data model** — `AgentCard`, `AgentSkill`, `Task`, `Message`, `Part`, `Artifact`, `Extension`.
2. **Operations** — `SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`.
3. **Transport bindings** — JSON-RPC 2.0 over HTTPS (primary), gRPC with Protocol Buffers, and
   HTTP/JSON REST.

The layering matters: the same semantics ride over three transports, so a Go agent using gRPC and a
Python agent using JSON-RPC interoperate.

### The task-centric model

A2A is built around a **Task**, not a request/response. A delegating agent sends a `Message`; the
remote agent creates a `Task` with a lifecycle, streams updates, and eventually produces
`Artifact`s. Tasks can be queried (`GetTask`), listed, and cancelled.

This is the right abstraction for work that takes minutes and may need clarification mid-flight —
and it is precisely why A2A is not just "MCP with a different noun".

### A2A in Kubernetes

An A2A-speaking agent is both client and server, so it needs a Service and a route:

```
Agent A Pod ──HTTPS──► Service (agent-b) ──► Agent B Pod
             ▲                                    │
             └──── streaming task updates ────────┘
```

Practical concerns:

- **Streaming** means long-lived connections: set Gateway/mesh idle timeouts above your longest task,
  and remember that (as with MCP) a closed stream may be interpreted as cancellation.
- **Discovery** across namespaces or clusters needs a registry; in-cluster, DNS + a CRD catalogue is
  usually enough.
- **mTLS between agents** via a service mesh gives you cryptographic peer identity independent of
  the application-layer card signature. Use both: the mesh proves *which pod*, the signed card proves
  *which organisation*.
- **NetworkPolicy** should express your delegation graph explicitly. If agent A never delegates to
  agent C, the policy should say so.

---

## 3.5 Putting a full request together

The end-to-end path a user request takes — this is exactly what the simulation animates:

```
 1. User  ──HTTPS──►  Gateway (TLS termination, authN, WAF, rate limit)
 2.                   └──► HTTPRoute ──► Service ──► Agent Pod
 3. Agent ──► Model Service ──► "I should call a tool"
 4. Agent ──MCP tools/call──► MCP Gateway ──► MCP Server
 5. MCP Server ──► token exchange ──► external API   (NOT token passthrough)
 6. Result ──► Agent ──► Model (result is untrusted input)
 7. Agent ──A2A SendMessage──► Peer Agent ──► its own model + tools
 8. Peer returns Task artifacts ──► Agent
 9. Agent ──► Model ──► final answer ──► User
```

Nine steps, five trust boundaries, and at every one the same three questions:

1. **Who is calling?** (authentication — mTLS identity, OAuth token audience, signed agent card)
2. **Are they allowed to do *this specific thing*?** (authorization — RBAC, scopes, per-tool policy)
3. **Is the content they sent me trustworthy?** (it is not — validate, constrain, and never let it
   directly drive a consequential action without approval)

### Where the security controls land

| Step | Primary controls |
|---|---|
| 1–2 Ingress | TLS, OIDC/JWT validation, WAF, rate limit, request size caps |
| 2 Agent pod | PSA `restricted`, own ServiceAccount, no auto-mounted token, resource limits |
| 3 Model call | NetworkPolicy to the model namespace only; input/output guardrails; token budget |
| 4 MCP call | Per-tool authorization, `Mcp-Name`-keyed rate limit, header/body validation, audit log |
| 5 Downstream | **Token exchange, never passthrough**; egress allowlist; block link-local/metadata |
| 6 Tool result | Treat as untrusted; schema-validate; strip/neutralise injected instructions |
| 7 A2A | mTLS peer identity, signed Agent Card verification, delegation-graph NetworkPolicy |
| 9 Response | Output filtering, PII redaction, provenance/citation |

---

## 3.6 Failure modes specific to this architecture

| Failure | Cause | Mitigation |
|---|---|---|
| **Infinite agent loop** | No iteration cap; two agents delegating to each other | Max iterations, delegation depth limit, cycle detection, wall-clock budget |
| **Cost explosion** | Unbounded token spend per task | Per-task and per-tenant token budgets, hard caps enforced at the gateway |
| **Cascading timeout** | User 30s > agent 60s > tool 120s | Timeout budgets must *decrease* down the call chain, not increase |
| **Thundering herd on cold model** | Autoscaler scales from zero under load | Warm pool, queue with backpressure, admission control at the gateway |
| **Context window exhaustion** | Tool results appended unbounded | Truncate/summarise tool output; cap result size at the MCP gateway |
| **Retry storm** | Every layer retries independently | Retry budgets, exponential backoff with jitter, circuit breakers |
| **Silent tool failure** | Tool returns an error string the model treats as data | Structured errors; distinguish tool failure from tool result in the transcript |
| **Poisoned memory** | Injected instruction persisted into long-term agent memory | Treat memory writes as privileged; validate before persisting |

---

**Next:** [4. Security Best Practices — Consolidated →](./04-security-best-practices.md)

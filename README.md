# K8s · MCP Tycoon

An interactive, low-poly simulation of **Kubernetes architecture**, **MCP servers deployed inside
it**, **models and agent-to-agent flows**, and the **security best practice at every layer** — built
as a RollerCoaster-Tycoon-style park you can orbit, pause and step through.

**▶ Live: https://xeonproc.github.io/k8s-mcp-tycoon/**

---

## Why it looks like this

It follows the [build → verify → simulate](https://laurentiugabriel.github.io/blog/articles/how-i-use-llms-to-learn/)
learning method:

| Step | Output |
|---|---|
| **1. Build** the foundational knowledge | [`docs/01`](docs/01-kubernetes-architecture.md) · [`02`](docs/02-mcp-in-kubernetes.md) · [`03`](docs/03-models-agents-and-a2a.md) · [`04`](docs/04-security-best-practices.md) |
| **2. Verify** it against primary sources | [`docs/VERIFICATION.md`](docs/VERIFICATION.md) |
| **3. Simulate** it so the architecture is legible | this app |

Step 2 is not a formality. Roughly a third of the MCP chapter was **wrong** in the first draft —
protocol sessions, the `initialize` handshake and SSE resumability were all removed in MCP revision
`2026-07-28`, and the pre-verification material confidently recommended session affinity and sticky
routing that are now actively wrong. The verification report documents every correction, along with
what is only secondary-sourced (A2A) and what is opinion rather than fact.

## What you can do

- **Nine scenarios** — five showing how it works (ingress, inference, MCP tool call, A2A delegation,
  control-plane reconciliation) and four attack paths (prompt-injection exfiltration, token
  passthrough, header/body mismatch, pod compromise → lateral movement).
- **Full transport control** — play/pause, step forward and back, restart, 0.25×–3× speed, loop.
  Jump to any step by clicking it in the list.
- **Click any building** to read that district's architecture notes and best practices.
- **Seven districts** — Gate, Routing Plaza, Agent Quarter, MCP Tool Bazaar, Model Foundry, Control
  Plane Hill, Vault & Egress.

### Controls

| Input | Action |
|---|---|
| Drag / one-finger drag | Orbit |
| Scroll / pinch | Zoom |
| Shift-drag or right-drag | Pan |
| Click a building | Inspect its district |
| `Space` | Play / pause |
| `←` `→` | Previous / next step |
| `R` | Restart scenario |

Works on phones: the panel collapses to a sheet, the field of view widens in portrait, and all
gestures are touch-native.

## Running locally

Everything is static and dependency-free — Three.js r169 is vendored in `vendor/`. Because it uses
ES modules, it needs a server rather than `file://`:

```bash
python3 -m http.server 8000    # or: npx serve
```

Then open <http://localhost:8000>.

## Layout

```
index.html            shell + panel markup
css/styles.css        layout, responsive breakpoints at 900px / 420px
js/content.js         the curriculum — nodes, districts, flows, best practices
js/world.js           low-poly park geometry
js/sim.js             flow engine (DOM-free; emits events)
js/main.js            renderer, camera rig, picking, all DOM wiring
docs/                 the knowledge base + verification report
```

`content.js` is the file to edit to add a scenario or change what is taught; the world and the flow
engine are generic.

## Accuracy

Current as of **August 2026**: Kubernetes 1.34–1.36, MCP revision `2026-07-28`, Gateway API v1.6,
A2A v1.0. This material will age unevenly — see
[the decay-risk section](docs/VERIFICATION.md#8-known-decay-risks) before relying on it. A2A details
are secondary-sourced only; read the specification directly if you are implementing it.

## Licence

MIT for the code. Three.js is MIT, © Three.js Authors.

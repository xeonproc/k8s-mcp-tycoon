# 1. Kubernetes Architecture — Foundations

> Verified against Kubernetes v1.34–v1.36 (the three supported minor releases as of August 2026).
> Every claim in this document is checked in [`VERIFICATION.md`](./VERIFICATION.md).

---

## 1.1 The one-sentence model

Kubernetes is a **reconciliation engine**: you declare desired state in an API, and a set of
controllers continuously watch actual state and take action to close the gap. Everything else —
pods, services, ingress, operators — is a consequence of that single idea.

There is no "run this container" command in the architecture. There is only "record that this
container *should* exist" followed by controllers noticing and acting.

```
     desired state                 observed state
   (what you declared)          (what is actually true)
          │                              │
          └────────► controller ◄────────┘
                         │
                         ▼
                   take action to converge
```

This is why Kubernetes is resilient and also why it is *eventually* consistent — nothing happens
instantly, and every mechanism below is a variation on watch → diff → act.

---

## 1.2 The control plane

The control plane is the cluster's brain. In production it runs on dedicated nodes (typically 3 or
5 for quorum), separated from workload nodes.

### kube-apiserver

The **only** component that talks to etcd. Everything else — kubelet, scheduler, controllers,
`kubectl`, operators, your agents — goes through the API server. It is the single front door.

Every request passes through four stages, in order:

1. **Authentication** — who are you? (client certs, bearer tokens, OIDC, ServiceAccount tokens,
   webhook). Kubernetes has no user database; identity is always external or certificate-based.
2. **Authorization** — are you allowed? (RBAC is the standard mode; also Node, ABAC, Webhook).
3. **Admission control** — should this specific object be allowed, and should it be modified?
   Split into *mutating* admission (can change the object) then *validating* admission (can only
   accept/reject). This is where policy engines plug in.
4. **Persistence** — validated object is written to etcd.

> **Why this ordering matters for security:** admission control is the last gate before an object
> becomes real. It is where you enforce "no privileged containers", "images must be signed", "every
> pod must have resource limits". RBAC answers *"can this identity write Pods?"*; admission answers
> *"is this particular Pod acceptable?"* You need both.

### etcd

A distributed, strongly-consistent key-value store (Raft consensus). It holds **all** cluster
state, including Secrets. Losing etcd means losing the cluster.

- Requires an odd number of members (3 or 5) for quorum.
- Should be encrypted at rest (`EncryptionConfiguration`) — by default, Secrets are stored
  base64-encoded, which is **encoding, not encryption**.
- Should be on a private network reachable only by the API server, with mutual TLS.

### kube-scheduler

Watches for Pods with no `nodeName` assigned and picks a node. Two phases:

1. **Filtering** — eliminate nodes that cannot run the pod (insufficient CPU/memory/GPU, taints not
   tolerated, node selectors/affinity unmatched, volume topology conflicts).
2. **Scoring** — rank the survivors (spread across zones, image locality, least-allocated, etc.).

The scheduler then *writes the binding back to the API server*. It does not contact the node. This
is the reconciliation pattern again: the scheduler's only output is a state change in the API.

### kube-controller-manager

A single binary running many controllers as goroutines: Deployment, ReplicaSet, StatefulSet, Job,
Node lifecycle, ServiceAccount, endpoint/EndpointSlice, and more. Each runs the same loop: watch
resources → compare desired to actual → act.

Example chain for a Deployment:

```
Deployment controller ──creates──► ReplicaSet
ReplicaSet controller ──creates──► Pods (unscheduled)
Scheduler             ──binds────► Pods to Nodes
kubelet (on node)     ──starts───► containers
```

Four independent controllers, each doing one small job, none aware of the others. That decoupling
*is* the architecture.

### cloud-controller-manager

Isolates cloud-provider-specific logic (provisioning load balancers, attaching disks, node
lifecycle from the cloud API). Exists so the core is vendor-neutral.

---

## 1.3 The data plane (worker nodes)

### kubelet

The node agent. It:

- Watches the API server for Pods bound to *its* node.
- Instructs the container runtime (via **CRI**, the Container Runtime Interface — containerd or
  CRI-O) to pull images and start containers.
- Runs **probes**: `liveness` (restart if failing), `readiness` (remove from Service endpoints if
  failing), `startup` (protect slow-booting apps from the liveness probe).
- Reports node and pod status back to the API server.
- Mounts volumes, including projected ServiceAccount tokens.

The kubelet is deliberately dumb about the cluster. It only knows its own node's pods.

> **Critical for model/agent workloads:** readiness vs liveness is the single most common source of
> outages. A model server loading a 30 GB checkpoint needs a **startup probe** with a generous
> `failureThreshold`; otherwise the liveness probe kills it mid-load and it never starts, forever.

### kube-proxy and the Service abstraction

`kube-proxy` programs node-level packet rules (iptables or, preferably, **IPVS** at scale) so that
traffic to a Service's stable virtual IP is load-balanced to the current healthy Pod IPs. Many
modern CNIs (Cilium in eBPF mode) replace kube-proxy entirely.

Pods are mortal and their IPs change. **Services are the stable identity.**

Service types:

| Type | What it does |
|---|---|
| `ClusterIP` | Stable virtual IP reachable only inside the cluster (the default). |
| `NodePort` | Opens the same high port on every node. Blunt; rarely right in production. |
| `LoadBalancer` | Asks the cloud provider for an external LB. |
| `ExternalName` | A CNAME. No proxying at all. |
| *Headless* (`clusterIP: None`) | No virtual IP; DNS returns Pod IPs directly. Used by StatefulSets and by clients that do their own load balancing. |

**EndpointSlices** (which replaced the older `Endpoints` object at scale) hold the actual list of
ready backend IPs. The endpoint controller keeps them in sync with pod readiness.

### CNI — the network model

Kubernetes mandates a flat network model with three rules:

1. Every Pod gets its own IP address.
2. Pods can reach all other Pods **without NAT**.
3. Agents on a node can reach all Pods on that node.

The CNI plugin (Calico, Cilium, AWS VPC CNI, …) implements this. Crucially: **the default is that
everything can talk to everything.** Network segmentation is opt-in, via NetworkPolicy — which is
enforced by the CNI, not by Kubernetes itself. A cluster running a CNI without NetworkPolicy
support will silently accept your NetworkPolicy objects and enforce nothing.

### Ingress and Gateway API

- **Ingress** — the original L7 HTTP routing API. Simple, but extension required vendor-specific
  annotations, which made it non-portable. Now effectively frozen.
- **Gateway API** — the successor. Role-oriented and portable:
  - `GatewayClass` — the infrastructure type (managed by the provider).
  - `Gateway` — an actual listener with ports/TLS (managed by the platform/cluster operator).
  - `HTTPRoute` / `GRPCRoute` / `TCPRoute` / `UDPRoute` — routing rules (managed by app teams).

  This separation is the point: an app team can attach a route without holding permission to edit
  TLS config or listeners. `Gateway`, `GatewayClass` and `HTTPRoute` have been GA (v1) since
  Gateway API v1.0; `TCPRoute` and `UDPRoute` reached the Standard channel in v1.6 (August 2026).

---

## 1.4 Workload objects

| Object | Use for |
|---|---|
| `Pod` | The atom: one or more containers sharing a network namespace and volumes. Rarely created directly. |
| `Deployment` | Stateless, interchangeable replicas. Rolling updates, rollback. |
| `StatefulSet` | Stable network identity (`pod-0`, `pod-1`) and stable per-pod storage. Ordered rollout. |
| `DaemonSet` | Exactly one pod per (matching) node — log shippers, CNI agents, node exporters. |
| `Job` / `CronJob` | Run to completion / on a schedule. Batch inference, evals, fine-tuning. |

**Sidecars:** a container in the same Pod as the main app, sharing its network namespace and
lifecycle. Since v1.29 (stable in v1.33) Kubernetes has *native* sidecar support via an init
container with `restartPolicy: Always` — this guarantees the sidecar starts **before** the main
container and is terminated **after** it. That ordering guarantee is exactly what a service-mesh
proxy or a co-located MCP server needs, and it is why the old "just add another container" approach
was fragile.

**Pods share a network namespace**, so containers within one Pod reach each other over
`localhost`. This is the mechanism that makes the sidecar MCP server pattern (Chapter 2) work.

---

## 1.5 Scheduling controls

- **Requests** — what the scheduler reserves. Drives placement.
- **Limits** — the hard ceiling the runtime enforces. Exceeding a memory limit means **OOMKill**;
  exceeding a CPU limit means throttling, not death.
- **QoS classes**, derived automatically:
  - `Guaranteed` — requests == limits for every container. Evicted last.
  - `Burstable` — requests set, lower than limits. Evicted second.
  - `BestEffort` — nothing set. **Evicted first.** Never acceptable for a model server.
- **Taints & tolerations** — a taint repels pods from a node; a toleration lets a specific pod
  ignore it. This is how you reserve expensive GPU nodes for workloads that actually need them.
- **Affinity / anti-affinity** — attract or repel pods relative to other pods or node labels.
  Anti-affinity across zones is how you survive a zone failure.
- **Topology spread constraints** — the modern, more precise way to express "spread my replicas
  evenly across zones/nodes".
- **PodDisruptionBudget** — a floor on availability during *voluntary* disruptions (node drains,
  cluster upgrades). Without one, a rolling node upgrade can take every replica down at once.

### GPUs and accelerators

GPUs are exposed as **extended resources** (`nvidia.com/gpu: 1`) surfaced by a device plugin
(typically installed by the NVIDIA GPU Operator). Extended resources are **integers and are not
overcommittable** — request equals limit, always. **Dynamic Resource Allocation (DRA)**, which
graduated to GA in v1.34, is the more expressive successor for describing and sharing accelerators.

---

## 1.6 Configuration, identity and storage

- **ConfigMap** — non-sensitive config, as env vars or mounted files.
- **Secret** — sensitive data. Base64-encoded, **not encrypted by default**. Treat a Secret as
  "marked sensitive", not "protected", until you have enabled encryption at rest and locked down
  RBAC.
- **ServiceAccount** — the identity a Pod presents to the API server. Modern tokens are
  **projected**: short-lived, audience-bound, and auto-rotated. They are a large improvement over
  the old never-expiring Secret-based tokens.
- **PersistentVolumeClaim / StorageClass** — a request for storage and the template that satisfies
  it dynamically.

---

## 1.7 Autoscaling

| Scaler | Scales | Signal |
|---|---|---|
| **HPA** | replica count | CPU, memory, or custom/external metrics |
| **VPA** | requests/limits of existing pods | historical usage |
| **Cluster Autoscaler / Karpenter** | number of nodes | pending, unschedulable pods |
| **KEDA** | replica count (incl. to zero) | event sources — queue depth, Kafka lag, etc. |

For LLM inference, CPU utilisation is a **poor** scaling signal — a GPU-bound server can sit at low
CPU while completely saturated. Scale on queue depth, requests-in-flight, or time-to-first-token
instead, via custom metrics or KEDA.

---

## 1.8 Security best practices — cluster layer

These are the controls that matter most, roughly in order of value delivered per unit of effort:

1. **RBAC, least privilege.** Grant verbs on specific resources in specific namespaces. Prefer
   `Role`+`RoleBinding` (namespaced) over `ClusterRole`+`ClusterRoleBinding`. Never bind
   `cluster-admin` to a workload ServiceAccount. Audit for wildcards (`*`) — they are almost always
   a mistake. `escalate`, `bind`, and `impersonate` verbs deserve special scrutiny.
2. **Set `automountServiceAccountToken: false`** on every workload that does not call the
   Kubernetes API — which is most of them. A mounted token is a credential sitting in the
   filesystem waiting for an RCE.
3. **Pod Security Admission** with the `restricted` profile, applied via namespace labels. PSA is
   the built-in successor to the removed PodSecurityPolicy and has been stable since v1.25. The
   `restricted` profile forbids privilege escalation, requires running as non-root, requires
   dropping ALL capabilities, and requires a seccomp profile.
   ```yaml
   metadata:
     labels:
       pod-security.kubernetes.io/enforce: restricted
       pod-security.kubernetes.io/enforce-version: latest
   ```
4. **Default-deny NetworkPolicy in every namespace**, then explicitly allow required flows —
   including **egress**. Most guides only cover ingress; egress is what stops a compromised pod
   from exfiltrating data or reaching the cloud metadata endpoint.
   ```yaml
   apiVersion: networking.k8s.io/v1
   kind: NetworkPolicy
   metadata: { name: default-deny-all }
   spec:
     podSelector: {}
     policyTypes: [Ingress, Egress]
   ```
5. **Block the cloud metadata endpoint** (`169.254.169.254`). If a pod can reach it, a
   server-side-request-forgery bug becomes cloud credential theft. Use egress policy plus a
   properly scoped IRSA/Workload Identity setup.
6. **Encrypt etcd at rest**, ideally with a KMS provider so the key is not on disk next to the data.
7. **Admission policy** — Kyverno, OPA/Gatekeeper, or the built-in **ValidatingAdmissionPolicy**
   (CEL-based, in-process, no webhook to fail). Enforce: signed images, no `:latest`, resource
   limits required, no host namespaces, approved registries only.
8. **Supply chain** — sign images (Sigstore/cosign), verify signatures at admission, generate and
   scan SBOMs, and pin images by **digest** (`@sha256:...`) rather than a mutable tag.
9. **Runtime isolation for untrusted code.** If you execute model- or user-generated code, a
   standard container is a shared-kernel boundary, not a security boundary. Use gVisor or Kata
   Containers.
10. **Audit logging** enabled at `RequestResponse` level for sensitive resources, shipped off-cluster.
11. **Restrict node access** — the kubelet API must not be anonymously reachable; use the
    `NodeRestriction` admission plugin so a compromised node cannot edit other nodes' objects.

> **The most under-appreciated point:** Kubernetes defaults are optimised for *getting started*,
> not for safety. Flat network, mounted tokens, no pod security profile, unencrypted Secrets. Every
> item above is you turning a default *off*.

---

## 1.9 Common misconceptions worth unlearning

| Belief | Reality |
|---|---|
| "Namespaces are a security boundary." | They are a *naming and policy scope*. Without NetworkPolicy + RBAC + PSA + quotas they isolate almost nothing. Cross-namespace pod-to-pod traffic flows freely by default. |
| "Secrets are encrypted." | Base64 encoding only, unless you configure encryption at rest. |
| "Containers are a security boundary." | They share the host kernel. For hostile code you need gVisor/Kata/VMs. |
| "Liveness probes improve availability." | A badly-tuned liveness probe is a self-inflicted outage — it restarts healthy-but-slow pods, often making an overload worse. |
| "The scheduler starts my pod." | It only writes a node binding. The kubelet starts it. |
| "`kubectl apply` is instant." | It records intent. Convergence is asynchronous and may never happen. |
| "Higher CPU limits mean faster pods." | CPU limits only throttle. Requests drive placement; limits cap. |
| "One replica with a restart policy is fine." | Node drains, evictions and upgrades all take it down. Use ≥2 replicas + a PodDisruptionBudget. |

---

**Next:** [2. MCP Deployed Inside Kubernetes →](./02-mcp-in-kubernetes.md)

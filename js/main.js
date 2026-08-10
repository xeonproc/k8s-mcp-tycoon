/**
 * main.js — bootstrap: renderer, camera rig, picking, and every DOM binding.
 *
 * world.js draws the park, sim.js runs the flow, content.js holds the curriculum.
 * This file is the only one that touches the DOM or the browser event loop.
 */
import * as THREE from '../vendor/three.module.min.js';
import { NODES, NODE_INFO, ZONES, PACKETS, FLOWS } from './content.js';
import { buildWorld } from './world.js';
import { Sim } from './sim.js';

const $ = (id) => document.getElementById(id);
const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ══════════════════════════════════════════════════════════════
   1. Renderer, scene, lights
   ══════════════════════════════════════════════════════════════ */
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const SKY = 0x8ec5e8;
const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 150, 320);

const camera = new THREE.PerspectiveCamera(46, 1, 0.5, 900);

scene.add(new THREE.HemisphereLight(0xdff0ff, 0x4a6b3f, 1.25));

const sun = new THREE.DirectionalLight(0xfff4e0, 1.5);
sun.position.set(-70, 95, 60);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 10;
sun.shadow.camera.far = 300;
Object.assign(sun.shadow.camera, { left: -130, right: 130, top: 110, bottom: -110 });
sun.shadow.camera.updateProjectionMatrix();
sun.shadow.bias = -0.0012;
scene.add(sun);

const { nodeObjects } = buildWorld(scene);

/* Ring that marks whichever building the user last selected. */
const pickRing = new THREE.Mesh(
  new THREE.RingGeometry(5.6, 7.2, 32),
  new THREE.MeshBasicMaterial({ color: 0x4ea1ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
);
pickRing.rotation.x = -Math.PI / 2;
pickRing.visible = false;
scene.add(pickRing);

/* Every mesh maps back to its node id, so a raycast hit anywhere on a
   building resolves to the building rather than to one of its boxes. */
const meshToNode = new Map();
Object.entries(nodeObjects).forEach(([id, { group }]) => {
  group.traverse((o) => { if (o.isMesh) meshToNode.set(o, id); });
});
const pickables = [...meshToNode.keys()];

/* ══════════════════════════════════════════════════════════════
   2. Camera rig — orbit / zoom / pan, mouse + touch
   ══════════════════════════════════════════════════════════════ */
const cam = {
  target: new THREE.Vector3(4, 2, 0),
  goalTarget: new THREE.Vector3(4, 2, 0),
  radius: 130, goalRadius: 130,
  theta: -0.72, goalTheta: -0.72,   // azimuth
  phi: 0.92, goalPhi: 0.92,         // polar, from +Y
};
const PHI_MIN = 0.18, PHI_MAX = 1.44;
const R_MIN = 26, R_MAX = 260;

function applyCamera(snap = false) {
  const k = snap || REDUCED ? 1 : 0.12;
  cam.radius += (cam.goalRadius - cam.radius) * k;
  cam.theta  += (cam.goalTheta  - cam.theta)  * k;
  cam.phi    += (cam.goalPhi    - cam.phi)    * k;
  cam.target.lerp(cam.goalTarget, k);

  const sp = Math.sin(cam.phi);
  camera.position.set(
    cam.target.x + cam.radius * sp * Math.sin(cam.theta),
    cam.target.y + cam.radius * Math.cos(cam.phi),
    cam.target.z + cam.radius * sp * Math.cos(cam.theta)
  );
  camera.lookAt(cam.target);
}

function focusOn(x, z, radius) {
  cam.goalTarget.set(x, 2, z);
  if (radius) cam.goalRadius = THREE.MathUtils.clamp(radius, R_MIN, R_MAX);
}

/* --- pointer handling: one pointer orbits, two pinch-zoom, shift/right pans --- */
const pointers = new Map();
let dragMoved = 0, pinchStart = 0, panning = false;
let lastX = 0, lastY = 0;

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  lastX = e.clientX; lastY = e.clientY;
  dragMoved = 0;
  panning = e.shiftKey || e.button === 2;
  canvas.classList.add('dragging');
  hideHint();
  if (pointers.size === 2) pinchStart = pinchDistance();
});

canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size >= 2) {
    const d = pinchDistance();
    if (pinchStart > 0) {
      cam.goalRadius = THREE.MathUtils.clamp(cam.goalRadius * (pinchStart / d), R_MIN, R_MAX);
    }
    pinchStart = d;
    dragMoved = 99;
    return;
  }

  const dx = e.clientX - lastX, dy = e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  dragMoved += Math.abs(dx) + Math.abs(dy);

  if (panning) {
    // Pan across the ground plane, scaled by how far out we are.
    const s = cam.radius * 0.0016;
    const right = new THREE.Vector3(Math.cos(cam.theta), 0, -Math.sin(cam.theta));
    const fwd   = new THREE.Vector3(Math.sin(cam.theta), 0, Math.cos(cam.theta));
    cam.goalTarget.addScaledVector(right, -dx * s).addScaledVector(fwd, -dy * s);
    cam.goalTarget.x = THREE.MathUtils.clamp(cam.goalTarget.x, -110, 110);
    cam.goalTarget.z = THREE.MathUtils.clamp(cam.goalTarget.z, -80, 80);
  } else {
    cam.goalTheta -= dx * 0.005;
    cam.goalPhi = THREE.MathUtils.clamp(cam.goalPhi - dy * 0.005, PHI_MIN, PHI_MAX);
  }
  followChk.checked = false;   // manual camera work wins over auto-follow
});

function pinchDistance() {
  const [a, b] = [...pointers.values()];
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function endPointer(e) {
  if (pointers.size < 2) pinchStart = 0;
  pointers.delete(e.pointerId);
  if (pointers.size === 0) {
    canvas.classList.remove('dragging');
    if (dragMoved < 6) pick(e);   // a click, not a drag
    panning = false;
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  cam.goalRadius = THREE.MathUtils.clamp(cam.goalRadius * (1 + Math.sign(e.deltaY) * 0.1), R_MIN, R_MAX);
  hideHint();
}, { passive: false });

/* --- click a building --- */
const raycaster = new THREE.Raycaster();
function pick(e) {
  const r = canvas.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(
    ((e.clientX - r.left) / r.width) * 2 - 1,
    -((e.clientY - r.top) / r.height) * 2 + 1
  ), camera);

  const hit = raycaster.intersectObjects(pickables, false)[0];
  if (!hit) return;
  const id = meshToNode.get(hit.object);
  if (!id) return;

  const node = NODES[id];
  selectNode(id);
  showNode(id);            // per-building card
  showZone(node.zone);     // its district, underneath
  openPanel();             // on a phone the panel starts collapsed
  if (followChk.checked) followChk.checked = false;
  focusOn(node.x, node.z, Math.min(cam.goalRadius, 74));
}

function selectNode(id) {
  const n = NODES[id];
  pickRing.position.set(n.x, n.y + 0.3, n.z);
  pickRing.visible = true;
}

/* ══════════════════════════════════════════════════════════════
   3. Simulation
   ══════════════════════════════════════════════════════════════ */
const sim = new Sim(scene);

/* ══════════════════════════════════════════════════════════════
   4. DOM wiring
   ══════════════════════════════════════════════════════════════ */
const flowSelect = $('flowSelect');
const btnPlay = $('btnPlay'), btnBack = $('btnBack'), btnFwd = $('btnFwd'), btnReset = $('btnReset');
const speed = $('speed'), speedOut = $('speedOut');
const loopChk = $('loopChk'), followChk = $('followChk');
const flowCard = $('flowCard'), flowKind = $('flowKind'), stepCount = $('stepCount');
const nodeCard = $('nodeCard');
const stepTitle = $('stepTitle'), stepBody = $('stepBody');
const practice = $('practice'), practiceText = $('practiceText'), stepList = $('stepList');
const hint = $('hint');

/* --- scenario dropdown, split into the two kinds --- */
{
  const groups = {
    normal: document.createElement('optgroup'),
    attack: document.createElement('optgroup'),
  };
  groups.normal.label = 'How it works';
  groups.attack.label = 'Attacks & controls';
  FLOWS.forEach((f) => {
    const o = document.createElement('option');
    o.value = f.id;
    o.textContent = f.name;
    o.title = f.blurb;
    groups[f.kind === 'attack' ? 'attack' : 'normal'].appendChild(o);
  });
  flowSelect.append(groups.normal, groups.attack);
}
flowSelect.addEventListener('change', () => sim.setFlow(flowSelect.value));

/* --- district chips --- */
Object.entries(ZONES).forEach(([id, z]) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.dataset.zone = id;
  b.innerHTML = `<span class="dot" style="color:${hex(z.color)}"></span>${z.name}`;
  b.title = z.subtitle;
  b.addEventListener('click', () => {
    hideNode();            // a district view supersedes any single building
    showZone(id);
    followChk.checked = false;
    focusOn(z.focus.x, z.focus.z, 78);
  });
  $('zoneChips').appendChild(b);
});

/* --- legend, generated from the packet table --- */
$('legendBody').innerHTML = Object.values(PACKETS)
  .map((p) => `<li><span class="swatch ${p.shape}" style="color:${hex(p.color)}"></span>${p.label}</li>`)
  .join('');
const legendToggle = $('legendToggle'), legendBody = $('legendBody');
legendToggle.addEventListener('click', () => {
  const open = legendToggle.getAttribute('aria-expanded') === 'true';
  legendToggle.setAttribute('aria-expanded', String(!open));
  legendBody.hidden = open;
});

$('nodeClose').addEventListener('click', hideNode);

/* --- panel collapse --- */
const panelToggle = $('panelToggle');
panelToggle.addEventListener('click', () => {
  const open = panelToggle.getAttribute('aria-expanded') === 'true';
  panelToggle.setAttribute('aria-expanded', String(!open));
  document.body.classList.toggle('panel-collapsed', open);
  setTimeout(resize, 300);   // grid transition has to finish first
});

/* --- transport --- */
btnPlay.addEventListener('click', () => sim.toggle());
btnFwd.addEventListener('click', () => sim.stepForward());
btnBack.addEventListener('click', () => sim.stepBack());
btnReset.addEventListener('click', () => { sim.reset(); sim.play(); });

speed.addEventListener('input', () => {
  sim.speed = parseFloat(speed.value);
  speedOut.textContent = `${sim.speed}×`;
});
loopChk.addEventListener('change', () => { sim.loop = loopChk.checked; });

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); sim.toggle(); }
  else if (e.code === 'ArrowRight') { e.preventDefault(); sim.stepForward(); }
  else if (e.code === 'ArrowLeft')  { e.preventDefault(); sim.stepBack(); }
  else if (e.key === 'r' || e.key === 'R') { sim.reset(); sim.play(); }
});

function hideHint() { hint.classList.add('hide'); }
setTimeout(hideHint, 9000);

/* ══════════════════════════════════════════════════════════════
   5. Rendering the teaching panel
   ══════════════════════════════════════════════════════════════ */
let currentZone = null;

/* Per-building card. Unlike showZone this has no "same id" early return —
   clicking a second building in the same district must still redraw. */
function showNode(id) {
  const n = NODES[id], info = NODE_INFO[id];
  if (!info) { hideNode(); return; }

  const z = ZONES[n.zone];
  nodeCard.hidden = false;
  $('nodeEyebrow').textContent = z ? z.name : 'Building';
  if (z) $('nodeEyebrow').style.color = hex(z.color);
  $('nodeName').textContent = n.label;
  $('nodeSub').textContent = n.sub;
  $('nodeWhat').textContent = info.what;
  $('nodeDetail').innerHTML = info.detail.map((d) => `<li>${d}</li>`).join('');
  $('nodePractices').innerHTML = info.practices.map((p) => `<li>${p}</li>`).join('');
  $('panelScroll').scrollTop = 0;
}

function hideNode() {
  nodeCard.hidden = true;
  pickRing.visible = false;
}

function openPanel() {
  if (!document.body.classList.contains('panel-collapsed')) return;
  document.body.classList.remove('panel-collapsed');
  panelToggle.setAttribute('aria-expanded', 'true');
  setTimeout(resize, 300);
}

function showZone(id) {
  const z = ZONES[id];
  if (!z || id === currentZone) {
    // still refresh the chip state — a flow may have moved us here
    markChip(id);
    return;
  }
  currentZone = id;
  $('zoneEyebrow').textContent = 'District';
  $('zoneName').textContent = z.name;
  $('zoneName').style.color = hex(z.color);
  $('zoneSub').textContent = z.subtitle;
  $('zoneSummary').textContent = z.summary;
  $('zoneDetail').innerHTML = z.detail.map((d) => `<li>${d}</li>`).join('');
  $('zonePractices').innerHTML = z.practices.map((p) => `<li>${p}</li>`).join('');
  markChip(id);
}

function markChip(id) {
  document.querySelectorAll('#zoneChips button').forEach((b) => {
    b.setAttribute('aria-current', String(b.dataset.zone === id));
  });
}

function renderFlow(flow) {
  flowSelect.value = flow.id;
  const attack = flow.kind === 'attack';
  flowKind.textContent = attack ? 'Attack path' : 'Flow';
  flowKind.classList.toggle('attack', attack);

  stepList.innerHTML = '';
  flow.steps.forEach((s, i) => {
    const li = document.createElement('li');
    li.textContent = s.title;
    li.tabIndex = 0;
    const go = () => { sim.pause(); sim.goToStep(i); };
    li.addEventListener('click', go);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.code === 'Space') { e.preventDefault(); go(); } });
    stepList.appendChild(li);
  });
  // setFlow emits 'step' BEFORE 'flowchange', so the list did not exist when
  // renderStep ran. Re-apply the highlight now that it does.
  markActiveStep(sim.stepIndex);
}

function markActiveStep(i) {
  [...stepList.children].forEach((li, n) => {
    li.classList.toggle('active', n === i);
    li.classList.toggle('done', n < i);
  });
}

function renderStep(s, i, flow) {
  stepCount.textContent = `Step ${i + 1} / ${flow.steps.length}`;
  stepTitle.textContent = s.title;
  stepBody.textContent = s.body;

  if (s.practice) {
    practice.hidden = false;
    practiceText.textContent = s.practice;
  } else {
    practice.hidden = true;
  }
  flowCard.classList.toggle('blocked', !!s.blocked);

  markActiveStep(i);
  if (s.zone) showZone(s.zone);

  // Frame the leg being travelled so the packet stays on screen.
  if (followChk.checked) {
    const a = NODES[s.from], b = NODES[s.to];
    const dist = Math.hypot(a.x - b.x, a.z - b.z);
    focusOn((a.x + b.x) / 2, (a.z + b.z) / 2, THREE.MathUtils.clamp(dist * 1.5 + 52, 62, 150));
  }
}

sim.on('flowchange', renderFlow);
sim.on('step', renderStep);
sim.on('playstate', (on) => {
  btnPlay.textContent = on ? '⏸' : '▶';
  btnPlay.setAttribute('aria-label', on ? 'Pause' : 'Play');
});

/* ══════════════════════════════════════════════════════════════
   6. Resize
   ══════════════════════════════════════════════════════════════ */
function resize() {
  const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // Narrow viewports need a wider field of view or the park will not fit.
  camera.fov = w / h < 1 ? 62 : 46;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 250));

/* ══════════════════════════════════════════════════════════════
   7. Go
   ══════════════════════════════════════════════════════════════ */
resize();

// Phones start with the park visible; the panel is one tap away.
if (window.innerWidth <= 900) {
  document.body.classList.add('panel-collapsed');
  panelToggle.setAttribute('aria-expanded', 'false');
  cam.goalRadius = cam.radius = 165;
}

sim.speed = parseFloat(speed.value);
sim.loop = loopChk.checked;
sim.setFlow(FLOWS[0].id, { autoplay: true });
sim.emit('playstate', sim.playing);
applyCamera(true);

const clock = new THREE.Clock();
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);   // clamp so a backgrounded tab does not jump

  sim.update(dt);

  if (followChk.checked && sim.packet.visible) {
    cam.goalTarget.x += (sim.packet.position.x - cam.goalTarget.x) * 0.035;
    cam.goalTarget.z += (sim.packet.position.z - cam.goalTarget.z) * 0.035;
  }
  applyCamera();

  if (pickRing.visible) {
    const p = performance.now() * 0.003;
    pickRing.material.opacity = 0.5 + Math.abs(Math.sin(p)) * 0.45;
    pickRing.scale.setScalar(0.95 + Math.sin(p) * 0.06);
  }

  renderer.render(scene, camera);
}
frame();

$('loading').classList.add('done');
setTimeout(() => $('loading').remove(), 600);

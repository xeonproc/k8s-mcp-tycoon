/**
 * world.js — builds the low-poly park geometry.
 *
 * Style rules: flat shading everywhere, no textures except text labels,
 * simple primitives only. RollerCoaster Tycoon by way of a whiteboard.
 */
import * as THREE from '../vendor/three.module.min.js';
import { NODES, ZONES, PLATEAU_CAP } from './content.js';

const flat = (color, opts = {}) =>
  new THREE.MeshLambertMaterial({ color, flatShading: true, ...opts });

/* Shared materials — reused so we ship few draw calls. */
const MAT = {
  grass:     flat(0x5a9b52),
  grassDark: flat(0x4f8c48),
  path:      flat(0xc9bfa4),
  plaza:     flat(0xd9d1bb),
  wall:      flat(0xe6e1d6),
  wallAlt:   flat(0xd6cfc0),
  roofBlue:  flat(0x3b82f6),
  roofTeal:  flat(0x14b8a6),
  roofPurp:  flat(0xa855f7),
  roofAmber: flat(0xf59e0b),
  roofGreen: flat(0x22c55e),
  roofSlate: flat(0x64748b),
  roofGold:  flat(0xeab308),
  roofRed:   flat(0xef4444),
  stone:     flat(0x9ca3af),
  stoneDark: flat(0x6b7280),
  trunk:     flat(0x6b4f2a),
  leaf:      flat(0x3f7d3a),
  leafAlt:   flat(0x478c41),
  glass:     flat(0x93c5fd),
  metal:     flat(0xb9c0c8),
  fence:     flat(0xef4444, { transparent: true, opacity: 0.28 }),
  gpu:       flat(0x22c55e),
  cloud:     flat(0xf1f5f9),
};

const ROOF_BY_ZONE = {
  gate: MAT.roofBlue, routing: MAT.roofTeal, agents: MAT.roofPurp,
  mcp: MAT.roofAmber, foundry: MAT.roofGreen, control: MAT.roofSlate,
  vault: MAT.roofGold,
};

/* ---------- text label sprites ---------- */
function makeLabel(text, sub, accent = '#e8eef5') {
  const pad = 16, fs = 40, sfs = 26;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = `700 ${fs}px system-ui, sans-serif`;
  const w1 = ctx.measureText(text).width;
  ctx.font = `500 ${sfs}px system-ui, sans-serif`;
  const w2 = sub ? ctx.measureText(sub).width : 0;
  const w = Math.max(w1, w2) + pad * 2;
  const h = sub ? fs + sfs + pad * 2 + 6 : fs + pad * 2;
  c.width = w; c.height = h;

  ctx.fillStyle = 'rgba(13,20,30,0.82)';
  ctx.beginPath();
  const r = 14;
  ctx.moveTo(r, 0); ctx.arcTo(w, 0, w, h, r); ctx.arcTo(w, h, 0, h, r);
  ctx.arcTo(0, h, 0, 0, r); ctx.arcTo(0, 0, w, 0, r); ctx.fill();

  ctx.textAlign = 'center';
  ctx.fillStyle = accent;
  ctx.font = `700 ${fs}px system-ui, sans-serif`;
  ctx.fillText(text, w / 2, pad + fs - 8);
  if (sub) {
    ctx.fillStyle = 'rgba(200,214,229,0.75)';
    ctx.font = `500 ${sfs}px system-ui, sans-serif`;
    ctx.fillText(sub, w / 2, pad + fs + sfs - 2);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  spr.scale.set(w / 26, h / 26, 1);
  spr.renderOrder = 999;
  return spr;
}

/* ---------- building primitives ---------- */
function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y + h / 2, z);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
function pyramid(r, h, mat, x = 0, y = 0, z = 0, seg = 4) {
  const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, seg), mat);
  m.position.set(x, y + h / 2, z);
  m.rotation.y = Math.PI / 4;
  m.castShadow = true;
  return m;
}
function cyl(r, h, mat, x = 0, y = 0, z = 0, seg = 8) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat);
  m.position.set(x, y + h / 2, z);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

function tree(x, z, scale = 1) {
  const g = new THREE.Group();
  g.add(cyl(0.35 * scale, 1.6 * scale, MAT.trunk));
  const leafMat = Math.random() > 0.5 ? MAT.leaf : MAT.leafAlt;
  g.add(pyramid(1.9 * scale, 3.4 * scale, leafMat, 0, 1.3 * scale, 0, 6));
  g.add(pyramid(1.4 * scale, 2.6 * scale, leafMat, 0, 2.9 * scale, 0, 6));
  g.position.set(x, 0, z);
  return g;
}

/* Each node kind gets its own silhouette so the park reads at a glance. */
function buildBuilding(node) {
  const g = new THREE.Group();
  const roof = ROOF_BY_ZONE[node.zone] || MAT.roofSlate;

  switch (node.kind) {
    case 'cloud': {
      // Floating "internet" cloud — deliberately outside the cluster.
      const c = new THREE.Group();
      [[0, 0, 2.6], [2.2, 0.4, 2.0], [-2.2, 0.3, 1.8], [0.8, 1.4, 1.6]].forEach(([dx, dy, r]) => {
        const s = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), MAT.cloud);
        s.position.set(dx, dy, 0); s.castShadow = true; c.add(s);
      });
      c.position.y = 7;
      g.add(c);
      break;
    }
    case 'gate': {
      g.add(box(1.6, 8, 1.6, MAT.wall, -4, 0, 0));
      g.add(box(1.6, 8, 1.6, MAT.wall, 4, 0, 0));
      g.add(box(10, 1.6, 2.2, roof, 0, 8, 0));
      g.add(pyramid(1.7, 2.4, roof, -4, 8, 0));
      g.add(pyramid(1.7, 2.4, roof, 4, 8, 0));
      g.add(box(7, 0.25, 5, MAT.plaza, 0, 0, 0));
      break;
    }
    case 'hub': {
      g.add(cyl(3.4, 3.2, MAT.wall, 0, 0, 0, 6));
      g.add(pyramid(4.2, 2.6, roof, 0, 3.2, 0, 6));
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        g.add(box(0.5, 2.2, 0.5, MAT.wallAlt, Math.cos(a) * 4.6, 0, Math.sin(a) * 4.6));
      }
      break;
    }
    case 'agent': {
      g.add(box(6, 5, 5, MAT.wall));
      g.add(box(6.6, 0.7, 5.6, roof, 0, 5, 0));
      g.add(box(3, 2.4, 3, MAT.wallAlt, 0, 5.7, 0));
      g.add(pyramid(2.8, 2.2, roof, 0, 8.1, 0));
      // windows
      [-1.7, 1.7].forEach((dx) => [-1, 1].forEach((dy) =>
        g.add(box(1.2, 1.2, 0.15, MAT.glass, dx, 1.4 + dy * 1.8, 2.55))));
      break;
    }
    case 'gateway': {
      g.add(box(7, 4, 6, MAT.wall));
      g.add(box(7.6, 0.6, 6.6, roof, 0, 4, 0));
      g.add(cyl(1.1, 5, MAT.wallAlt, 0, 4.6, 0, 6));
      g.add(pyramid(1.7, 1.8, roof, 0, 9.6, 0, 6));
      break;
    }
    case 'shop': {
      const untrusted = node.label.includes('third-party');
      g.add(box(5.4, 3.6, 4.6, MAT.wall));
      g.add(box(6.2, 0.5, 5.4, untrusted ? MAT.roofRed : roof, 0, 3.6, 0));
      // awning stripes — market stall feel
      for (let i = -2; i <= 2; i++) {
        g.add(box(0.9, 0.2, 1.6, i % 2 ? MAT.wallAlt : (untrusted ? MAT.roofRed : roof),
          i * 1.0, 3.2, 3.0));
      }
      g.add(box(0.4, 3.2, 0.4, MAT.stoneDark, -2.4, 0, 3.6));
      g.add(box(0.4, 3.2, 0.4, MAT.stoneDark, 2.4, 0, 3.6));
      break;
    }
    case 'foundry': {
      g.add(box(9, 6, 7, MAT.wall));
      // sawtooth industrial roof
      for (let i = -1; i <= 1; i++) {
        g.add(box(2.8, 0.5, 7.4, roof, i * 3, 6, 0));
        g.add(box(2.4, 1.5, 0.3, MAT.glass, i * 3, 6.4, -3.2));
      }
      // GPU stacks
      [-2.6, 0, 2.6].forEach((dx) => g.add(box(1.4, 2.2, 1.4, MAT.gpu, dx, 6.5, 1.6)));
      g.add(cyl(0.9, 4, MAT.metal, -4.6, 6, -2.4, 6));
      break;
    }
    case 'egressgw': {
      g.add(box(2, 7, 5.5, MAT.stone, -2.6, 0, 0));
      g.add(box(2, 7, 5.5, MAT.stone, 2.6, 0, 0));
      g.add(box(7.6, 1.2, 6, roof, 0, 7, 0));
      g.add(box(3.4, 5.2, 0.5, MAT.roofRed, 0, 0.4, 0));
      break;
    }
    case 'fence': {
      // NetworkPolicy boundary. Solid posts and a cap rail give the translucent
      // wall enough substance to be a clickable target, not just a haze.
      g.add(box(0.6, 9, 30, MAT.fence));
      for (let i = -2; i <= 2; i++) g.add(box(1.3, 9.4, 1.3, MAT.roofRed, 0, 0, i * 7));
      g.add(box(1.8, 0.5, 30, MAT.roofRed, 0, 9.4, 0));
      break;
    }
    case 'gatehouse': {
      // Admission control — a gate you pass THROUGH, in front of the keep.
      g.add(box(2.2, 5.5, 2.2, MAT.stone, -3.4, 0, 0));
      g.add(box(2.2, 5.5, 2.2, MAT.stone, 3.4, 0, 0));
      g.add(box(9.4, 1.3, 3, roof, 0, 5.5, 0));
      g.add(pyramid(1.8, 2.2, roof, -3.4, 6.8, 0));
      g.add(pyramid(1.8, 2.2, roof, 3.4, 6.8, 0));
      g.add(box(4.6, 0.45, 0.45, MAT.roofRed, 0, 2.8, 0));   // the barrier itself
      break;
    }
    case 'vault': {
      g.add(box(7, 5, 7, MAT.stone));
      g.add(box(7.8, 0.8, 7.8, roof, 0, 5, 0));
      const door = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 0.5, 12), MAT.roofGold);
      door.rotation.x = Math.PI / 2; door.position.set(0, 2.6, 3.6);
      g.add(door);
      break;
    }
    case 'keep': {
      // The API server — a castle keep. It is the only door to etcd.
      g.add(box(9, 8, 9, MAT.stone));
      g.add(box(10, 1, 10, MAT.stoneDark, 0, 8, 0));
      [[-4.2, -4.2], [4.2, -4.2], [-4.2, 4.2], [4.2, 4.2]].forEach(([dx, dz]) => {
        g.add(cyl(1.3, 11, MAT.stone, dx, 0, dz, 6));
        g.add(pyramid(1.8, 2.6, roof, dx, 11, dz, 6));
      });
      g.add(box(2.6, 4, 0.5, MAT.stoneDark, 0, 0, 4.6));
      break;
    }
    case 'tower': {
      g.add(cyl(2.3, 7, MAT.stone, 0, 0, 0, 6));
      g.add(cyl(2.8, 0.8, MAT.stoneDark, 0, 7, 0, 6));
      g.add(pyramid(3.0, 3.4, roof, 0, 7.8, 0, 6));
      break;
    }
    case 'depot': {
      g.add(box(7, 3.4, 5, MAT.wall));
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 7.2, 12, 1, false, 0, Math.PI), roof);
      bar.rotation.z = Math.PI / 2; bar.position.set(0, 3.4, 0);
      bar.castShadow = true;
      g.add(bar);
      break;
    }
    default:
      g.add(box(5, 4, 5, MAT.wall));
      g.add(pyramid(4, 2.4, roof, 0, 4, 0));
  }
  return g;
}

/* ---------- the park ---------- */
export function buildWorld(scene) {
  const nodeObjects = {};
  const root = new THREE.Group();
  scene.add(root);

  // Ground
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(210, 150), MAT.grass);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  root.add(ground);

  // Subtle grass patchwork for a tiled, hand-made feel
  for (let i = 0; i < 130; i++) {
    const s = 5 + Math.random() * 8;
    const p = new THREE.Mesh(new THREE.PlaneGeometry(s, s), MAT.grassDark);
    p.rotation.x = -Math.PI / 2;
    p.position.set((Math.random() - 0.5) * 200, 0.02, (Math.random() - 0.5) * 140);
    p.receiveShadow = true;
    root.add(p);
  }

  // Control-plane plateau — literally elevated above the workload plane
  const hill = new THREE.Mesh(new THREE.BoxGeometry(78, 6, 34), MAT.stoneDark);
  hill.position.set(-12, 3, -34);
  hill.castShadow = true; hill.receiveShadow = true;
  root.add(hill);
  const hillTop = new THREE.Mesh(new THREE.BoxGeometry(74, PLATEAU_CAP, 30), MAT.plaza);
  hillTop.position.set(-12, 6 + PLATEAU_CAP / 2, -34);
  hillTop.receiveShadow = true;
  root.add(hillTop);
  // ramp up to the hill
  const ramp = new THREE.Mesh(new THREE.BoxGeometry(7, 0.5, 14), MAT.path);
  ramp.position.set(8, 3.2, -21); ramp.rotation.x = -0.42;
  ramp.receiveShadow = true;
  root.add(ramp);

  // Zone pads — a tinted platform under each district
  const zoneBounds = {
    gate:    { x: -48, z: 2,   w: 26, d: 26 },
    routing: { x: -23, z: 2,   w: 18, d: 24 },
    agents:  { x: -5,  z: 2,   w: 20, d: 40 },
    mcp:     { x: 22,  z: 3,   w: 32, d: 44 },
    foundry: { x: 46,  z: -5,  w: 22, d: 34 },
    vault:   { x: 60,  z: -4,  w: 18, d: 34 },
  };
  Object.entries(zoneBounds).forEach(([id, b]) => {
    const pad = new THREE.Mesh(
      new THREE.PlaneGeometry(b.w, b.d),
      new THREE.MeshBasicMaterial({ color: ZONES[id].color, transparent: true, opacity: 0.10 })
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(b.x, 0.05, b.z);
    root.add(pad);
  });

  // Main path — the spine the traffic follows
  const spine = new THREE.Mesh(new THREE.PlaneGeometry(122, 4.5), MAT.path);
  spine.rotation.x = -Math.PI / 2;
  spine.position.set(2, 0.08, 2);
  spine.receiveShadow = true;
  root.add(spine);

  // Branch paths to off-spine buildings
  const branches = [
    [-5, -9, 3.5, 12], [-5, 12, 3.5, 12], [28, -11, 3.5, 16],
    [28, 17, 3.5, 16], [46, -12, 3.5, 18], [60, -14, 3.5, 20], [60, 6, 3.5, 12],
  ];
  branches.forEach(([x, z, w, d]) => {
    const b = new THREE.Mesh(new THREE.PlaneGeometry(w, d), MAT.path);
    b.rotation.x = -Math.PI / 2;
    b.position.set(x, 0.07, (z + 2) / 2);
    b.receiveShadow = true;
    root.add(b);
  });

  // Buildings
  Object.entries(NODES).forEach(([id, node]) => {
    const g = buildBuilding(node);
    g.position.set(node.x, node.y, node.z);
    root.add(g);

    const bbox = new THREE.Box3().setFromObject(g);
    const top = Math.max(bbox.max.y, node.y + 4);
    const label = makeLabel(node.label, node.sub);
    label.position.set(node.x, top + 3.2, node.z);
    root.add(label);

    nodeObjects[id] = { group: g, label, node, anchorY: node.y + 3 };
  });

  // The NetworkPolicy boundary used to be drawn here as loose scenery. It is now
  // the `netpol` node instead, so the most-cited control in the curriculum is
  // clickable rather than decorative.

  // Trees, kept off the paths
  const treeSpots = [];
  for (let i = 0; i < 90; i++) {
    const x = (Math.random() - 0.5) * 195;
    const z = (Math.random() - 0.5) * 135;
    const onSpine = Math.abs(z - 2) < 6 && x > -60 && x < 66;
    const onHill = z < -16 && x > -52 && x < 28;
    let nearBuilding = false;
    for (const n of Object.values(NODES)) {
      if (Math.hypot(n.x - x, n.z - z) < 12) { nearBuilding = true; break; }
    }
    if (onSpine || onHill || nearBuilding) continue;
    treeSpots.push([x, z]);
  }
  treeSpots.forEach(([x, z]) => root.add(tree(x, z, 0.7 + Math.random() * 0.6)));

  return { root, nodeObjects, MAT };
}

export { makeLabel };

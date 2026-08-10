/**
 * sim.js — the flow engine.
 *
 * Owns: which flow is running, which step we are on, how far through that step,
 * and the packet meshes travelling between buildings. Deliberately decoupled from
 * the DOM — it emits events and ui.js decides what to render.
 */
import * as THREE from '../vendor/three.module.min.js';
import { NODES, PACKETS, FLOW_BY_ID, FLOWS, surfaceY } from './content.js';

const STEP_SECONDS = 3.2;   // base duration of one step at 1x
const HOLD_SECONDS = 0.9;   // pause on arrival so the card can be read

function packetMesh(type) {
  const def = PACKETS[type] || PACKETS.user;
  let geo;
  if (def.shape === 'octa') geo = new THREE.OctahedronGeometry(1.05, 0);
  else if (def.shape === 'box') geo = new THREE.BoxGeometry(1.5, 1.5, 1.5);
  else geo = new THREE.IcosahedronGeometry(1.1, 0);

  const mat = new THREE.MeshLambertMaterial({
    color: def.color, flatShading: true,
    emissive: def.color, emissiveIntensity: 0.45,
  });
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  return m;
}

/** Glow ring that pulses under a building when something is blocked/denied. */
function makeRing(color) {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(3.2, 5.6, 24),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.visible = false;
  return ring;
}

export class Sim {
  constructor(scene) {
    this.scene = scene;
    this.flowId = FLOWS[0].id;
    this.stepIndex = 0;
    this.t = 0;
    this.hold = 0;
    this.playing = false;
    this.speed = 1;
    this.loop = true;

    this.packet = packetMesh('user');
    this.packet.visible = false;
    scene.add(this.packet);

    this.trail = [];
    for (let i = 0; i < 7; i++) {
      const t = packetMesh('user');
      t.scale.setScalar(0.55 - i * 0.05);
      t.visible = false;
      t.material = t.material.clone();
      t.material.transparent = true;
      t.material.opacity = 0.42 - i * 0.05;
      scene.add(t);
      this.trail.push({ mesh: t, pos: new THREE.Vector3() });
    }

    this.ring = makeRing(0xff4d4d);
    scene.add(this.ring);

    this.listeners = {};
  }

  on(evt, fn) { (this.listeners[evt] ||= []).push(fn); return this; }
  emit(evt, ...args) { (this.listeners[evt] || []).forEach((f) => f(...args)); }

  get flow() { return FLOW_BY_ID[this.flowId]; }
  get step() { return this.flow.steps[this.stepIndex]; }

  setFlow(id, { autoplay = true } = {}) {
    this.flowId = id;
    this.stepIndex = 0;
    this.t = 0;
    this.hold = 0;
    this.ring.visible = false;
    this.playing = autoplay;
    this._beginStep();
    this.emit('flowchange', this.flow);
  }

  play()  { this.playing = true;  this.emit('playstate', true); }
  pause() { this.playing = false; this.emit('playstate', false); }
  toggle() { this.playing ? this.pause() : this.play(); }

  reset() {
    this.stepIndex = 0; this.t = 0; this.hold = 0;
    this.ring.visible = false;
    this._beginStep();
  }

  /** Advance exactly one step and stop — the "step through it myself" control. */
  stepForward() {
    this.pause();
    this.t = 0; this.hold = 0;
    this.stepIndex = (this.stepIndex + 1) % this.flow.steps.length;
    this._beginStep();
  }

  stepBack() {
    this.pause();
    this.t = 0; this.hold = 0;
    this.stepIndex = (this.stepIndex - 1 + this.flow.steps.length) % this.flow.steps.length;
    this._beginStep();
  }

  goToStep(i) {
    this.t = 0; this.hold = 0;
    this.stepIndex = Math.max(0, Math.min(i, this.flow.steps.length - 1));
    this._beginStep();
  }

  _beginStep() {
    const s = this.step;
    const def = PACKETS[s.packet] || PACKETS.user;

    // Retint the packet + trail for this step's traffic type
    this.packet.material.color.setHex(def.color);
    this.packet.material.emissive.setHex(def.color);
    this.trail.forEach((t) => {
      t.mesh.material.color.setHex(def.color);
      t.mesh.material.emissive.setHex(def.color);
    });
    this.packet.visible = true;
    this.ring.visible = false;

    this.emit('step', s, this.stepIndex, this.flow);
  }

  _anchor(id) {
    const n = NODES[id];
    return new THREE.Vector3(n.x, n.y + 6.5, n.z);
  }

  update(dt) {
    const s = this.step;
    if (!s) return;

    if (this.playing) {
      if (this.hold > 0) {
        this.hold -= dt * this.speed;
        if (this.hold <= 0) this._advance();
      } else {
        this.t += (dt * this.speed) / STEP_SECONDS;
        if (this.t >= 1) {
          this.t = 1;
          this.hold = HOLD_SECONDS;
          if (s.blocked) {
            this.ring.visible = true;
            this.emit('blocked', s);
          }
        }
      }
    }

    this._place(s, this.t);
  }

  _advance() {
    const last = this.stepIndex >= this.flow.steps.length - 1;
    if (last) {
      this.emit('flowcomplete', this.flow);
      if (this.loop) { this.stepIndex = 0; this.t = 0; this._beginStep(); }
      else this.pause();
    } else {
      this.stepIndex++; this.t = 0; this._beginStep();
    }
  }

  _place(s, t) {
    const a = this._anchor(s.from);
    const b = this._anchor(s.to);
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

    let pos;
    if (s.from === s.to) {
      // Self-step: orbit above the building so "work happening here" still reads.
      const n = NODES[s.from];
      const ang = ease * Math.PI * 2;
      pos = new THREE.Vector3(
        n.x + Math.cos(ang) * 4.5,
        n.y + 8.5 + Math.sin(ang * 2) * 1.2,
        n.z + Math.sin(ang) * 4.5
      );
    } else {
      const dist = a.distanceTo(b);
      const arc = Math.min(9, 2.5 + dist * 0.13);
      pos = new THREE.Vector3().lerpVectors(a, b, ease);
      pos.y += Math.sin(ease * Math.PI) * arc;
    }

    this.packet.position.copy(pos);
    this.packet.rotation.y += 0.045;
    this.packet.rotation.x += 0.022;

    // Blocked steps: the packet shudders and shrinks rather than arriving cleanly.
    if (s.blocked && t >= 1) {
      const p = performance.now() * 0.012;
      this.packet.position.x += Math.sin(p * 3) * 0.5;
      this.packet.scale.setScalar(0.75 + Math.sin(p) * 0.18);
      this.ring.position.set(NODES[s.to].x, surfaceY(NODES[s.to]) + 0.25, NODES[s.to].z);
      const pulse = 0.55 + Math.abs(Math.sin(p * 0.55)) * 0.45;
      this.ring.material.opacity = pulse;
      this.ring.scale.setScalar(0.9 + pulse * 0.25);
    } else {
      this.packet.scale.setScalar(1);
    }

    // Trail: sample slightly behind along the same curve
    this.trail.forEach((tr, i) => {
      const lag = Math.max(0, t - (i + 1) * 0.035);
      const e2 = lag < 0.5 ? 2 * lag * lag : 1 - Math.pow(-2 * lag + 2, 2) / 2;
      let tp;
      if (s.from === s.to) {
        const n = NODES[s.from];
        const ang = e2 * Math.PI * 2;
        tp = new THREE.Vector3(
          n.x + Math.cos(ang) * 4.5,
          n.y + 8.5 + Math.sin(ang * 2) * 1.2,
          n.z + Math.sin(ang) * 4.5
        );
      } else {
        const dist = a.distanceTo(b);
        const arc = Math.min(9, 2.5 + dist * 0.13);
        tp = new THREE.Vector3().lerpVectors(a, b, e2);
        tp.y += Math.sin(e2 * Math.PI) * arc;
      }
      tr.mesh.position.copy(tp);
      tr.mesh.visible = lag > 0.001;
      tr.mesh.rotation.copy(this.packet.rotation);
    });
  }
}

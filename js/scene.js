// Escena 3D en sección: la ventana vista de canto, exterior a la izquierda e interior a la derecha.
// Las sombras las calcula three.js (shadow map) con la geometría completa; lo visible se corta
// en un plano z = zCut para que el corte se vea como un plano de sección.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { traceRay } from './model.js';

const Z_EXTENT = 40; // longitud de la calle a cada lado (m)
const Z_VISIBLE = 10; // profundidad visible detrás del plano de corte (m)
const N_RAYS = 14;

const COLORS = {
  asphalt: 0x5a5d63,
  sidewalk: 0xa9a49a,
  opposite: 0xd8c7a8,
  facade: 0xe9e4da,
  slab: 0xb9b4aa,
  floor: 0xd9d2c3,
  interiorWall: 0xf3efe7,
  building: 0xc9c3b7,
  glass: 0x9fd3ea,
  edge: 0x2b2b2b,
  rayLit: new THREE.Color(0xffd23f),
  rayIn: new THREE.Color(0xfff2a8),
  rayShade: new THREE.Color(0xa0522d),
  rayFiltered: new THREE.Color(0xff9f1c),
  depth: 0xd7263d,
  skyDay: new THREE.Color(0x9cc9ee),
  skyTwilight: new THREE.Color(0xf2a86b),
  skyNight: new THREE.Color(0x0d1426),
};

function makeStripeTexture() {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 16;
  const g = c.getContext('2d');
  g.fillStyle = '#c0392b';
  g.fillRect(0, 0, 4, 16);
  g.fillStyle = '#f6efe4';
  g.fillRect(0, 0, 4, 8);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function label(text, cls = '') {
  const div = document.createElement('div');
  div.className = 'scene-label ' + cls;
  div.textContent = text;
  return new CSS2DObject(div);
}

export class SectionScene {
  constructor(container) {
    this.container = container;
    this.cutMode = 'center';

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = 'label-layer';
    container.appendChild(this.labelRenderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = COLORS.skyDay.clone();

    // Campo de visión estrecho: la vista de canto se acerca a una sección ortográfica
    this.camera = new THREE.PerspectiveCamera(16, 1, 0.5, 2000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.hemi = new THREE.HemisphereLight(0xdfefff, 0x8a7f6c, 0.9);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff4e0, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);

    this.sunDisc = new THREE.Mesh(
      new THREE.SphereGeometry(2.2, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0xfff1b0 })
    );
    this.scene.add(this.sunDisc);

    this.mats = {
      asphalt: new THREE.MeshStandardMaterial({ color: COLORS.asphalt, roughness: 0.95 }),
      sidewalk: new THREE.MeshStandardMaterial({ color: COLORS.sidewalk, roughness: 0.9 }),
      opposite: new THREE.MeshStandardMaterial({ color: COLORS.opposite, roughness: 0.9 }),
      facade: new THREE.MeshStandardMaterial({ color: COLORS.facade, roughness: 0.85 }),
      slab: new THREE.MeshStandardMaterial({ color: COLORS.slab, roughness: 0.9 }),
      floor: new THREE.MeshStandardMaterial({ color: COLORS.floor, roughness: 0.8 }),
      interiorWall: new THREE.MeshStandardMaterial({ color: COLORS.interiorWall, roughness: 0.9 }),
      building: new THREE.MeshStandardMaterial({ color: COLORS.building, roughness: 0.95 }),
      glass: new THREE.MeshStandardMaterial({
        color: COLORS.glass, transparent: true, opacity: 0.25, roughness: 0.05, metalness: 0.1, depthWrite: false,
      }),
      awning: new THREE.MeshStandardMaterial({ map: makeStripeTexture(), roughness: 0.8, side: THREE.DoubleSide }),
      ghost: new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }),
      edge: new THREE.LineBasicMaterial({ color: COLORS.edge, transparent: true, opacity: 0.55 }),
      ruler: new THREE.LineBasicMaterial({ color: 0x555555 }),
      depth: new THREE.LineBasicMaterial({ color: COLORS.depth }),
    };

    this.world = new THREE.Group();
    this.scene.add(this.world);

    // Rayos solares (actualizados en cada fotograma)
    const rayGeom = new THREE.BufferGeometry();
    rayGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N_RAYS * 3 * 2 * 3), 3));
    rayGeom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(N_RAYS * 3 * 2 * 3), 3));
    this.rays = new THREE.LineSegments(rayGeom, new THREE.LineBasicMaterial({ vertexColors: true }));
    this.rays.frustumCulled = false;
    this.scene.add(this.rays);

    // Marcador de penetración máxima
    const dGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, 1)]);
    this.depthLine = new THREE.Line(dGeom, this.mats.depth);
    this.depthLabel = label('', 'depth');
    this.scene.add(this.depthLine, this.depthLabel);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();

    const loop = () => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.labelRenderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setCutMode(mode) {
    this.cutMode = mode;
    if (this.cfg) this.setConfig(this.cfg, false);
  }

  /** Añade una caja alineada a ejes: la parte z ≤ zCut se ve, el resto solo proyecta sombra. */
  box(x0, x1, y0, y1, z0, z1, mat, { cast = true, receive = true, edges = true } = {}) {
    if (x1 <= x0 || y1 <= y0 || z1 <= z0) return;
    const zc = this.zCut;
    const make = (za, zb, material) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, zb - za), material);
      m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (za + zb) / 2);
      return m;
    };
    const zv = Math.max(z0, -Z_VISIBLE);
    if (zv < zc) {
      // Si la caja queda cortada, su cara +z es la superficie de sección: color plano sin sombras
      const m = make(zv, Math.min(z1, zc), z1 > zc && mat !== this.mats.glass ? this.capMaterials(mat) : mat);
      m.castShadow = cast;
      m.receiveShadow = receive;
      this.world.add(m);
      if (edges) {
        const e = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), this.mats.edge);
        e.position.copy(m.position);
        this.world.add(e);
      }
    }
    // Partes fuera de la vista: invisibles pero proyectan sombra
    const ghosts = [[Math.max(z0, zc), z1], [z0, Math.min(z1, -Z_VISIBLE)]];
    for (const [a, b] of ghosts) {
      if (b <= a || !cast) continue;
      const g = make(a, b, this.mats.ghost);
      g.castShadow = true;
      this.world.add(g);
    }
  }

  /** Material por cara de BoxGeometry (px, nx, py, ny, pz, nz) con la cara +z como corte. */
  capMaterials(mat) {
    this.caps ??= new Map();
    let arr = this.caps.get(mat);
    if (!arr) {
      const cap = new THREE.MeshBasicMaterial({ color: mat.color.clone().multiplyScalar(0.62) });
      arr = [mat, mat, mat, mat, cap, mat];
      this.caps.set(mat, arr);
    }
    return arr;
  }

  setConfig(cfg, resetCamera = true) {
    this.cfg = cfg;
    // Vaciar la geometría anterior
    for (const o of [...this.world.children]) {
      this.world.remove(o);
      if (o.geometry) o.geometry.dispose();
      if (o.element) o.element.remove();
    }

    const { room, street, facade, awning } = cfg;
    const t = facade.wallThickness;
    const S = street.separation;
    const Hw = Math.min(room.windowHeight, room.ceilingHeight);
    const Hc = room.ceilingHeight;
    const Hb = Math.max(facade.buildingHeight, Hc + 0.3);
    const Ww = room.windowWidth;
    const Wr = Math.max(room.width, Ww);
    const D = room.depth;
    const L = Z_EXTENT;
    const wr = Wr / 2 + 0.2;
    this.zCut = this.cutMode === 'center' ? 0 : Wr / 2 + 0.001;
    const M = this.mats;

    // Calle y aceras
    const xOpp = -t - S;
    this.box(xOpp - 14, -t, -0.3, 0, -L, L, M.asphalt, { cast: false });
    this.box(-t - Math.min(1.8, S / 3), -t, 0, 0.005, -L, L, M.sidewalk, { cast: false, edges: false });
    this.box(xOpp, xOpp + Math.min(1.8, S / 3), 0, 0.005, -L, L, M.sidewalk, { cast: false, edges: false });

    // Edificio de enfrente
    if (street.oppositeHeight > 0) this.box(xOpp - 12, xOpp, 0, street.oppositeHeight, -L, L, M.opposite);

    // Fachada propia con el hueco de la ventana
    this.box(-t, 0, 0, Hb, -L, -Ww / 2, M.facade);
    this.box(-t, 0, 0, Hb, Ww / 2, L, M.facade);
    this.box(-t, 0, Hw, Hb, -Ww / 2, Ww / 2, M.facade);
    if (room.sillHeight > 0) this.box(-t, 0, 0, room.sillHeight, -Ww / 2, Ww / 2, M.facade);

    // Vidrio (no proyecta sombra; la transmitancia se aplica en los cálculos)
    this.box(-0.04, -0.01, room.sillHeight, Hw, -Ww / 2, Ww / 2, M.glass, { cast: false, receive: false });

    // Local interior
    this.box(-t, D + 0.2, -0.3, 0, -wr, wr, M.floor, { cast: false });
    this.box(0, D + 0.2, Hc, Hc + 0.3, -wr, wr, M.slab);
    this.box(D, D + 0.2, 0, Hc, -wr, wr, M.interiorWall);
    this.box(0, D, 0, Hc, -wr, -Wr / 2, M.interiorWall);
    this.box(0, D, 0, Hc, Wr / 2, wr, M.interiorWall);
    if (Hb > Hc + 0.3) this.box(0, D + 0.2, Hc + 0.3, Hb, -wr, wr, M.building);

    // Toldo
    if (awning.enabled && awning.length > 0 && awning.width > 0) {
      const al = THREE.MathUtils.degToRad(awning.angle);
      const e1 = new THREE.Vector2(-Math.cos(al), -Math.sin(al));
      const hx = -t, hy = awning.mountHeight;
      const addPart = (za, zb, mat, visible) => {
        if (zb <= za) return;
        const tex = M.awning.map;
        tex.repeat.set(1, Math.max(1, Math.round(awning.width / 0.4)));
        const m = new THREE.Mesh(new THREE.BoxGeometry(awning.length, 0.03, zb - za), mat);
        m.rotation.z = Math.PI + al;
        m.position.set(hx + (e1.x * awning.length) / 2, hy + (e1.y * awning.length) / 2, (za + zb) / 2);
        m.castShadow = true;
        m.receiveShadow = visible;
        this.world.add(m);
      };
      const zc = this.zCut;
      addPart(-awning.width / 2, Math.min(awning.width / 2, zc), M.awning, true);
      addPart(Math.max(-awning.width / 2, zc), awning.width / 2, M.ghost, false);
      // Cofre del toldo (solo visual)
      const cof = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, Math.min(awning.width / 2, zc) + awning.width / 2), M.slab);
      cof.position.set(hx - 0.11, hy + 0.05, (Math.min(awning.width / 2, zc) - awning.width / 2) / 2);
      if (zc > -awning.width / 2) this.world.add(cof);
      const lab = label('Toldo', 'awning');
      lab.position.set(hx + e1.x * awning.length * 0.5, hy + e1.y * awning.length * 0.5 + 0.45, this.zCut);
      this.world.add(lab);
    }

    // Regla en el suelo cada metro
    const pts = [];
    const zr = Math.min(this.zCut, Wr / 2);
    const every = D > 12 ? 4 : D > 6 ? 2 : 1;
    for (let k = 1; k <= Math.floor(D); k++) {
      pts.push(new THREE.Vector3(k, 0.01, zr - 0.35), new THREE.Vector3(k, 0.01, zr));
      if (k % every) continue;
      const l = label(`${k} m`, 'ruler');
      l.position.set(k, 0.02, zr + 0.05);
      this.world.add(l);
    }
    pts.push(new THREE.Vector3(0, 0.01, zr - 0.02), new THREE.Vector3(D, 0.01, zr - 0.02));
    this.world.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), M.ruler));

    // Rótulos
    const lExt = label('EXTERIOR', 'zone');
    lExt.position.set(-t - S / 2, Math.max(Hw, 2.5) + 1.2, this.zCut);
    const lInt = label('INTERIOR', 'zone');
    lInt.position.set(D / 2, Hc - 0.45, this.zCut);
    const lOpp = label(`Edificio enfrente · ${street.oppositeHeight} m`, 'small');
    lOpp.position.set(xOpp - 3, street.oppositeHeight + 0.6, this.zCut);
    const lSep = label(`↔ ${S} m`, 'small');
    lSep.position.set(-t - S / 2, 0.35, this.zCut);
    this.world.add(lExt, lInt, lSep);
    if (street.oppositeHeight > 0) this.world.add(lOpp);

    // Cámara de sombras y encuadre
    this.center = new THREE.Vector3((xOpp - 4 + D) / 2, Math.max(Hb, street.oppositeHeight) / 2, 0);
    this.shadowRadius = Math.max(25, (S + D + 30) * 0.75);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -this.shadowRadius;
    sc.right = sc.top = this.shadowRadius;
    sc.near = 1;
    sc.far = 400;
    sc.updateProjectionMatrix();

    if (resetCamera) this.resetView('section');
    if (this.lastSun) this.setSun(this.lastSun.state, this.lastSun.instant);
  }

  resetView(kind = 'section') {
    if (!this.cfg) return;
    const { street, room, facade } = this.cfg;
    const width = facade.wallThickness + street.separation + 6 + room.depth;
    const height = Math.max(facade.buildingHeight, street.oppositeHeight) + 2;
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const distH = height / 2 / Math.tan(fov / 2);
    const distW = width / 2 / Math.tan(fov / 2) / this.camera.aspect;
    const dist = Math.max(distH, distW) * 1.08;
    const c = this.center.clone();
    c.z = this.zCut;
    this.controls.target.copy(c);
    if (kind === 'section') this.camera.position.set(c.x, c.y, c.z + dist);
    else this.camera.position.set(c.x + dist * 0.45, c.y + dist * 0.45, c.z + dist * 0.8);
    this.controls.update();
  }

  /** Actualiza sol, cielo, rayos y marcador de penetración. */
  setSun(state, instant) {
    this.lastSun = { state, instant };
    if (!this.cfg) return;
    const s = new THREE.Vector3(state.s.x, state.s.y, state.s.z);
    const alt = state.altitude;

    // Cielo
    const bg = this.scene.background;
    if (alt <= -6) bg.copy(COLORS.skyNight);
    else if (alt < 0) bg.copy(COLORS.skyNight).lerp(COLORS.skyTwilight, (alt + 6) / 6);
    else if (alt < 10) bg.copy(COLORS.skyTwilight).lerp(COLORS.skyDay, alt / 10);
    else bg.copy(COLORS.skyDay);
    this.hemi.intensity = THREE.MathUtils.clamp(0.25 + (alt + 6) / 30, 0.25, 1.0);

    // Sol direccional
    const up = alt > 0;
    this.sun.visible = up;
    this.sun.intensity = up ? 0.6 + 2.6 * Math.min(1, state.dni / 900) : 0;
    this.sun.target.position.copy(this.center);
    this.sun.position.copy(this.center).addScaledVector(s, 150);
    this.sunDisc.visible = alt > -1;
    this.sunDisc.position.copy(this.center).addScaledVector(s, 140);

    this.updateRays(state.s);

    // Penetración
    const d = instant ? instant.depth : 0;
    const Wr = Math.max(this.cfg.room.width, this.cfg.room.windowWidth);
    if (d > 0.01) {
      const p = this.depthLine.geometry.attributes.position;
      p.setXYZ(0, d, 0.02, -Wr / 2);
      p.setXYZ(1, d, 0.02, Math.min(this.zCut, Wr / 2));
      p.needsUpdate = true;
      this.depthLine.visible = true;
      this.depthLabel.visible = true;
      this.depthLabel.position.set(d, 0.5, this.zCut);
      this.depthLabel.element.textContent = `${d.toFixed(2)} m`;
    } else {
      this.depthLine.visible = false;
      this.depthLabel.visible = false;
    }
  }

  updateRays(s) {
    const cfg = this.cfg;
    const pos = this.rays.geometry.attributes.position;
    const col = this.rays.geometry.attributes.color;
    let n = 0;
    const push = (a, b, c) => {
      pos.setXYZ(n, a.x, a.y, a.z);
      col.setXYZ(n, c.r, c.g, c.b);
      n++;
      pos.setXYZ(n, b.x, b.y, b.z);
      col.setXYZ(n, c.r, c.g, c.b);
      n++;
    };
    if (s.y > 0 && s.x < 0) {
      const { room, street, facade } = cfg;
      const dx = -s.x;
      const far = Math.min(60, (facade.wallThickness + street.separation + 14) / dx);
      const h = room.windowHeight - room.sillHeight;
      const z0 = Math.min(0, this.zCut);
      for (let i = 0; i < N_RAYS; i++) {
        const y = room.sillHeight + ((i + 0.5) * h) / N_RAYS;
        const P = { x: 0, y, z: z0 };
        const r = traceRay(cfg, s, y, z0, true);
        const F = { x: P.x + s.x * far, y: P.y + s.y * far, z: P.z + s.z * far };
        if (r.block) {
          push(F, r.block, COLORS.rayLit);
          if (r.hit) {
            push(r.block, P, COLORS.rayFiltered);
            push(P, r.hit, COLORS.rayFiltered);
          } else {
            push(r.block, P, COLORS.rayShade);
          }
        } else if (r.hit) {
          push(F, P, COLORS.rayLit);
          push(P, r.hit, COLORS.rayIn);
        }
      }
    }
    this.rays.geometry.setDrawRange(0, n);
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }
}

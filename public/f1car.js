// Procedural 2022-regulation F1 car. Units in metres, nose points to -Z, ground at y = 0.
// Built from lofted cross-sections (monocoque, sidepods, engine cover), airfoil extrusions
// (wings) and lathed tyres, so it reads as a real car without any third-party model.
(function () {
  'use strict';
  const T = () => window.THREE;

  // Superellipse ring: w/h half extents, n controls squareness (2 = ellipse, 4 = boxy)
  function ring(w, h, n, seg) {
    const pts = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      pts.push([Math.sign(c) * Math.pow(Math.abs(c), 2 / n) * w, Math.sign(s) * Math.pow(Math.abs(s), 2 / n) * h]);
    }
    return pts;
  }
  // Loft rings along z. sections: [{z, w, h, y, x, n, top}] -> closed tube with end caps.
  function loft(sections, seg) {
    const THREE = T(); seg = seg || 24;
    const pos = [], idx = [], uv = [];
    sections.forEach((S) => {
      let arc = 0, prev = null;
      ring(S.w, S.h, S.n || 3, seg).forEach(([x, y]) => {
        // "top" flattens the upper half (floor-hugging bodies), "bottom" flattens the lower
        let yy = y; if (S.flatBottom && y < 0) yy = y * 0.25;
        if (prev) arc += Math.hypot(x - prev[0], yy - prev[1]); prev = [x, yy];
        pos.push((S.x || 0) + x, S.y + yy, S.z); uv.push(arc, S.z);   // metres, so surface textures keep their real size
      });
    });
    for (let k = 0; k < sections.length - 1; k++) for (let i = 0; i < seg; i++) {
      const a = k * seg + i, b = k * seg + (i + 1) % seg, c = a + seg, d = b + seg;
      idx.push(a, c, b, b, c, d);
    }
    const capA = pos.length / 3, capB = capA + 1;
    const s0 = sections[0], s1 = sections[sections.length - 1];
    pos.push(s0.x || 0, s0.y, s0.z, s1.x || 0, s1.y, s1.z); uv.push(0, s0.z, 0, s1.z);
    for (let i = 0; i < seg; i++) {
      idx.push(capA, i, (i + 1) % seg);
      const o = (sections.length - 1) * seg; idx.push(capB, o + (i + 1) % seg, o + i);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
    return g;
  }
  /* 2x2 twill carbon: 8 x 8 tows per tile, each ~3.75 mm wide (the tile is 3 cm). A tow shows along one direction
     where it passes over two crossing tows, then dives under two; the pattern steps one tow per row (the twill
     diagonal). Each tow is drawn with its rounded cross-section lit from one side and its fibres along it; the
     normal map is the same rounded profile. Colour is near-black resin with slightly glossy grey fibres. */
  let weave = null;
  function weaveTex(THREE) {
    if (weave) return weave;
    const S = 256, n = 8, c = S / n, cv = document.createElement('canvas'), nv = document.createElement('canvas'); cv.width = cv.height = nv.width = nv.height = S;
    const g = cv.getContext('2d'), h = nv.getContext('2d'), img = h.createImageData(S, S);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const warp = ((i + j) % 4) < 2;
      for (let y = 0; y < c; y++) for (let x = 0; x < c; x++) {
        const t = warp ? x / c : y / c, bump = Math.sin(Math.PI * t), along = warp ? y : x;
        const v = 22 + 20 * bump + 4 * Math.sin(along * 1.9 + (warp ? i : j) * 3.1) * bump, px = (j * c + y) * S + (i * c + x);
        g.fillStyle = `rgb(${v | 0},${(v * 1.03) | 0},${(v * 1.1) | 0})`; g.fillRect(i * c + x, j * c + y, 1, 1);
        const d = Math.cos(Math.PI * t) * 0.8, nx = warp ? -d : 0, ny = warp ? 0 : -d, l = Math.hypot(nx, ny, 1);
        img.data[px * 4] = (nx / l * 0.5 + 0.5) * 255; img.data[px * 4 + 1] = (ny / l * 0.5 + 0.5) * 255; img.data[px * 4 + 2] = (1 / l * 0.5 + 0.5) * 255; img.data[px * 4 + 3] = 255;
      }
    }
    h.putImageData(img, 0, 0);
    const mk = (canvas, srgb) => { const t = new THREE.CanvasTexture(canvas); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1 / 0.03, 1 / 0.03); t.anisotropy = 8; if (srgb) t.encoding = THREE.sRGBEncoding; return t; };
    weave = { map: mk(cv, true), normal: mk(nv, false) };
    return weave;
  }
  // NACA-ish airfoil, extruded across the car (x axis). chord along z, thickness in y.
  function wing(span, chord, thick, camber) {
    const THREE = T(), sh = new THREE.Shape(), n = 14, up = [], lo = [];
    for (let i = 0; i <= n; i++) {
      const x = i / n, t = 5 * thick * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1015 * x ** 4);
      const yc = camber * 4 * x * (1 - x);
      up.push([x * chord, (yc + t) * chord]); lo.push([x * chord, (yc - t) * chord]);
    }
    sh.moveTo(up[0][0], up[0][1]); up.slice(1).forEach(p => sh.lineTo(p[0], p[1]));
    lo.reverse().forEach(p => sh.lineTo(p[0], p[1]));
    const g = new THREE.ExtrudeGeometry(sh, { depth: span, bevelEnabled: false, steps: 1 });
    g.translate(0, 0, -span / 2); g.rotateY(Math.PI / 2); // span along x, chord along -z..+z
    return g;
  }
  function tyreGeo(r, w, seg) {
    const THREE = T(), p = [], sw = w / 2, rr = 0.07;
    // rounded-rectangle profile: inner rim -> sidewall -> shoulder -> tread -> other side
    const rim = r * 0.62;
    p.push(new THREE.Vector2(rim, -sw));
    for (let i = 0; i <= 6; i++) { const a = -Math.PI / 2 + (i / 6) * (Math.PI / 2); p.push(new THREE.Vector2(r - rr + Math.cos(a) * rr, -sw + rr + Math.sin(a) * rr)); }
    for (let i = 0; i <= 6; i++) { const a = (i / 6) * (Math.PI / 2); p.push(new THREE.Vector2(r - rr + Math.cos(a) * rr, sw - rr + Math.sin(a) * rr)); }
    p.push(new THREE.Vector2(rim, sw));
    const g = new THREE.LatheGeometry(p, seg || 28); g.rotateZ(Math.PI / 2); // axle along x
    return g;
  }

  let shared = null;
  function mats(THREE) {
    if (shared) return shared;
    shared = {
      // lacquered carbon: the weave under a clear coat (sharp reflections on top, the fibres' sheen below)
      carbon: new THREE.MeshPhysicalMaterial({ color: 0xffffff, map: weaveTex(THREE).map, normalMap: weaveTex(THREE).normal, normalScale: new THREE.Vector2(0.35, 0.35),
        roughness: 0.42, metalness: 0.25, clearcoat: 0.85, clearcoatRoughness: 0.08, envMapIntensity: 0.9 }),
      // matte (unlacquered) carbon: the same weave, dull
      carbonMatte: new THREE.MeshStandardMaterial({ color: 0xcfcfcf, map: weaveTex(THREE).map, normalMap: weaveTex(THREE).normal, normalScale: new THREE.Vector2(0.5, 0.5), roughness: 0.72, metalness: 0.1 }),
      rubber: new THREE.MeshStandardMaterial({ color: 0x121212, roughness: 0.88, metalness: 0, envMapIntensity: 0.25 }),
      rim: new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.35, metalness: 0.85, envMapIntensity: 0.8 }),
      susp: new THREE.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.5, metalness: 0.4 }),
      glassDark: new THREE.MeshStandardMaterial({ color: 0x050607, roughness: 0.15, metalness: 0.2 }),
      rain: new THREE.MeshBasicMaterial({ color: 0xff2a1f }),
    };
    return shared;
  }

  // opts: {color, accent, cockpit(bool: driver's-eye extras), glowTex}
  window.buildF1Car = function (opts) {
    const THREE = T(), M = mats(THREE), g = new THREE.Group();
    const paint = new THREE.MeshPhysicalMaterial({ color: opts.color, metalness: 0.55, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 1.2 });
    const accent = new THREE.MeshPhysicalMaterial({ color: opts.accent != null ? opts.accent : 0xe8ecef, metalness: 0.3, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.08 });
    const add = (geo, mat, x, y, z, cast) => { const m = new THREE.Mesh(geo, mat); m.position.set(x || 0, y || 0, z || 0); m.castShadow = cast !== false; m.receiveShadow = true; g.add(m); return m; };

    // monocoque + nose + engine cover as one loft
    add(loft([
      { z: -3.05, w: 0.07, h: 0.05, y: 0.30, n: 2.4 },
      { z: -2.75, w: 0.13, h: 0.09, y: 0.31, n: 2.6 },
      { z: -2.2, w: 0.2, h: 0.14, y: 0.35, n: 2.8 },
      { z: -1.55, w: 0.27, h: 0.19, y: 0.41, n: 3 },
      { z: -1.0, w: 0.33, h: 0.24, y: 0.47, n: 3.2 },
      { z: -0.45, w: 0.38, h: 0.27, y: 0.5, n: 3.4 },
      { z: 0.3, w: 0.4, h: 0.28, y: 0.5, n: 3.4 },
      { z: 0.75, w: 0.36, h: 0.36, y: 0.58, n: 3 },
      { z: 1.35, w: 0.28, h: 0.33, y: 0.6, n: 2.8 },
      { z: 1.95, w: 0.17, h: 0.24, y: 0.55, n: 2.6 },
      { z: 2.35, w: 0.08, h: 0.13, y: 0.48, n: 2.4 },
    ], 28), paint, 0, 0, 0);
    // airbox / roll hoop above the driver's head with its dark intake
    add(loft([
      { z: 0.25, w: 0.1, h: 0.11, y: 0.93, n: 2.4 }, { z: 0.45, w: 0.13, h: 0.14, y: 0.93, n: 2.6 },
      { z: 0.95, w: 0.1, h: 0.14, y: 0.86, n: 2.6 }, { z: 1.5, w: 0.05, h: 0.1, y: 0.78, n: 2.4 },
    ], 20), paint, 0, 0, 0);
    add(new THREE.CircleGeometry(0.085, 20), M.glassDark, 0, 0.93, 0.249).rotation.y = Math.PI;
    // shark fin
    const fin = new THREE.Shape(); fin.moveTo(0, 0); fin.lineTo(1.25, 0); fin.lineTo(1.25, 0.12); fin.lineTo(0.2, 0.2); fin.closePath();
    const fg = new THREE.ExtrudeGeometry(fin, { depth: 0.012, bevelEnabled: false }); fg.rotateY(-Math.PI / 2);
    add(fg, paint, 0.006, 0.84, 0.95);
    const mirrors = [];
    // sidepods (downwashing, undercut), inlets
    for (const sx of [-1, 1]) {
      add(loft([
        { z: -0.55, w: 0.2, h: 0.17, y: 0.44, x: sx * 0.58, n: 3.6 },
        { z: -0.3, w: 0.26, h: 0.21, y: 0.43, x: sx * 0.6, n: 3.6 },
        { z: 0.5, w: 0.25, h: 0.2, y: 0.41, x: sx * 0.58, n: 3.4 },
        { z: 1.2, w: 0.17, h: 0.14, y: 0.34, x: sx * 0.46, n: 3 },
        { z: 1.75, w: 0.08, h: 0.08, y: 0.28, x: sx * 0.3, n: 2.6 },
      ], 20), paint, 0, 0, 0);
      const inlet = add(new THREE.PlaneGeometry(0.34, 0.2), M.glassDark, sx * 0.6, 0.45, -0.56, false); inlet.rotation.y = Math.PI;
      // halo-side mirrors
      add(new THREE.BoxGeometry(0.2, 0.08, 0.05), M.carbon, sx * 0.62, 0.74, -0.55);
      const glass = add(new THREE.PlaneGeometry(0.18, 0.064), M.glassDark, sx * 0.62, 0.74, -0.524, false); glass.userData.side = sx; mirrors.push(glass);
      add(new THREE.CylinderGeometry(0.012, 0.012, 0.16, 6), M.carbon, sx * 0.55, 0.66, -0.55).rotation.z = sx * 0.9;
    }
    // floor with edge wings and diffuser
    const floor = new THREE.Shape();
    floor.moveTo(-0.35, -1.25); floor.lineTo(-0.8, -0.7); floor.lineTo(-0.82, 1.55); floor.lineTo(-0.55, 2.3); floor.lineTo(0.55, 2.3); floor.lineTo(0.82, 1.55); floor.lineTo(0.8, -0.7); floor.lineTo(0.35, -1.25); floor.closePath();
    const flg = new THREE.ExtrudeGeometry(floor, { depth: 0.03, bevelEnabled: false }); flg.rotateX(Math.PI / 2);
    add(flg, M.carbon, 0, 0.09, 0);
    const dif = add(new THREE.BoxGeometry(1.0, 0.02, 0.45), M.carbonMatte, 0, 0.2, 2.42); dif.rotation.x = -0.6;
    // front wing: four stacked elements, endplates, nose pillars
    [[0, 0.1, 0.34, 0.07], [0.05, 0.15, 0.2, 0.12], [0.09, 0.2, 0.15, 0.16], [0.11, 0.25, 0.12, 0.2]].forEach(([dz, dy, ch, cam], i) => {
      const w1 = add(wing(1.95 - i * 0.04, ch, 0.09, cam), i === 3 ? accent : M.carbon, 0, 0.08 + dy * 0.55, -3.08 + dz + i * 0.07);
      w1.rotation.x = -0.08 - i * 0.1;
    });
    for (const sx of [-1, 1]) {
      const ep = new THREE.Shape(); ep.moveTo(0, 0); ep.lineTo(0.55, 0); ep.lineTo(0.5, 0.26); ep.lineTo(0.05, 0.22); ep.closePath();
      const eg = new THREE.ExtrudeGeometry(ep, { depth: 0.012, bevelEnabled: false }); eg.rotateY(-Math.PI / 2);
      add(eg, accent, sx * 0.985, 0.05, -3.12);
      add(new THREE.BoxGeometry(0.02, 0.14, 0.12), M.carbon, sx * 0.12, 0.2, -2.72);
    }
    // rear wing: mainplane + flap + endplates + beam wing + pylon
    add(wing(1.02, 0.36, 0.1, 0.1), M.carbon, 0, 0.84, 2.15).rotation.x = 0.18;
    add(wing(1.02, 0.2, 0.08, 0.12), accent, 0, 0.98, 2.26).rotation.x = 0.55;
    add(wing(0.9, 0.2, 0.1, 0.08), M.carbon, 0, 0.36, 2.3).rotation.x = 0.1;
    for (const sx of [-1, 1]) {
      const rp = new THREE.Shape(); rp.moveTo(0, 0); rp.lineTo(0.62, 0.05); rp.quadraticCurveTo(0.7, 0.55, 0.45, 0.78); rp.lineTo(0.05, 0.72); rp.closePath();
      const rg = new THREE.ExtrudeGeometry(rp, { depth: 0.014, bevelEnabled: false }); rg.rotateY(-Math.PI / 2);
      add(rg, paint, sx * 0.515 + 0.007, 0.36, 1.88);
    }
    add(new THREE.BoxGeometry(0.035, 0.42, 0.12), M.carbon, 0, 0.62, 2.12);

    // wheels: steering pivots for the fronts, rolling tyre+rim, 2022 wheel covers (the game adds the compound band and brake glow)
    const wheels = [], front = [];
    const mkWheel = (x, z, r, w, isFront) => {
      const pivot = new THREE.Group(); pivot.position.set(x, r, z); g.add(pivot);
      const roll = new THREE.Group(); pivot.add(roll);
      const tm = new THREE.Mesh(tyreGeo(r, w), M.rubber); tm.castShadow = true; roll.add(tm);
      const cover = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.6, r * 0.6, w * 0.96, 24), M.rim); cover.rotation.z = Math.PI / 2; roll.add(cover);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(r * 0.42, 20), paint); disc.rotation.y = Math.sign(x) * Math.PI / 2; disc.position.x = Math.sign(x) * (w * 0.49); roll.add(disc);
      wheels.push({ roll, r });
      if (isFront) front.push(pivot);
      // wishbones back to the chassis
      for (const [dy, dz] of [[0.08, -0.15], [0.08, 0.15], [-0.08, -0.12], [-0.08, 0.12]]) {
        const a = new THREE.Vector3(Math.sign(x) * 0.28, r + dy + 0.05, z + dz * 2.2), b = new THREE.Vector3(x - Math.sign(x) * 0.12, r + dy, z);
        const len = a.distanceTo(b), arm = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, len, 6), M.susp);
        arm.position.copy(a).add(b).multiplyScalar(0.5); arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()); g.add(arm);
      }
    };
    mkWheel(-0.8, -1.8, 0.36, 0.3, true); mkWheel(0.8, -1.8, 0.36, 0.3, true);
    mkWheel(-0.78, 1.62, 0.36, 0.4, false); mkWheel(0.78, 1.62, 0.36, 0.4, false);

    // rain light (flashes in the wet) with its glow
    const rl = add(new THREE.BoxGeometry(0.16, 0.08, 0.03), M.rain, 0, 0.42, 2.46, false);
    let rg = null;
    if (opts.glowTex) {
      rg = new THREE.Sprite(new THREE.SpriteMaterial({ map: opts.glowTex, color: 0xff3322, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: true }));
      rg.position.set(0, 0.42, 2.5); rg.scale.set(0.35, 0.35, 1); g.add(rg);
    }
    // driver's helmet (visible to other cars and the chase camera)
    if (!opts.cockpit) add(new THREE.SphereGeometry(0.14, 16, 12), accent, 0, 0.78, 0.05);

    // halo
    const hm = M.carbon;
    // Halo: the hoop's rear legs land on the chassis shoulders behind the cockpit opening (x ±0.34, on the tub's
    // top surface) and the centre pillar runs down onto the top of the chassis ahead of the cockpit, where it widens
    // into a faired foot, as on the real part; the mounting feet are bolted-on blocks.
    const halo = new THREE.CatmullRomCurve3([[-0.34, 0.74, 0.36], [-0.46, 0.98, 0.08], [-0.4, 1.19, -0.36], [0, 1.24, -0.56], [0.4, 1.19, -0.36], [0.46, 0.98, 0.08], [0.34, 0.74, 0.36]].map(p => new THREE.Vector3(...p)));
    // the halo frames the driver's view too: the hoop overhead and the centre pillar in front
    add(new THREE.TubeGeometry(halo, 48, 0.03, 12, false), opts.cockpit ? M.carbonMatte : hm, 0, 0, 0, !opts.cockpit);
    const pil = new THREE.CatmullRomCurve3([[0, 1.24, -0.56], [0, 1.12, -0.86], [0, 0.9, -1.08], [0, 0.66, -1.27]].map(p => new THREE.Vector3(...p)));
    add(new THREE.TubeGeometry(pil, 20, 0.03, 12, false), opts.cockpit ? M.carbonMatte : hm, 0, 0, 0, !opts.cockpit);
    const foot = add(new THREE.SphereGeometry(1, 16, 10), opts.cockpit ? M.carbonMatte : hm, 0, 0.65, -1.3, !opts.cockpit); foot.scale.set(0.07, 0.04, 0.16);
    for (const sx of [-1, 1]) add(new THREE.BoxGeometry(0.1, 0.05, 0.14), opts.cockpit ? M.carbonMatte : hm, sx * 0.34, 0.73, 0.37, !opts.cockpit);
    let cockpit = null;
    if (opts.cockpit) {
      // cockpit opening, padded headrest sides, and the steering wheel with its screen, shift lights, buttons, paddles
      const rim = add(new THREE.TorusGeometry(0.34, 0.035, 8, 30, Math.PI), M.carbonMatte, 0, 0.66, -0.2); rim.rotation.x = -Math.PI / 2; rim.rotation.z = Math.PI;
      const pad = new THREE.MeshStandardMaterial({ color: 0x1b1d22, roughness: 0.9 });
      for (const sx of [-1, 1]) add(new THREE.BoxGeometry(0.1, 0.16, 0.42), pad, sx * 0.25, 0.72, 0.18, false);
      // what frames a real onboard view: the cockpit coaming (the tub's rolled top edge) running forward on both
      // sides to the front of the opening, the padded side protection inside it, and the driver's forearms in the
      // race suit reaching to the wheel
      const suit = new THREE.MeshStandardMaterial({ color: opts.color, roughness: 0.85 });
      for (const sx of [-1, 1]) {
        const edge = new THREE.CatmullRomCurve3([[0.35, 0.76, 0.34], [0.34, 0.785, 0.0], [0.3, 0.765, -0.4], [0.2, 0.72, -0.66], [0, 0.705, -0.74]].map(([x, y, z]) => new THREE.Vector3(sx * x, y, z)));
        add(new THREE.TubeGeometry(edge, 30, 0.035, 8, false), M.carbon, 0, 0, 0, false);
        const side = add(new THREE.BoxGeometry(0.07, 0.12, 0.5), pad, sx * 0.29, 0.71, -0.22, false); side.rotation.y = sx * 0.12;
        const a = new THREE.Vector3(sx * 0.155, 0.705, -0.33), b = new THREE.Vector3(sx * 0.27, 0.6, 0.02);
        const arm = add(new THREE.CylinderGeometry(0.038, 0.046, a.distanceTo(b), 10), suit, 0, 0, 0, false);
        arm.position.copy(a).add(b).multiplyScalar(0.5); arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      }
      const sw = new THREE.Group(); sw.position.set(0, 0.745, -0.37); g.add(sw);
      const tilt = new THREE.Group(); tilt.rotation.x = -0.45; sw.add(tilt);            // face tipped up towards the eyes
      const body = new THREE.Shape(), bw = 0.13, bh = 0.07;
      body.moveTo(-bw, -bh * 0.4); body.lineTo(-bw, bh * 0.55); body.quadraticCurveTo(-bw, bh, -bw + 0.03, bh); body.lineTo(bw - 0.03, bh);
      body.quadraticCurveTo(bw, bh, bw, bh * 0.55); body.lineTo(bw, -bh * 0.4); body.quadraticCurveTo(bw * 0.9, -bh, bw * 0.55, -bh); body.lineTo(-bw * 0.55, -bh);
      body.quadraticCurveTo(-bw * 0.9, -bh, -bw, -bh * 0.4);
      const bg = new THREE.ExtrudeGeometry(body, { depth: 0.028, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 2 }); bg.translate(0, 0, -0.028);
      const part = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); tilt.add(m); return m; };
      part(bg, M.carbon, 0, 0, 0);
      const grip = new THREE.MeshStandardMaterial({ color: 0x0c0c0d, roughness: 0.95 });
      for (const sx of [-1, 1]) {
        part(new THREE.CylinderGeometry(0.024, 0.026, 0.13, 12), grip, sx * 0.14, -0.005, -0.012);
        part(new THREE.BoxGeometry(0.05, 0.1, 0.004), M.carbonMatte, sx * 0.075, 0.0, -0.045).rotation.y = sx * 0.2;   // shift paddles
        // gloves around the grips, fingers over the front
        const glove = new THREE.MeshStandardMaterial({ color: 0x161a21, roughness: 0.85 }); glove.userData.noEnv = true; const cuff = new THREE.MeshStandardMaterial({ color: opts.color, roughness: 0.7 });
        const palm = part(new THREE.SphereGeometry(0.038, 12, 10), glove, sx * 0.145, 0.0, 0.0); palm.scale.set(0.9, 1.35, 0.85);
        const thumb = part(new THREE.SphereGeometry(0.013, 8, 6), glove, sx * 0.118, 0.036, 0.018); thumb.scale.set(1, 1.8, 1); thumb.rotation.z = sx * 0.6;
        const band = part(new THREE.CylinderGeometry(0.03, 0.03, 0.022, 12), cuff, sx * 0.16, -0.05, -0.01); band.rotation.z = sx * 0.25;
      }
      // buttons and rotaries around the screen
      const btn = [0xd63a2c, 0xf2c230, 0x2f7de0, 0x33b35a, 0xe8e8e8, 0xff7a2a];
      btn.forEach((c, i) => { const col = i % 2 ? 1 : -1, row = Math.floor(i / 2);
        part(new THREE.CylinderGeometry(0.007, 0.007, 0.006, 10), new THREE.MeshStandardMaterial({ color: c, roughness: 0.4, emissive: c, emissiveIntensity: 0.15 }), col * 0.1, 0.035 - row * 0.03, 0.009).rotation.x = Math.PI / 2; });
      for (const sx of [-1, 1]) part(new THREE.CylinderGeometry(0.012, 0.012, 0.012, 14), M.rim, sx * 0.045, -0.052, 0.011).rotation.x = Math.PI / 2;
      // the screen and the shift lights above it are drawn by the game into a canvas texture
      const cv = document.createElement('canvas'); cv.width = 320; cv.height = 160;
      const tex = new THREE.CanvasTexture(cv); tex.encoding = THREE.sRGBEncoding; tex.anisotropy = 4;
      part(new THREE.PlaneGeometry(0.15, 0.075), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }), 0, 0.012, 0.0075);
      cockpit = { wheel: sw, canvas: cv, tex };
    }
    g.userData = { rain: rl && rg ? [rl, rg] : null, front, wheels, mirrors, cockpit };
    return g;
  };
})();

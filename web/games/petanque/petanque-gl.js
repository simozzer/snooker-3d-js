// petanque-gl.js — a hand-rolled WebGL2 renderer for the pétanque piste. Zero dependencies: the matrix
// math, meshes, textures, lighting and the L.S.-Lowry crowd of matchstick figures are all built here from
// scratch. The GAME (physics, turns, AI) lives in petanque.js and stays in 2D "plan" coordinates
// (x:0..W, y:0..H); this module only draws that state in 3D and turns pointer rays back into plan coords.
//
// World mapping: plan (x,y) → 3D (X = x - W/2, Y = up, Z = y - H/2). Ground is the plane Y=0. The camera
// sits behind the near edge (the throwing circle) and looks across the piste toward the jack and the crowd.

// Plan-pixels → centimetres for the on-piste distance readouts. Anchored to real kit: a boule is ~74mm
// across and is drawn 26px across (2·R, R=13), so 7.4cm / 26px ≈ 0.285 cm/px. This keeps boule, jack and
// distance numbers all in the same, realistic scale (a boule reads ~7cm, a jack ~3cm, near boules ~10–40cm).
const CM_PER_PX = 0.285;

// ---- tiny mat4 / vec3 (column-major, WebGL order) --------------------------------------------------
const V = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
};
const M = {
  mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  },
  perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  },
  lookAt(eye, ctr, up) {
    const z = V.norm(V.sub(eye, ctr)), x = V.norm(V.cross(up, z)), y = V.cross(z, x);
    return new Float32Array([
      x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
      -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]),
      -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]),
      -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]), 1,
    ]);
  },
  model(tx, ty, tz, s) {  // translate + uniform scale
    return new Float32Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, tx, ty, tz, 1]);
  },
  identity() { return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); },
  // rotation about an arbitrary (world) axis, column-major
  axisAngle(ax, ay, az, ang) {
    const l = Math.hypot(ax, ay, az) || 1; const x = ax / l, y = ay / l, z = az / l;
    const c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
    return new Float32Array([
      c + x * x * t, y * x * t + z * s, z * x * t - y * s, 0,
      x * y * t - z * s, c + y * y * t, z * y * t + x * s, 0,
      x * z * t + y * s, y * z * t - x * s, c + z * z * t, 0,
      0, 0, 0, 1,
    ]);
  },
  // translate * rotation * uniform-scale — lets a mesh spin in place as it rolls/tumbles
  composed(tx, ty, tz, s, rot) {
    return new Float32Array([
      rot[0] * s, rot[1] * s, rot[2] * s, 0,
      rot[4] * s, rot[5] * s, rot[6] * s, 0,
      rot[8] * s, rot[9] * s, rot[10] * s, 0,
      tx, ty, tz, 1,
    ]);
  },
  invert(m) {
    const a = m, o = new Float32Array(16);
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return o; det = 1 / det;
    o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return o;
  },
  // project a world point through viewProj → clip → returns {x,y (NDC -1..1), w}
  project(vp, p) {
    const x = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12];
    const y = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
    const w = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
    return { x: x / w, y: y / w, w };
  },
};

// ---- GL helpers ------------------------------------------------------------------------------------
function sh(gl, type, src) {
  const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src);
  return s;
}
function prog(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl, gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}
function tex(gl, src) {
  const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  return t;
}

// ---- procedural canvases (textures) ----------------------------------------------------------------
function cvs(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

// Gravel piste. Rendered at high resolution with per-stone RELIEF — each pebble gets a drop shadow
// (down-right), a coloured body, and a top-left highlight, lit to match the scene light — so up close
// (the overhead pan) it reads as real 3D grit rather than flat speckle. Tiles seamlessly (REPEAT), and
// with thousands of randomly-placed stones the repeat isn't legible as a pattern.
function gravelTex() {
  const S = 1024, c = cvs(S, S), g = c.getContext('2d');
  g.fillStyle = '#ab8c5e'; g.fillRect(0, 0, S, S);
  // a scatter of stones in four size/tone classes, densest at the small end
  const stones = 16000;
  for (let i = 0; i < stones; i++) {
    const x = Math.random() * S, y = Math.random() * S, t = Math.random();
    const s = t < 0.7 ? 0.7 + Math.random() * 1.6 : t < 0.93 ? 2 + Math.random() * 2.4 : 3.5 + Math.random() * 3;
    const u = Math.random();
    const body = u < 0.4 ? [96, 78, 50] : u < 0.72 ? [156, 132, 95] : u < 0.9 ? [212, 194, 158] : [66, 50, 32];
    g.fillStyle = 'rgba(38,28,16,0.33)';                          // shadow, offset toward the light-away corner
    g.beginPath(); g.arc(x + s * 0.45, y + s * 0.5, s, 0, 7); g.fill();
    g.fillStyle = `rgb(${body[0]},${body[1]},${body[2]})`;        // the stone
    g.beginPath(); g.arc(x, y, s, 0, 7); g.fill();
    if (s > 1.6) {                                                // catch-light on bigger stones (top-left)
      g.fillStyle = 'rgba(255,247,226,0.5)';
      g.beginPath(); g.arc(x - s * 0.34, y - s * 0.34, s * 0.4, 0, 7); g.fill();
    }
  }
  // fine sand grain between the stones
  for (let i = 0; i < 26000; i++) { const x = Math.random() * S, y = Math.random() * S;
    g.fillStyle = Math.random() < 0.5 ? 'rgba(255,240,210,0.09)' : 'rgba(52,40,24,0.11)';
    g.fillRect(x, y, 1, 1);
  }
  return c;
}
function softDisc(col = '0,0,0') {
  const c = cvs(128, 128), g = c.getContext('2d'), grd = g.createRadialGradient(64, 64, 2, 64, 64, 62);
  grd.addColorStop(0, `rgba(${col},0.9)`); grd.addColorStop(0.6, `rgba(${col},0.5)`); grd.addColorStop(1, `rgba(${col},0)`);
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128); return c;
}
function smokeTex() {
  const c = cvs(64, 64), g = c.getContext('2d'), grd = g.createRadialGradient(32, 32, 1, 32, 32, 31);
  grd.addColorStop(0, 'rgba(225,225,225,0.55)'); grd.addColorStop(0.5, 'rgba(210,210,210,0.28)'); grd.addColorStop(1, 'rgba(200,200,200,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64); return c;
}

// A soft ring band, used for impact shock-waves and the holding-point marker. The band is kept fat and
// bright so it survives mipmapping when the billboard is drawn small on screen.
function ringTex() {
  const c = cvs(128, 128), g = c.getContext('2d'), grd = g.createRadialGradient(64, 64, 16, 64, 64, 62);
  grd.addColorStop(0, 'rgba(255,255,255,0)'); grd.addColorStop(0.42, 'rgba(255,255,255,0)');
  grd.addColorStop(0.72, 'rgba(255,255,255,1)'); grd.addColorStop(0.88, 'rgba(255,255,255,0.7)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128); return c;
}

// The player's boule finish — a lawn-bowls-style distinguishing mark: one band, two parallel bands, a
// smooth (plain) ball, or an all-over dotted ball. It reads from any angle regardless of colour, so it's
// the accessibility cue. Bands are latitude stripes across the texture → parallel rings around the boule.
function drawPattern(g, kind) {
  const dark = 'rgba(16,24,34,0.85)', lip = 'rgba(255,255,255,0.5)';
  if (kind === 'band1' || kind === 'band2') {
    const rows = kind === 'band1' ? [[128, 40]] : [[92, 22], [164, 22]];
    for (const [cy, h] of rows) {
      g.fillStyle = lip; g.fillRect(0, cy - h / 2 - 2, 256, h + 4);   // bright lip around the band
      g.fillStyle = dark; g.fillRect(0, cy - h / 2, 256, h);          // the dark band itself
    }
  } else if (kind === 'dots') {
    for (let row = 0; row < 6; row++) { const cy = 22 + row * 42, off = (row % 2) * 24;
      for (let cx = off; cx <= 256; cx += 48) {
        g.fillStyle = lip; g.beginPath(); g.arc(cx, cy, 10, 0, 7); g.fill();
        g.fillStyle = dark; g.beginPath(); g.arc(cx, cy, 8, 0, 7); g.fill();
      }
    }
  }
  // 'smooth' (or the jack, with no pattern): nothing — just the plain machined-steel finish
}

// A machined-steel boule skin, tinted to the team, finished with the team's distinguishing mark
// (bands / smooth / dots) so boules are told apart by finish as well as colour.
function bouleTex(base, pattern) {
  const n = parseInt(base.slice(1), 16), br = n >> 16 & 255, bg = n >> 8 & 255, bb = n & 255;
  const mix = (r, g, b, t) => `rgb(${Math.round(br + (r - br) * t)},${Math.round(bg + (g - bg) * t)},${Math.round(bb + (b - bb) * t)})`;
  const c = cvs(256, 256), g = c.getContext('2d');
  // vertical gradient = soft top-lit sheen baked into the metal
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, mix(255, 255, 255, 0.55)); grd.addColorStop(0.42, mix(255, 255, 255, 0.12));
  grd.addColorStop(0.6, base); grd.addColorStop(1, mix(0, 0, 0, 0.55));
  g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
  // machined latitude grooves — a dark cut with a bright lip above it
  for (let y = 12; y < 256; y += 18) {
    g.strokeStyle = 'rgba(0,0,0,0.32)'; g.lineWidth = 2; g.beginPath(); g.moveTo(0, y); g.lineTo(256, y); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.16)'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, y - 2); g.lineTo(256, y - 2); g.stroke();
  }
  // fine steel speckle
  for (let i = 0; i < 1400; i++) { const x = Math.random() * 256, y = Math.random() * 256;
    g.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)';
    g.fillRect(x, y, 1.5, 1.5); }
  drawPattern(g, pattern); // the player's distinguishing finish (bands / smooth / dots)
  return c;
}

// A distant backdrop: soft plane-trees + a low stone wall, transparent above so the sky shows through.
function backdropTex() {
  const c = cvs(1024, 256), g = c.getContext('2d');
  g.clearRect(0, 0, 1024, 256);
  // plane-tree canopy blobs
  for (let i = 0; i < 60; i++) {
    const x = Math.random() * 1024, y = 60 + Math.random() * 70, r = 26 + Math.random() * 46;
    const t = Math.random(); g.fillStyle = t < 0.5 ? '#4f6a42' : t < 0.8 ? '#5f7a4e' : '#42563a';
    g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
  }
  // trunks
  g.fillStyle = '#5a4b3a'; for (let i = 0; i < 12; i++) { const x = 40 + i * 86 + (Math.random() - 0.5) * 30; g.fillRect(x, 120, 7, 70); }
  // low stone wall
  g.fillStyle = '#9a8f7d'; g.fillRect(0, 176, 1024, 44);
  g.fillStyle = 'rgba(60,52,40,.35)'; for (let i = 0; i < 1024; i += 34) g.fillRect(i, 176, 2, 44);
  for (let y = 176; y < 220; y += 15) { g.fillRect(0, y, 1024, 2); }
  return c;
}

// One L.S.-Lowry matchstick figure: flat, dark, spindly, in a muted northern palette. `raise` (0..1) lifts
// the working hand to the mouth (smoke/drink/eat) or the brow (watch). Drawn facing the viewer.
function lowryFrame(opts) {
  const w = 96, h = 200, c = cvs(w, h), g = c.getContext('2d');
  const { coat, hat, action, raise = 0, watch = false, prop = coat } = opts;
  const cx = w / 2, feet = h - 6, hip = h * 0.56, sh0 = h * 0.30, head = h * 0.20, hr = 12;
  g.lineCap = 'round'; g.lineJoin = 'round';
  // legs
  g.strokeStyle = '#1c1c22'; g.lineWidth = 6;
  g.beginPath(); g.moveTo(cx - 5, hip); g.lineTo(cx - 8, feet); g.moveTo(cx + 5, hip); g.lineTo(cx + 9, feet); g.stroke();
  // coat (tapered body)
  g.fillStyle = coat; g.beginPath();
  g.moveTo(cx - 12, sh0); g.lineTo(cx + 12, sh0); g.lineTo(cx + 9, hip + 6); g.lineTo(cx - 9, hip + 6); g.closePath(); g.fill();
  // far arm (behind), resting
  g.strokeStyle = coat; g.lineWidth = 6;
  g.beginPath(); g.moveTo(cx - 10, sh0 + 4); g.lineTo(cx - 15, hip - 6); g.stroke();
  // working arm — elbow at shoulder, hand interpolates from hip to mouth/brow
  const mouth = watch ? [cx + 8, head - 2] : [cx + 4, head + hr - 2];
  const rest = [cx + 15, hip - 4];
  const hx = rest[0] + (mouth[0] - rest[0]) * raise, hy = rest[1] + (mouth[1] - rest[1]) * raise;
  const elbow = [cx + 13, sh0 + 20];
  g.strokeStyle = coat; g.lineWidth = 6;
  g.beginPath(); g.moveTo(cx + 10, sh0 + 4); g.lineTo(elbow[0], elbow[1]); g.lineTo(hx, hy); g.stroke();
  // hand prop
  if (action === 'drink' && raise > 0.15) { g.fillStyle = '#c9b48c'; g.fillRect(hx - 4, hy - 6, 8, 10); }
  if (action === 'eat' && raise > 0.2) { g.fillStyle = '#e8dcc0'; g.beginPath(); g.arc(hx, hy, 3.5, 0, 7); g.fill(); }
  if (action === 'smoke' && raise > 0.3) {
    g.strokeStyle = '#eee'; g.lineWidth = 2; g.beginPath(); g.moveTo(hx, hy); g.lineTo(hx + 5, hy - 4); g.stroke();
    g.fillStyle = '#ff7043'; g.beginPath(); g.arc(hx + 6, hy - 5, 1.6, 0, 7); g.fill();
  }
  // head + face
  g.fillStyle = '#e7c5a0'; g.beginPath(); g.arc(cx, head, hr, 0, 7); g.fill();
  // hat
  g.fillStyle = hat;
  if (hat) { g.beginPath(); g.ellipse(cx, head - hr + 4, hr + 3, 5, 0, 0, 7); g.fill(); g.fillRect(cx - hr + 1, head - hr - 4, 2 * hr - 2, 8); }
  // a dab of colour on some — scarf
  if (prop && Math.random < 0) {/* noop, keep deterministic */}
  return c;
}

// Advance a body's baked-in orientation so the textured sphere visibly rolls on the ground (angle =
// distance / radius) and tumbles forward through the air. The roll axis is horizontal, square to travel.
function advanceSpin(b, dt) {
  if (!b._orient) b._orient = M.identity();
  let tx = 0, tz = 0, ang = 0;
  if (b.state === 'air') { tx = b.to.x - b.from.x; tz = b.to.y - b.from.y; ang = dt * 7.5; }
  else { const sp = Math.hypot(b.vx || 0, b.vy || 0); if (sp > 1.2) { tx = b.vx; tz = b.vy; ang = sp * dt / (b.r || 12); } }
  if (ang) {
    const axis = V.norm(V.cross([0, 1, 0], [tx, 0, tz]));
    b._orient = M.mul(M.axisAngle(axis[0], axis[1], axis[2], ang), b._orient);
  }
}

// ---- the renderer ----------------------------------------------------------------------------------
export function createPetanqueRenderer(glCanvas, overlay, opts) {
  const { W, H, P, THROW, R, JACK_R, TEAM } = opts;
  const gl = glCanvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error('WebGL2 unavailable');
  const octx = overlay.getContext('2d');

  // programs
  const litVS = `#version 300 es
    layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNormal; layout(location=2) in vec2 aUV;
    uniform mat4 uViewProj, uModel; out vec3 vN, vW; out vec2 vUV;
    void main(){ vec4 w=uModel*vec4(aPos,1.0); vW=w.xyz; vN=normalize(mat3(uModel)*aNormal); vUV=aUV; gl_Position=uViewProj*w; }`;
  const litFS = `#version 300 es
    precision highp float; in vec3 vN, vW; in vec2 vUV; out vec4 frag;
    uniform vec3 uLightDir, uCam, uColor; uniform sampler2D uTex;
    uniform float uUseTex, uSpec, uAmb, uAlpha, uUVScale;
    void main(){
      vec3 N=normalize(vN), L=normalize(-uLightDir);
      float diff=max(dot(N,L),0.0);
      vec3 base=mix(uColor, texture(uTex, vUV*uUVScale).rgb, uUseTex);
      vec3 col=base*(uAmb+(1.0-uAmb)*diff);
      if(uSpec>0.0){ vec3 Vv=normalize(uCam-vW), Hh=normalize(L+Vv);
        col+=vec3(1.0)*pow(max(dot(N,Hh),0.0),42.0)*uSpec;
        col+=base*pow(1.0-max(dot(N,Vv),0.0),3.0)*0.22; }
      frag=vec4(col,uAlpha);
    }`;
  const bbVS = `#version 300 es
    layout(location=0) in vec2 aCorner; uniform mat4 uViewProj;
    uniform vec3 uCenter,uRight,uUp; uniform vec2 uSize; out vec2 vUV;
    void main(){ vUV=vec2(aCorner.x+0.5, 0.5-aCorner.y);
      vec3 wp=uCenter+aCorner.x*uSize.x*uRight+aCorner.y*uSize.y*uUp; gl_Position=uViewProj*vec4(wp,1.0); }`;
  const bbFS = `#version 300 es
    precision highp float; in vec2 vUV; out vec4 frag; uniform sampler2D uTex; uniform float uAlpha; uniform vec3 uTint;
    void main(){ vec4 t=texture(uTex,vUV); frag=vec4(t.rgb*uTint, t.a*uAlpha); }`;
  const skyVS = `#version 300 es
    layout(location=0) in vec2 aPos; out vec2 vUV; void main(){ vUV=aPos*0.5+0.5; gl_Position=vec4(aPos,0.999,1.0); }`;
  const skyFS = `#version 300 es
    precision highp float; in vec2 vUV; out vec4 frag; uniform vec3 uTop,uBot;
    void main(){ frag=vec4(mix(uBot,uTop,pow(vUV.y,0.7)),1.0); }`;

  const litP = prog(gl, litVS, litFS), bbP = prog(gl, bbVS, bbFS), skyP = prog(gl, skyVS, skyFS);
  const U = (p, names) => { const o = {}; for (const n of names) o[n] = gl.getUniformLocation(p, n); return o; };
  const litU = U(litP, ['uViewProj', 'uModel', 'uLightDir', 'uCam', 'uColor', 'uTex', 'uUseTex', 'uSpec', 'uAmb', 'uAlpha', 'uUVScale']);
  const bbU = U(bbP, ['uViewProj', 'uCenter', 'uRight', 'uUp', 'uSize', 'uTex', 'uAlpha', 'uTint']);
  const skyU = U(skyP, ['uTop', 'uBot']);

  // meshes
  function vao(setup) { const a = gl.createVertexArray(); gl.bindVertexArray(a); setup(); gl.bindVertexArray(null); return a; }
  function buf(loc, data, size) {
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }
  // sphere
  const SP = (() => {
    const pos = [], nor = [], uv = [], idx = [], la = 20, lo = 28;
    for (let i = 0; i <= la; i++) { const th = i / la * Math.PI, st = Math.sin(th), ct = Math.cos(th);
      for (let j = 0; j <= lo; j++) { const ph = j / lo * 2 * Math.PI, sp = Math.sin(ph), cp = Math.cos(ph);
        const x = st * cp, y = ct, z = st * sp; pos.push(x, y, z); nor.push(x, y, z); uv.push(j / lo, i / la); } }
    for (let i = 0; i < la; i++) for (let j = 0; j < lo; j++) { const a = i * (lo + 1) + j, b = a + lo + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1); }
    const va = vao(() => { buf(0, pos, 3); buf(1, nor, 3); buf(2, uv, 2);
      const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW); });
    return { va, n: idx.length };
  })();
  // ground plane (XZ), big, uv for tiling
  const GROUND = (() => {
    const gw = W * 1.6, gd = H * 2.2, z1 = -H * 1.4, z2 = H * 0.9;
    const pos = [-gw, 0, z1, gw, 0, z1, gw, 0, z2, -gw, 0, z1, gw, 0, z2, -gw, 0, z2];
    const nor = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
    const uv = [0, 0, 6, 0, 6, 9, 0, 0, 6, 9, 0, 9];
    return vao(() => { buf(0, pos, 3); buf(1, nor, 3); buf(2, uv, 2); });
  })();
  const QUAD = vao(() => buf(0, [-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5], 2)); // corners
  const FS = vao(() => buf(0, [-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1], 2)); // fullscreen

  // textures
  const T = {
    gravel: tex(gl, gravelTex()), shadow: tex(gl, softDisc('30,24,14')), smoke: tex(gl, smokeTex()),
    backdrop: tex(gl, backdropTex()), glow: tex(gl, softDisc('255,255,255')),
    dust: tex(gl, softDisc('176,150,104')),
    boule: TEAM.map((t) => tex(gl, bouleTex(t.fill[1], t.pattern))), // one textured skin per player (colour + pattern)
    jack: tex(gl, bouleTex('#e8481f')), ring: tex(gl, ringTex()),    // bright cochonnet red-orange — pops off the tan gravel; no player emblem
  };

  // transient particles: flight trails behind airborne boules, landing-dust puffs, impact shock-rings
  const trails = [], groundDust = [], sparks = [];

  // ---- the crowd -----------------------------------------------------------------------------------
  const ACTIONS = ['smoke', 'drink', 'eat', 'chat'];
  const COATS = ['#2a2f3a', '#3a2f28', '#33383f', '#2c3a30', '#3f2f33', '#26303c'];
  const HATS = ['#15161b', '#20222a', '#2a1f18', ''];
  const RAISE = [0, 0.35, 0.7, 1, 1, 0.7, 0.35, 0]; // hand up-hold-down over 8 frames
  const crowd = [];
  (function buildCrowd() {
    // a loose knot of folk beyond the far edge — scattered over two rough rows, mostly smoking & drinking
    const n = 12, farZ = -H / 2 - 26;
    const bag = ['smoke', 'smoke', 'smoke', 'drink', 'drink', 'eat', 'chat', 'chat'];
    for (let i = 0; i < n; i++) {
      const action = bag[(Math.random() * bag.length) | 0];
      const coat = COATS[(Math.random() * COATS.length) | 0], hat = HATS[(Math.random() * HATS.length) | 0];
      const x = (Math.random() - 0.5) * 680;
      const z = farZ - (i % 2) * 66 - Math.random() * 46;   // two loose depth bands
      const scale = 126 + Math.random() * 32;
      // precompute 8 action frames + 1 watch frame, as textures
      const frames = RAISE.map((r) => tex(gl, lowryFrame({ coat, hat, action, raise: action === 'chat' ? 0.1 + 0.12 * r : r })));
      const watchTex = tex(gl, lowryFrame({ coat, hat, action, raise: 0.9, watch: true }));
      crowd.push({ x, z, action, scale, frames, watchTex, phase: Math.random(), speed: 0.1 + Math.random() * 0.16,
        watch: 0, puff: Math.random() * 1.5, wob: Math.random() * 6 });
    }
    crowd.sort((a, b) => a.z - b.z); // back-to-front for alpha
  })();
  const puffs = [];
  function react() { // called on a throw / a settle: a few heads turn to the game for a spell
    for (const f of crowd) if (Math.random() < 0.6) f.watch = 1.6 + Math.random() * 1.8;
  }

  // ---- camera --------------------------------------------------------------------------------------
  let vp = M.perspective(1, 1, 1, 1), camPos = [0, 300, 470], camCtr = [0, 18, -30], t = 0, shake = 0;
  // Between shots the game asks for a bird's-eye look at the jack (to show what's nearest), then eases back.
  // `over` is the live 0→1 blend toward the overhead pose; `overTarget` is where the game wants it.
  let over = 0, overTarget = 0, overFocus = [0, 0, -30];
  function setOverhead(on, focus) {
    overTarget = on ? 1 : 0;
    if (focus) overFocus = [focus.x - W / 2, 0, focus.y - H / 2];
  }
  const lerp = (a, b, k) => a + (b - a) * k;
  function updateCamera(dt) {
    t += dt;
    shake = Math.max(0, shake - dt * 2.4); // impact shake decays back to the steady drift
    // ease toward the target pose — pan up briskly, drift back down slowly so play resumes gently
    over += (overTarget - over) * Math.min(1, dt * (overTarget > over ? 2.7 : 1.9));
    const e = over * over * (3 - 2 * over); // smoothstep: no hard start/stop on the swing
    const sway = Math.sin(t * 0.12) * 26;
    const sx = (Math.random() - 0.5) * shake * 26, sy = (Math.random() - 0.5) * shake * 15;
    // the two poses we blend between: the low play camera behind the circle, and a high look straight over the jack
    const playEye = [sway + sx, 292 + Math.sin(t * 0.09) * 8 + sy, 486], playCtr = [0, 18, -30];
    const overEye = [overFocus[0], 500, overFocus[2] + 170], overCtr = [overFocus[0], 0, overFocus[2]];
    camPos = [lerp(playEye[0], overEye[0], e), lerp(playEye[1], overEye[1], e), lerp(playEye[2], overEye[2], e)];
    camCtr = [lerp(playCtr[0], overCtr[0], e), lerp(playCtr[1], overCtr[1], e), lerp(playCtr[2], overCtr[2], e)];
    const proj = M.perspective(40 * Math.PI / 180, glCanvas.width / glCanvas.height, 1, 4000);
    vp = M.mul(proj, M.lookAt(camPos, camCtr, [0, 1, 0]));
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = glCanvas.getBoundingClientRect();
    const w = Math.max(2, Math.round(r.width * dpr)), h = Math.max(2, Math.round(r.height * dpr));
    if (glCanvas.width !== w || glCanvas.height !== h) { glCanvas.width = w; glCanvas.height = h; }
    overlay.width = w; overlay.height = h; overlay.style.width = r.width + 'px'; overlay.style.height = r.height + 'px';
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { r, dpr };
  }

  // world helpers ------------------------------------------------------------------------------------
  const toWorld = (x, y, h = 0) => [x - W / 2, h, y - H / 2];
  function screenToGround(clientX, clientY) {
    const r = glCanvas.getBoundingClientRect();
    const nx = (clientX - r.left) / r.width * 2 - 1, ny = 1 - (clientY - r.top) / r.height * 2;
    const inv = M.invert(vp);
    const near = mulPt(inv, [nx, ny, -1]), far = mulPt(inv, [nx, ny, 1]);
    const dir = V.sub(far, near); const t2 = -near[1] / dir[1];
    const hit = [near[0] + dir[0] * t2, 0, near[2] + dir[2] * t2];
    return { x: hit[0] + W / 2, y: hit[2] + H / 2 };
  }
  function mulPt(m, p) { // full perspective divide
    const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14], w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    return [x / w, y / w, z / w];
  }
  function worldToScreen(x, y, h, r, dpr) { // → CSS px in overlay space
    const p = M.project(vp, toWorld(x, y, h));
    return { x: (p.x * 0.5 + 0.5) * r.width, y: (1 - (p.y * 0.5 + 0.5)) * r.height, w: p.w };
  }

  // ---- draw ----------------------------------------------------------------------------------------
  function drawMesh(va, n, model, { color = [1, 1, 1], useTex = 0, texId = null, spec = 0, amb = 0.5, alpha = 1, uv = 1 }) {
    gl.useProgram(litP);
    gl.uniformMatrix4fv(litU.uViewProj, false, vp); gl.uniformMatrix4fv(litU.uModel, false, model);
    gl.uniform3fv(litU.uLightDir, [-0.35, -1, -0.35]); gl.uniform3fv(litU.uCam, camPos);
    gl.uniform3fv(litU.uColor, color); gl.uniform1f(litU.uUseTex, useTex); gl.uniform1f(litU.uSpec, spec);
    gl.uniform1f(litU.uAmb, amb); gl.uniform1f(litU.uAlpha, alpha); gl.uniform1f(litU.uUVScale, uv);
    if (texId) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texId); gl.uniform1i(litU.uTex, 0); }
    gl.bindVertexArray(va);
    if (n) gl.drawElements(gl.TRIANGLES, n, gl.UNSIGNED_SHORT, 0); else gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }
  function drawBillboard(texId, center, size, { up, right, tint = [1, 1, 1], alpha = 1 }) {
    gl.useProgram(bbP);
    gl.uniformMatrix4fv(bbU.uViewProj, false, vp);
    gl.uniform3fv(bbU.uCenter, center); gl.uniform3fv(bbU.uUp, up); gl.uniform3fv(bbU.uRight, right);
    gl.uniform2fv(bbU.uSize, size); gl.uniform3fv(bbU.uTint, tint); gl.uniform1f(bbU.uAlpha, alpha);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texId); gl.uniform1i(bbU.uTex, 0);
    gl.bindVertexArray(QUAD); gl.drawArrays(gl.TRIANGLES, 0, 6); gl.bindVertexArray(null);
  }

  function frame(state, dt) {
    const { r, dpr } = resize();
    updateCamera(dt);
    gl.viewport(0, 0, glCanvas.width, glCanvas.height);
    gl.clearColor(0.55, 0.68, 0.78, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BIT || gl.DEPTH_BUFFER_BIT);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // sky (behind everything)
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
    gl.useProgram(skyP); gl.uniform3fv(skyU.uTop, [0.42, 0.6, 0.78]); gl.uniform3fv(skyU.uBot, [0.86, 0.86, 0.8]);
    gl.bindVertexArray(FS); gl.drawArrays(gl.TRIANGLES, 0, 6); gl.bindVertexArray(null);
    gl.depthMask(true); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);

    // ground
    drawMesh(GROUND, 0, M.model(0, 0, 0, 1), { useTex: 1, texId: T.gravel, amb: 0.62, uv: 1 });

    // camera basis for billboards
    const fwd = V.norm(V.sub(camCtr, camPos));
    const right = V.norm(V.cross([0, 1, 0], fwd));
    const camUp = V.cross(fwd, right);

    // distant backdrop (trees + wall), standing at the far edge
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
    drawBillboard(T.backdrop, [0, 96, -H * 1.15], [W * 3.0, 240], { up: [0, 1, 0], right: [1, 0, 0], alpha: 1 });
    gl.depthMask(true);

    // ---- boules: shadows, flight trails + landing dust, then the lit rolling spheres ----
    const balls = [state.jack, ...state.bodies];

    // spawn transient particles from the live physics state
    for (const b of state.bodies) {
      if (b.dead) continue;
      if (b.state === 'air') trails.push({ x: b.x, y: b.y, lift: b.airLift || 0, team: b.team, life: 0, max: 0.5 });
      if (b.justLanded) { b.justLanded = false;
        for (let i = 0; i < 7; i++) groundDust.push({ x: b.x + (Math.random() - 0.5) * 14, y: b.y + (Math.random() - 0.5) * 14,
          life: 0, max: 0.55 + Math.random() * 0.35, r0: 7 + Math.random() * 6 }); }
    }

    // ground shadows — grow and fade as the boule climbs, so height reads
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
    for (const b of balls) {
      if (b.dead) continue;
      const lift = b === state.jack ? 0 : (b.airLift || 0);
      const sc = (b.r * 2.3) * (1 + lift / 90), a = Math.max(0.1, 0.42 - lift / 360);
      drawBillboard(T.shadow, toWorld(b.x, b.y, 0.6), [sc, sc], { up: [0, 0, 1], right: [1, 0, 0], alpha: a });
    }
    // flight trails — additive team-tinted glow strung along the arc
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    for (let i = trails.length - 1; i >= 0; i--) { const p = trails[i]; p.life += dt; if (p.life > p.max) { trails.splice(i, 1); continue; }
      const k = p.life / p.max, a = (1 - k) * 0.5, sz = 10 * (1 - k * 0.4);
      drawBillboard(T.glow, toWorld(p.x, p.y, (p.lift || 0) + 8), [sz, sz], { up: camUp, right, alpha: a, tint: hex(TEAM[p.team].fill[0]) });
    }
    // landing dust — a brown puff kicked off the gravel that rises and spreads
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    for (let i = groundDust.length - 1; i >= 0; i--) { const p = groundDust[i]; p.life += dt; if (p.life > p.max) { groundDust.splice(i, 1); continue; }
      const k = p.life / p.max, sz = p.r0 + k * 26, a = (1 - k) * 0.5;
      drawBillboard(T.dust, toWorld(p.x, p.y, 4 + k * 20), [sz, sz], { up: camUp, right, alpha: a });
    }

    // holding-point ring — mark whichever boule currently lies nearest the jack (the point) while you aim
    if (state.phase === 'aim') {
      let hold = null, hd = Infinity;
      for (const b of state.bodies) { if (b.dead) continue; const d = Math.hypot(b.x - state.jack.x, b.y - state.jack.y); if (d < hd) { hd = d; hold = b; } }
      if (hold) { const sz = hold.r * 3.4, a = 0.4 + 0.16 * Math.sin(t * 4);
        drawBillboard(T.ring, toWorld(hold.x, hold.y, 0.9), [sz, sz], { up: [0, 0, 1], right: [1, 0, 0], alpha: a, tint: hex(TEAM[hold.team].fill[1]) }); }
    }

    // impacts — boules cracking together: spawn a shock-ring + kick the camera, then draw the live rings
    if (state.impacts && state.impacts.length) {
      for (const im of state.impacts) { sparks.push({ x: im.x, y: im.y, life: 0, max: 0.55, s: im.s }); shake = Math.min(1, shake + im.s * 0.75); if (im.s > 0.4) react(); }
      state.impacts.length = 0;
    }
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // additive flash
    for (let i = sparks.length - 1; i >= 0; i--) { const p = sparks[i]; p.life += dt; if (p.life > p.max) { sparks.splice(i, 1); continue; }
      const k = p.life / p.max, sz = (18 + p.s * 34) * (0.45 + k * 1.7), a = (1 - k) * (0.5 + p.s * 0.45);
      drawBillboard(T.ring, toWorld(p.x, p.y, 1.4), [sz, sz], { up: [0, 0, 1], right: [1, 0, 0], alpha: a });
    }
    gl.depthMask(true); gl.disable(gl.BLEND);

    // the boules — textured steel, spinning as they roll and tumble
    for (const b of balls) {
      const lift = b === state.jack ? 0 : (b.airLift || 0);
      advanceSpin(b, dt);
      const texId = b === state.jack ? T.jack : T.boule[b.team];
      const spec = b === state.jack ? 0.3 : 0.85, amb = b === state.jack ? 0.5 : 0.34;
      drawMesh(SP.va, SP.n, M.composed(...toWorld(b.x, b.y, b.r + lift), b.r, b._orient),
        { useTex: 1, texId, spec, amb, alpha: b.dead ? 0.3 : 1 });
    }

    // crowd + smoke (alpha, back-to-front; depth test on so boules can occlude)
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
    const rgt = V.norm([right[0], 0, right[2]]); // upright (cylindrical) billboard axis
    for (const f of crowd) {
      f.phase = (f.phase + dt * f.speed) % 1;
      if (f.watch > 0) f.watch -= dt;
      const idle = Math.sin((f.phase + f.wob) * 6.28) * 3;
      const texId = f.watch > 0 ? f.watchTex : f.frames[(f.phase * f.frames.length) | 0];
      const cx = f.x, cz = f.z, hgt = f.scale;
      // a soft ground shadow so they read as standing on the gravel, not pasted on
      drawBillboard(T.shadow, [cx, 0.7, cz], [hgt * 0.34, hgt * 0.34], { up: [0, 0, 1], right: [1, 0, 0], alpha: 0.3 });
      drawBillboard(texId, [cx, hgt / 2 + idle, cz], [hgt * 0.48, hgt], { up: [0, 1, 0], right: rgt, alpha: 1 });
      // smokers puff
      if (f.action === 'smoke') { f.puff -= dt; if (f.puff <= 0) { f.puff = 0.4 + Math.random() * 0.5;
        puffs.push({ x: cx + 4, y: hgt * 0.84, z: cz, life: 0, max: 2.8, r0: 8 }); } }
    }
    // puffs rise + spread + fade
    for (let i = puffs.length - 1; i >= 0; i--) { const p = puffs[i]; p.life += dt; if (p.life > p.max) { puffs.splice(i, 1); continue; }
      const k = p.life / p.max, sz = p.r0 + k * 44, a = (1 - k) * 0.6;
      drawBillboard(T.smoke, [p.x + k * 8, p.y + k * 50, p.z], [sz, sz], { up: camUp, right, alpha: a }); }
    gl.depthMask(true); gl.disable(gl.BLEND);

    drawOverlay(state, r);
  }

  // The measure: string lines from the jack to each counting boule, with distances (pétanque's ritual).
  function drawMeasure(state, r) {
    const m = state.measure, col = TEAM[m.winner].fill[1];
    const js = worldToScreen(state.jack.x, state.jack.y, state.jack.r, r);
    const pulse = 0.6 + 0.4 * Math.sin(t * 5);
    octx.lineJoin = 'round'; octx.lineCap = 'round'; octx.textAlign = 'center';
    // the jack, ringed
    octx.strokeStyle = 'rgba(255,255,255,.85)'; octx.lineWidth = 2;
    octx.beginPath(); octx.arc(js.x, js.y, 9, 0, 7); octx.stroke();
    for (const b of m.boules) {
      const bs = worldToScreen(b.x, b.y, b.r, r);
      octx.strokeStyle = col; octx.setLineDash([5, 5]); octx.lineWidth = 2;
      octx.beginPath(); octx.moveTo(js.x, js.y); octx.lineTo(bs.x, bs.y); octx.stroke(); octx.setLineDash([]);
      octx.globalAlpha = pulse; octx.lineWidth = 2.5;
      octx.beginPath(); octx.arc(bs.x, bs.y, 13, 0, 7); octx.stroke(); octx.globalAlpha = 1;
      const cm = Math.round(Math.hypot(b.x - state.jack.x, b.y - state.jack.y) * CM_PER_PX); // plan px → cm
      const mx = (js.x + bs.x) / 2, my = (js.y + bs.y) / 2;
      octx.font = '700 12px system-ui, sans-serif';
      octx.fillStyle = 'rgba(0,0,0,.5)'; octx.fillText(`${cm} cm`, mx + 1, my - 5);
      octx.fillStyle = '#fff'; octx.fillText(`${cm} cm`, mx, my - 6);
    }
  }

  // During the between-shots bird's-eye, call the two boules lying nearest the jack and print their
  // distances — the leader ringed gold — so you can read who's holding before the next throw. Tied to the
  // camera blend `over`, so the labels fade in as we rise and fade out as we drop back to the play view.
  function drawNearest(state, r) {
    if (over < 0.12) return;
    const ranked = state.bodies.filter((b) => !b.dead)
      .map((b) => ({ b, d: Math.hypot(b.x - state.jack.x, b.y - state.jack.y) }))
      .sort((p, q) => p.d - q.d).slice(0, 2);
    if (!ranked.length) return;
    const js = worldToScreen(state.jack.x, state.jack.y, state.jack.r, r);
    octx.save();
    octx.globalAlpha = Math.min(1, (over - 0.12) / 0.4);
    octx.textAlign = 'center'; octx.lineJoin = 'round'; octx.lineCap = 'round';
    octx.strokeStyle = 'rgba(255,255,255,.9)'; octx.lineWidth = 2;
    octx.beginPath(); octx.arc(js.x, js.y, 7, 0, 7); octx.stroke(); // the jack
    ranked.forEach((p, i) => {
      const bs = worldToScreen(p.b.x, p.b.y, p.b.r, r), col = TEAM[p.b.team].fill[1];
      octx.strokeStyle = col; octx.setLineDash([5, 5]); octx.lineWidth = 2;
      octx.beginPath(); octx.moveTo(js.x, js.y); octx.lineTo(bs.x, bs.y); octx.stroke(); octx.setLineDash([]);
      octx.strokeStyle = i === 0 ? '#ffe07a' : 'rgba(255,255,255,.85)'; octx.lineWidth = i === 0 ? 3 : 2;
      octx.beginPath(); octx.arc(bs.x, bs.y, 15, 0, 7); octx.stroke(); // ring the boule
      // distance label, pushed outward past the boule (away from the jack) so the two don't collide
      const dx = bs.x - js.x, dy = bs.y - js.y, dl = Math.hypot(dx, dy) || 1;
      const lx = bs.x + dx / dl * 26, ly = bs.y + dy / dl * 26;
      const label = `${(p.d * CM_PER_PX).toFixed(1)} cm`; // plan px → cm, one decimal to split near-ties
      octx.font = i === 0 ? '800 15px system-ui, sans-serif' : '700 13px system-ui, sans-serif';
      octx.fillStyle = 'rgba(0,0,0,.6)'; octx.fillText(label, lx + 1, ly + 1);
      octx.fillStyle = i === 0 ? '#ffe07a' : '#fff'; octx.fillText(label, lx, ly);
    });
    octx.restore();
  }

  // 2D aim overlay (projected from 3D so it sits on the piste) ---------------------------------------
  function drawOverlay(state, r) {
    octx.clearRect(0, 0, overlay.width, overlay.height);
    if (state.measure) { drawMeasure(state, r); return; }
    drawNearest(state, r); // distances of the 2 closest boules, during the overhead pan
    if (!(state.aim && state.humanTurn())) return; // the aim persists after the drag, until you Launch
    const a = state.aim, L = a.landing;
    const ts = worldToScreen(THROW.x, THROW.y, 0, r), ls = worldToScreen(L.x, L.y, 0, r);

    // trajectory preview: a faint ground track + the bright aerial arc, both projected from 3D
    if (a.arc && a.arc.length) {
      octx.lineJoin = 'round'; octx.lineCap = 'round';
      octx.strokeStyle = 'rgba(84,201,138,.26)'; octx.setLineDash([5, 6]); octx.lineWidth = 1.5;
      octx.beginPath();
      a.arc.forEach((p, i) => { const s = worldToScreen(p.x, p.y, 0, r); i ? octx.lineTo(s.x, s.y) : octx.moveTo(s.x, s.y); });
      octx.stroke(); octx.setLineDash([]);
      octx.beginPath();
      a.arc.forEach((p, i) => { const s = worldToScreen(p.x, p.y, p.lift, r); i ? octx.lineTo(s.x, s.y) : octx.moveTo(s.x, s.y); });
      octx.strokeStyle = 'rgba(120,225,160,.95)'; octx.lineWidth = 3; octx.stroke();
      octx.strokeStyle = 'rgba(255,255,255,.5)'; octx.lineWidth = 1; octx.stroke();
    }

    // landing spot + how much the throw can stray
    const spread = Math.min(46, a.dist * 0.095 + 8) * (ls.w ? 260 / ls.w : 1);
    octx.strokeStyle = 'rgba(84,201,138,.4)'; octx.lineWidth = 1.5;
    octx.beginPath(); octx.ellipse(ls.x, ls.y, spread, spread * 0.5, 0, 0, 7); octx.stroke();
    octx.beginPath(); octx.arc(ls.x, ls.y, 3.5, 0, 7); octx.fillStyle = '#54c98a'; octx.fill();

    // power ring with graduated ticks
    const pw = a.power, col = pw < 0.5 ? '#54c98a' : pw < 0.82 ? '#ffd45b' : '#e8663f';
    octx.strokeStyle = 'rgba(255,255,255,.16)'; octx.lineWidth = 5;
    octx.beginPath(); octx.arc(ts.x, ts.y, 28, 0, 7); octx.stroke();
    for (let i = 0; i <= 10; i++) { const ang = -Math.PI / 2 + i / 10 * 6.28, r0 = 24, r1 = i % 5 === 0 ? 34 : 31;
      octx.strokeStyle = 'rgba(255,255,255,.3)'; octx.lineWidth = 1;
      octx.beginPath(); octx.moveTo(ts.x + Math.cos(ang) * r0, ts.y + Math.sin(ang) * r0); octx.lineTo(ts.x + Math.cos(ang) * r1, ts.y + Math.sin(ang) * r1); octx.stroke(); }
    octx.strokeStyle = col; octx.lineWidth = 5; octx.lineCap = 'round';
    octx.beginPath(); octx.arc(ts.x, ts.y, 28, -Math.PI / 2, -Math.PI / 2 + pw * 6.28); octx.stroke(); octx.lineCap = 'butt';

    // numeric power, plus shot type + line angle (° left/right of straight up the piste)
    let rel = a.heading + Math.PI / 2; while (rel > Math.PI) rel -= 6.28; while (rel < -Math.PI) rel += 6.28;
    const deg = Math.round(rel * 180 / Math.PI);
    const angTxt = deg === 0 ? '0°' : `${Math.abs(deg)}° ${deg > 0 ? 'R' : 'L'}`;
    octx.textAlign = 'center';
    octx.font = '700 16px system-ui, sans-serif'; octx.fillStyle = '#eaf6ef';
    octx.fillText(`${Math.round(pw * 100)}%`, ts.x, ts.y - 40);
    octx.font = '600 12px system-ui, sans-serif'; octx.fillStyle = '#9fe6c0';
    octx.fillText(`${(a.shot || '').toUpperCase()} · ${angTxt}`, ts.x, ts.y - 58);
  }

  function hex(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }

  resize();
  return { frame, screenToGround, worldToScreen, react, resize, setOverhead };
}

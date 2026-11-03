// The work floor: a 3D office where every agent sits at a desk. Desks light up in the agent's
// color while it works, and packets fly between desks when work is handed off.
import { $, esc, num } from '../ui.js';

const DESKS = {
  director: [0, -2.6], scout: [-6.2, -2.2], reader: [-2.6, -0.4], watcher: [3.2, 0.2],
  sum1: [-7.2, 1.8], sum2: [-4.6, 2.8], sum3: [-2, 3.8], terms: [7, 1.4], recipes: [2.2, 3.6], lab: [6, 4.6],
};
const CAMS = { overview: [13, 12, 15], top: [0, 24, 0.01], floor: [0, 2.4, 13] };

let root, THREE, OrbitControls, renderer, scene, camera, controls, raf, agents = {}, packets = [], mode = 'overview', state, screens = {}, picked = null, resizeObs;

function makeRobot(color) {
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xe8ecf2, roughness: 0.45, metalness: 0.1 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.42, 6, 16), white);
  body.position.y = 0.78;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 24, 16), white);
  head.position.y = 1.42;
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 0.06), new THREE.MeshStandardMaterial({ color: 0x111111, emissive: new THREE.Color(color), emissiveIntensity: 0.2 }));
  visor.position.set(0, 1.44, 0.24);
  const chair = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.08, 16), new THREE.MeshStandardMaterial({ color: 0x1b2028 }));
  chair.position.y = 0.42;
  g.add(chair, body, head, visor);
  return { g, body, head, visor };
}

function makeDesk(color) {
  const g = new THREE.Group();
  const top = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.08, 0.8), new THREE.MeshStandardMaterial({ color: 0x161b22, roughness: 0.8 }));
  top.position.y = 0.75;
  const base = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.7, 0.6), new THREE.MeshStandardMaterial({ color: 0x0e1217 }));
  base.position.y = 0.37;
  const screenMat = new THREE.MeshStandardMaterial({ color: 0x05070a, emissive: new THREE.Color(color), emissiveIntensity: 0.05 });
  const screen = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.04), screenMat);
  screen.position.set(0, 1.12, -0.25);
  const glow = new THREE.PointLight(new THREE.Color(color), 0, 3.2);
  glow.position.set(0, 1.3, 0.2);
  g.add(top, base, screen, glow);
  return { g, screenMat, glow };
}

function wallScreen(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 256;
  const tex = new THREE.CanvasTexture(canvas);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
  return { mesh, canvas, tex };
}

function paintScreen(sc, title, cells) {
  const c = sc.canvas.getContext('2d');
  c.fillStyle = 'rgba(10,13,17,.92)'; c.fillRect(0, 0, 512, 256);
  c.strokeStyle = '#2b3542'; c.strokeRect(1, 1, 510, 254);
  c.fillStyle = '#6b7685'; c.font = '600 20px JetBrains Mono, monospace'; c.fillText(title, 20, 34);
  cells.forEach(([label, value, color], i) => {
    const x = 20 + (i % 3) * 165, y = 86 + Math.floor(i / 3) * 90;
    c.fillStyle = '#6b7685'; c.font = '16px JetBrains Mono, monospace'; c.fillText(label, x, y);
    c.fillStyle = color || '#e5e9ee'; c.font = '500 40px JetBrains Mono, monospace'; c.fillText(value, x, y + 44);
  });
  sc.tex.needsUpdate = true;
}

function build(el) {
  const wrap = $('.room', el);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.setSize(wrap.clientWidth, wrap.clientHeight);
  wrap.prepend(renderer.domElement);
  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x050608, 26, 50);
  camera = new THREE.PerspectiveCamera(40, wrap.clientWidth / wrap.clientHeight, 0.1, 200);
  camera.position.set(...CAMS.overview);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.8, 1);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2.1;

  scene.add(new THREE.HemisphereLight(0x8899aa, 0x050608, 0.5));
  const key = new THREE.DirectionalLight(0xffffff, 0.6);
  key.position.set(6, 14, 8);
  scene.add(key);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(22, 15), new THREE.MeshStandardMaterial({ color: 0x0a0d11, roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.z = 1;
  scene.add(floor);
  const grid = new THREE.GridHelper(22, 22, 0x1a2029, 0x10141a);
  grid.position.set(0, 0.01, 1);
  scene.add(grid);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x0b0e12, roughness: 1 });
  const back = new THREE.Mesh(new THREE.BoxGeometry(22, 4, 0.2), wallMat);
  back.position.set(0, 2, -6.5);
  const side = new THREE.Mesh(new THREE.BoxGeometry(0.2, 4, 15), wallMat);
  side.position.set(-11, 2, 1);
  scene.add(back, side);
  // Lit path on the floor that work packets follow.
  const pathMat = new THREE.LineBasicMaterial({ color: 0x3a4552 });
  const pts = [[-7, 3], [-2, 3], [2, 5.4], [6, 3.2], [0, -1.2]].map(([x, z]) => new THREE.Vector3(x, 0.02, z));
  scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), pathMat));

  for (const [key2, w, h, pos] of [['left', 4.6, 2.3, [-3.2, 2.6, -6.38]], ['right', 4.6, 2.3, [3.2, 2.6, -6.38]]]) {
    const sc = wallScreen(w, h);
    sc.mesh.position.set(...pos);
    scene.add(sc.mesh);
    screens[key2] = sc;
  }

  // Director's platform ring
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.025, 8, 64), new THREE.MeshBasicMaterial({ color: 0xa78bfa }));
  ring.rotation.x = Math.PI / 2;
  ring.position.set(DESKS.director[0], 0.03, DESKS.director[1] + 0.6);
  scene.add(ring);

  for (const a of state.agents) {
    const [x, z] = DESKS[a.id];
    const desk = makeDesk(a.color);
    desk.g.position.set(x, 0, z);
    const bot = makeRobot(a.color);
    bot.g.position.set(x, 0, z + 0.75);
    bot.g.rotation.y = Math.PI;
    bot.body.userData.agent = bot.head.userData.agent = a.id;
    scene.add(desk.g, bot.g);
    const tag = document.createElement('div');
    tag.className = 'tag';
    $('.labels', el).appendChild(tag);
    agents[a.id] = { ...desk, ...bot, tag, base: [x, z], phase: Math.random() * 6 };
  }

  const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
  renderer.domElement.addEventListener('click', (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(mouse, camera);
    const hit = ray.intersectObjects(Object.values(agents).flatMap((a) => [a.body, a.head]))[0];
    picked = hit?.object.userData.agent ?? null;
    side();
  });

  resizeObs = new ResizeObserver(() => {
    renderer.setSize(wrap.clientWidth, wrap.clientHeight);
    camera.aspect = wrap.clientWidth / wrap.clientHeight;
    camera.updateProjectionMatrix();
  });
  resizeObs.observe(wrap);
}

function side() {
  const el = $('.side', root);
  const a = picked && state.agents.find((x) => x.id === picked);
  el.classList.toggle('open', !!a);
  if (!a) return;
  const spent = state.budget.byAgent[a.id] || 0;
  el.innerHTML = `<div class="lbl" style="color:${a.color}">● ${esc(a.name)}</div><h3 style="margin:6px 0;font-weight:500">${esc(a.role)}</h3>
    <div class="kv"><span>Status</span><span class="${a.status === 'working' ? 'green' : ''}">${a.status}</span><span>Tasks done</span><span>${num(a.done)}</span><span>Spent</span><span>$${spent.toFixed(3)}</span></div>
    <p class="dim" style="font-size:12px">${esc(a.task || 'No task yet.')}</p>`;
}

function spawnPackets(handoffs) {
  for (const h of handoffs) {
    const a = agents[h.from], b = agents[h.to];
    if (!a || !b) continue;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 0.18), new THREE.MeshBasicMaterial({ color: 0xf5f5f5 }));
    scene.add(mesh);
    packets.push({ mesh, from: a.base, to: b.base, t: 0 });
  }
}

function frame(time) {
  const tSec = time / 1000;
  for (const a of state.agents) {
    const o = agents[a.id];
    const busy = a.status === 'working';
    o.screenMat.emissiveIntensity += ((busy ? 1.1 : 0.06) - o.screenMat.emissiveIntensity) * 0.08;
    o.glow.intensity += ((busy ? 3 : 0) - o.glow.intensity) * 0.08;
    o.visor.material.emissiveIntensity = busy ? 1.4 : 0.25;
    o.head.position.y = 1.42 + (busy ? Math.sin(tSec * 6 + o.phase) * 0.03 : 0);
    o.g.rotation.x = busy ? 0 : -0.18; // idle: leaning back with coffee
    const p = new THREE.Vector3(o.base[0], 2.05, o.base[1] + 0.75).project(camera);
    const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
    o.tag.style.left = `${((p.x + 1) / 2) * w}px`;
    o.tag.style.top = `${((1 - p.y) / 2) * h}px`;
    o.tag.style.display = p.z < 1 ? '' : 'none';
    const stuck = a.status === 'stuck';
    o.tag.className = `tag ${busy ? 'busy' : stuck ? 'stuck' : ''}`;
    o.tag.innerHTML = `<i style="background:${busy ? a.color : stuck ? '#f05252' : '#444d59'}"></i>${esc(a.name)}${busy ? '<em>working</em>' : stuck ? '<em style="color:#f05252">stuck</em>' : ''}`;
  }
  packets = packets.filter((p) => {
    p.t += 0.014;
    const x = p.from[0] + (p.to[0] - p.from[0]) * p.t, z = p.from[1] + (p.to[1] - p.from[1]) * p.t;
    p.mesh.position.set(x, 1 + Math.sin(p.t * Math.PI) * 1.4, z + 0.4);
    p.mesh.rotation.y += 0.08;
    if (p.t >= 1) { scene.remove(p.mesh); p.mesh.geometry.dispose(); return false; }
    return true;
  });
  if (mode === 'follow') {
    const busy = state.agents.find((a) => a.status === 'working' && a.id !== 'director') || state.agents[0];
    const [x, z] = agents[busy.id].base;
    controls.target.lerp(new THREE.Vector3(x, 1, z), 0.04);
    camera.position.lerp(new THREE.Vector3(x + 3.5, 4, z + 5.5), 0.03);
  }
  controls.update();
  renderer.render(scene, camera);
  raf = requestAnimationFrame(frame);
}

function setMode(m) {
  mode = m;
  $$('.room .seg .btn').forEach((b) => b.classList.toggle('on', b.dataset.cam === m));
  if (CAMS[m]) {
    camera.position.set(...CAMS[m]);
    controls.target.set(0, 0.8, 1);
  }
}
const $$ = (s, r = root) => [...r.querySelectorAll(s)];

export default {
  async mount(el, s) {
    root = el;
    state = s;
    el.innerHTML = `<div class="panel"><div class="ph"><span class="t">The work floor</span><span class="s">every movement is a real task</span><span class="r">from the task table</span></div>
      <div class="room"><div class="labels"></div>
        <div class="tools seg"><button class="btn on" data-cam="overview">OVERVIEW</button><button class="btn" data-cam="top">FROM ABOVE</button><button class="btn" data-cam="floor">WORK FLOOR</button><button class="btn" data-cam="follow">○ FOLLOW THE WORK</button></div>
        <div class="side"></div>
        <div class="help"><span>drag: rotate · scroll: zoom · right-drag: pan · click an agent</span><span style="margin-left:auto">desk lit in its color: working · leaning back: resting · white block: work moving to another desk</span></div>
      </div></div>`;
    $('.tools', el).addEventListener('click', (e) => { const b = e.target.closest('[data-cam]'); if (b) setMode(b.dataset.cam); });
    try {
      THREE = await import('three');
      ({ OrbitControls } = await import('three/addons/controls/OrbitControls.js'));
    } catch {
      $('.room', el).innerHTML = '<div class="empty">Could not load three.js. Run <code>npm install</code> and restart the server.</div>';
      return;
    }
    if (root !== el) return;
    agents = {}; packets = []; screens = {};
    build(el);
    this.update(s);
    raf = requestAnimationFrame(frame);
  },
  update(s) {
    state = s;
    if (!renderer || !root) return;
    spawnPackets(s.handoffs);
    const c = s.counts;
    paintScreen(screens.left, 'PIPELINE · TODAY', [['sources', num(c.sources)], ['read', num(c.read)], ['recipes', num(c.recipes)], ['variants', num(c.variants)], ['validated', num(c.validated), '#4ade80'], ['spent', `$${s.budget.spent.toFixed(2)}`]]);
    const q = s.queues;
    paintScreen(screens.right, 'QUEUES · WORK WAITING', [['to read', q.toRead, '#fde68a'], ['to watch', q.toWatch, '#f472b6'], ['to summ.', q.toSummarize, '#60a5fa'], ['to recipe', q.toRecipe, '#fbbf24'], ['to lab', q.toLab, '#22d3ee'], ['decisions', s.decisions.filter((d) => d.status === 'pending').length, '#f5a524']]);
    if (picked) side();
  },
  unmount() {
    cancelAnimationFrame(raf);
    resizeObs?.disconnect();
    renderer?.dispose();
    renderer = null;
    root = null;
    mode = 'overview';
  },
};

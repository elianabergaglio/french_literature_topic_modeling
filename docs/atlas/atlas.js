(async function () {
  const { OrbitControls, CSS2DRenderer, CSS2DObject } = THREE;
  const $ = (id) => document.getElementById(id);

  // The data files are plain scripts: `(window.TOPIC_ATLAS = …)["decade"] = {…};`.
  // Read them with fetch and parse the object (works on any web server, e.g. GitHub Pages); when the page is opened from
  // disk, fetch is not allowed, so fall back to running them as scripts.
  async function loadDataFile(path, read) {
    try {
      const res = await fetch(path);
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      const text = await res.text();
      const start = text.search(/=\s*[\[{]/);  // the "=" right before the data object or array
      if (start < 0) throw new Error(`${path}: formato inatteso`);
      return JSON.parse(text.slice(start + 1).trim().replace(/;\s*$/, ""));
    } catch (err) {
      if (location.protocol !== "file:") throw err;
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.charset = "utf-8";
        s.src = path;
        s.onload = resolve;
        s.onerror = () => reject(new Error(`impossibile caricare ${path}`));
        document.head.appendChild(s);
      });
      return read();
    }
  }

  let manifest = [];
  try {
    manifest = await loadDataFile("data/manifest.js", () => window.TOPIC_ATLAS_MANIFEST);
  } catch (err) {
    setLoading(`Impossibile caricare data/manifest.js (${err.message}).`, true);
    return;
  }
  const fmt = new Intl.NumberFormat("it-IT");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- Scene ----------
  const host = $("scene");
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  host.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer({ element: $("labels-layer") });

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 50);
  const HOME = new THREE.Vector3(0, 0.35, 3.1);
  camera.position.copy(HOME);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotateSpeed = 0.6;
  controls.minDistance = 0.4;
  controls.maxDistance = 8;

  const pointShader = {
    uniforms: { uScale: { value: 1 }, uFade: { value: 1 } },
    vertexShader: `
      attribute vec3 aColor;
      attribute float aAlpha;
      attribute float aSize;
      uniform float uScale;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = max(1.5, aSize * uScale / -mv.z);
        gl_Position = projectionMatrix * mv;
        vColor = aColor;
        vAlpha = aAlpha;
      }`,
    fragmentShader: `
      uniform float uFade;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        gl_FragColor = vec4(vColor, uFade * vAlpha * smoothstep(0.5, 0.4, d));
      }`,
    transparent: true,
    depthWrite: false,
  };
  const material = new THREE.ShaderMaterial(pointShader);

  const markerMaterial = new THREE.ShaderMaterial({
    uniforms: { uScale: material.uniforms.uScale, uColor: { value: new THREE.Color() } },
    vertexShader: `
      uniform float uScale;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = max(14.0, 0.05 * uScale / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float ring = smoothstep(0.5, 0.44, d) * smoothstep(0.30, 0.36, d);
        if (ring < 0.01) discard;
        gl_FragColor = vec4(uColor, ring);
      }`,
    transparent: true,
    depthTest: false,
  });
  const marker = new THREE.Points(
    new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3)),
    markerMaterial,
  );
  marker.visible = false;
  marker.renderOrder = 10;
  scene.add(marker);

  // ---------- Theme ----------
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  let noiseColor = new THREE.Color(css("--noise"));
  function applyTheme() {
    renderer.setClearColor(new THREE.Color(css("--scene")), 1);
    noiseColor = new THREE.Color(css("--noise"));
    markerMaterial.uniforms.uColor.value.set(css("--fg"));
    if (current) paint();
  }
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
  new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // ---------- State ----------
  const SIZE_TOPIC = 0.016, SIZE_OTHER = 0.011;
  const cache = new Map();
  let current = null;      // decade view: { data, bg, fg, labels }
  let focus = null;        // topic index in data.topics, or null
  let preview = null;      // legend hover
  let showOthers = true, showLabels = true;

  function decode(b64, Type) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Type(bytes.buffer);
  }

  function loadDecade(decade) {
    if (cache.has(decade)) return cache.get(decade);
    const p = loadDataFile(`data/${decade}.js`, () => {
      const d = window.TOPIC_ATLAS && window.TOPIC_ATLAS[decade];
      if (!d) throw new Error("dati assenti");
      return d;
    });
    cache.set(decade, p);
    p.catch(() => cache.delete(decade));
    return p;
  }

  function buildView(data) {
    const pos = decode(data.pos, Int16Array);
    const idx = decode(data.topicIdx, Int8Array);
    const k = data.scale / 32767;
    const n = idx.length;
    // Two point clouds: documents of the 20 largest topics, and everything else.
    const split = { fg: [], bg: [] };
    for (let i = 0; i < n; i++) (idx[i] >= 0 ? split.fg : split.bg).push(i);

    const make = (docs, size) => {
      const g = new THREE.BufferGeometry();
      const p = new Float32Array(docs.length * 3);
      docs.forEach((d, j) => { p[3 * j] = pos[3 * d] * k; p[3 * j + 1] = pos[3 * d + 1] * k; p[3 * j + 2] = pos[3 * d + 2] * k; });
      g.setAttribute("position", new THREE.BufferAttribute(p, 3));
      g.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(docs.length * 3), 3));
      g.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(docs.length), 1));
      g.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(docs.length).fill(size), 1));
      g.computeBoundingSphere();
      const pts = new THREE.Points(g, material);
      pts.userData.docs = docs;
      return pts;
    };
    const bg = make(split.bg, SIZE_OTHER);
    const fg = make(split.fg, SIZE_TOPIC);
    fg.renderOrder = 1;

    const topicColors = data.topics.map((t) => new THREE.Color(t.color));
    const labels = data.topics.map((t) => {
      const el = document.createElement("div");
      el.className = "topic-label";
      el.innerHTML = `<i style="background:${t.color}"></i>`;
      el.append(`Tema ${t.id}: ${t.words.slice(0, 3).join(", ")}`);
      const obj = new CSS2DObject(el);
      obj.position.set(...t.centroid);
      return obj;
    });
    return { data, idx, bg, fg, topicColors, labels };
  }

  // Colors and opacity of every point, from the current focus / hover / toggles.
  function paint() {
    const v = current;
    const active = preview ?? focus;
    const fgColor = v.fg.geometry.getAttribute("aColor");
    const fgAlpha = v.fg.geometry.getAttribute("aAlpha");
    v.fg.userData.docs.forEach((d, j) => {
      const t = v.idx[d];
      const c = v.topicColors[t];
      fgColor.setXYZ(j, c.r, c.g, c.b);
      fgAlpha.setX(j, active == null ? 0.82 : t === active ? 0.95 : 0.07);
    });
    fgColor.needsUpdate = fgAlpha.needsUpdate = true;

    const bgColor = v.bg.geometry.getAttribute("aColor");
    const bgAlpha = v.bg.geometry.getAttribute("aAlpha");
    for (let j = 0; j < bgAlpha.count; j++) {
      bgColor.setXYZ(j, noiseColor.r, noiseColor.g, noiseColor.b);
      bgAlpha.setX(j, active == null ? 0.55 : 0.12);
    }
    bgColor.needsUpdate = bgAlpha.needsUpdate = true;
    v.bg.visible = showOthers;

    v.labels.forEach((l, i) => {
      l.visible = showLabels || i === active;
      l.element.classList.toggle("dim", active != null && i !== active);
    });
  }

  // ---------- UI ----------
  const decadesNav = $("decades");
  manifest.forEach(({ decade }) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = decade.replace("-", "–");
    b.dataset.decade = decade;
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", () => show(decade));
    decadesNav.appendChild(b);
  });

  function renderLegend(data) {
    const ul = $("legend");
    ul.replaceChildren();
    data.topics.forEach((t, i) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("aria-pressed", "false");
      b.innerHTML = `<span class="dot" style="background:${t.color}"></span>
        <span class="name"><b>Tema ${t.id}</b> <span></span></span>
        <span class="count">${fmt.format(t.count)}</span>`;
      b.querySelector(".name span").textContent = t.words.slice(0, 3).join(", ");
      b.addEventListener("click", () => setFocus(focus === i ? null : i));
      b.addEventListener("mouseenter", () => { preview = i; paint(); });
      b.addEventListener("mouseleave", () => { preview = null; paint(); });
      li.appendChild(b);
      ul.appendChild(li);
    });
    const shown = data.topics.reduce((s, t) => s + t.count, 0);
    const li = document.createElement("li");
    li.className = "other";
    li.innerHTML = `<button type="button" tabindex="-1" aria-hidden="true"><span class="dot"></span>
      <span class="name"><span>Altri temi e frammenti non assegnati</span></span>
      <span class="count">${fmt.format(data.nDocs - shown)}</span></button>`;
    ul.appendChild(li);
  }

  function renderStats(data) {
    $("stats").innerHTML =
      `<span><b>${fmt.format(data.nDocs)}</b> frammenti</span>` +
      `<span><b>${data.nTopics}</b> temi</span>` +
      `<span><b>${fmt.format(data.nOutliers)}</b> non assegnati</span>`;
    $("stats").title = data.run;
  }

  function setFocus(i) {
    focus = i;
    const data = current.data;
    document.querySelectorAll("#legend li:not(.other) button").forEach((b, j) => b.setAttribute("aria-pressed", String(j === i)));
    const detail = $("detail");
    if (i == null) {
      detail.hidden = true;
      flyTo(new THREE.Vector3(0, 0, 0));
    } else {
      const t = data.topics[i];
      detail.hidden = false;
      detail.innerHTML = `<h3><i style="background:${t.color}"></i>Tema ${t.id}</h3>
        <p class="words"></p>
        <p>${fmt.format(t.count)} frammenti · ${fmt.format(Number((100 * t.count / data.nDocs).toFixed(1)))}% del decennio</p>
        <button type="button" class="clear">Mostra tutti i temi</button>`;
      detail.querySelector(".words").textContent = t.words.join(", ");
      detail.querySelector(".clear").addEventListener("click", () => setFocus(null));
      flyTo(new THREE.Vector3(...t.centroid));
    }
    paint();
  }

  let flight = null;
  function flyTo(target) {
    if (reducedMotion) { controls.target.copy(target); return; }
    flight = { from: controls.target.clone(), to: target, t: 0 };
  }

  // ---------- Decade switch: fade out, fleur-de-lis while loading, fade and zoom in ----------
  const labelsLayer = $("labels-layer");
  let fade = null, dolly = null, showToken = 0;

  function fadeTo(value, ms) {
    if (reducedMotion || ms <= 0) {
      material.uniforms.uFade.value = value;
      labelsLayer.style.opacity = value;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      fade = { from: material.uniforms.uFade.value, to: value, start: performance.now(), ms, resolve };
    });
  }
  const nextFrames = (n) => new Promise((resolve) => {
    const step = () => (--n <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });

  async function show(decade) {
    const token = ++showToken;
    document.querySelectorAll("#decades button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.decade === decade)));
    setLoading(`Caricamento del decennio ${decade.replace("-", "–")}`);
    $("tooltip").hidden = true;
    marker.visible = false;
    const faded = current ? fadeTo(0, 240) : Promise.resolve();
    await nextFrames(2);  // let the overlay appear before the heavy work starts
    let data;
    try {
      data = await loadDecade(decade);
      await faded;
    } catch (err) {
      if (token === showToken) setLoading(`Impossibile caricare i dati del decennio ${decade} (${err.message}).`, true);
      return;
    }
    if (token !== showToken) return;  // another decade was picked meanwhile
    if (current) {
      scene.remove(current.bg, current.fg, ...current.labels);
      current.labels.forEach((l) => l.element.remove());
      current.bg.geometry.dispose();
      current.fg.geometry.dispose();
    }
    material.uniforms.uFade.value = 0;
    labelsLayer.style.opacity = 0;
    current = buildView(data);
    scene.add(current.bg, current.fg, ...current.labels);
    focus = preview = null;
    $("detail").hidden = true;
    renderLegend(data);
    renderStats(data);
    paint();
    controls.target.set(0, 0, 0);
    flight = null;
    if (reducedMotion) camera.position.copy(HOME);
    else {
      camera.position.copy(HOME).multiplyScalar(1.35);
      dolly = { from: camera.position.clone(), start: performance.now(), ms: 900 };
    }
    if (location.hash.slice(1) !== decade) history.replaceState(null, "", `#${decade}`);
    await nextFrames(1);
    setLoading(null);
    fadeTo(1, 520);
  }

  function setLoading(text, failed = false) {
    const el = $("loading");
    if (text == null) { el.classList.remove("on", "failed"); return; }
    $("loading-text").textContent = text;
    el.classList.toggle("failed", failed);
    el.classList.add("on");
  }

  function toggle(id, fn) {
    const b = $(id);
    b.addEventListener("click", () => {
      const on = b.getAttribute("aria-pressed") !== "true";
      b.setAttribute("aria-pressed", String(on));
      fn(on);
    });
  }
  toggle("t-others", (on) => { showOthers = on; if (current) paint(); });
  toggle("t-labels", (on) => { showLabels = on; if (current) paint(); });
  toggle("t-rotate", (on) => { controls.autoRotate = on; });
  $("reset").addEventListener("click", () => {
    camera.position.copy(HOME);
    if (current) setFocus(null);
    controls.target.set(0, 0, 0);
  });

  // ---------- Hover ----------
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let pointerPx = null, hoverDirty = false;
  renderer.domElement.addEventListener("pointermove", (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    pointerPx = { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
    pointer.set((pointerPx.x / r.width) * 2 - 1, -(pointerPx.y / r.height) * 2 + 1);
    hoverDirty = true;
  });
  renderer.domElement.addEventListener("pointerleave", () => { pointerPx = null; hoverDirty = true; });

  function updateHover() {
    hoverDirty = false;
    const tip = $("tooltip");
    if (!current || !pointerPx) { tip.hidden = true; marker.visible = false; return; }
    raycaster.setFromCamera(pointer, camera);
    raycaster.params.Points.threshold = 0.006 * camera.position.distanceTo(controls.target);
    const active = preview ?? focus;
    const targets = showOthers && active == null ? [current.fg, current.bg] : [current.fg];
    const hit = raycaster.intersectObjects(targets, false).find((h) =>
      active == null || h.object !== current.fg || current.idx[h.object.userData.docs[h.index]] === active);
    if (!hit) { tip.hidden = true; marker.visible = false; return; }

    const doc = hit.object.userData.docs[hit.index];
    const t = current.idx[doc];
    const topic = t >= 0 ? current.data.topics[t] : null;
    marker.geometry.getAttribute("position").setXYZ(0, ...hit.object.geometry.getAttribute("position").array.slice(3 * hit.index, 3 * hit.index + 3));
    marker.geometry.getAttribute("position").needsUpdate = true;
    marker.visible = true;

    tip.innerHTML = `<div class="t-topic"><i></i><span></span></div><div class="t-text"></div>`;
    tip.querySelector("i").style.background = topic ? topic.color : "var(--noise)";
    tip.querySelector(".t-topic span").textContent = topic ? `Tema ${topic.id}: ${topic.words.slice(0, 3).join(", ")}` : "Altro tema o frammento non assegnato";
    tip.querySelector(".t-text").textContent = `“${current.data.snippets[doc]}”`;
    tip.hidden = false;
    const { x, y, w, h } = pointerPx;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = `${Math.min(Math.max(12, x + 14), w - tw - 12)}px`;
    tip.style.top = `${y + 16 + th > h - 12 ? y - th - 12 : y + 16}px`;
  }

  // ---------- Loop ----------
  function resize() {
    const { clientWidth: w, clientHeight: h } = host;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = `${w}px`;
    renderer.domElement.style.height = `${h}px`;
    labelRenderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    material.uniforms.uScale.value = (h * renderer.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  }
  new ResizeObserver(resize).observe(host);
  resize();
  applyTheme();

  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  renderer.setAnimationLoop((now) => {
    now = performance.now();
    if (fade) {
      const t = Math.min(1, (now - fade.start) / fade.ms);
      const v = fade.from + (fade.to - fade.from) * easeOut(t);
      material.uniforms.uFade.value = v;
      labelsLayer.style.opacity = v;
      if (t >= 1) { const done = fade.resolve; fade = null; done(); }
    }
    if (dolly) {
      const t = Math.min(1, (now - dolly.start) / dolly.ms);
      camera.position.lerpVectors(dolly.from, HOME, easeOut(t));
      if (t >= 1) dolly = null;
    }
    if (flight) {
      flight.t = Math.min(1, flight.t + 0.06);
      const e = 1 - Math.pow(1 - flight.t, 3);
      controls.target.lerpVectors(flight.from, flight.to, e);
      if (flight.t >= 1) flight = null;
    }
    controls.update();
    if (hoverDirty || controls.autoRotate || flight) updateHover();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  });
  controls.addEventListener("change", () => { hoverDirty = true; });

  const fromHash = location.hash.slice(1);
  const first = manifest.find((m) => m.decade === fromHash)?.decade ?? manifest.find((m) => m.decade === "1961-1970")?.decade ?? manifest[0]?.decade;
  if (first) show(first);
  else setLoading("Nessun dato disponibile per l’atlante.", true);

  // A link or the host page can switch decade by changing the hash (e.g. atlas/#1971-1980).
  window.addEventListener("hashchange", () => {
    const decade = location.hash.slice(1);
    if (manifest.some((m) => m.decade === decade)) show(decade);
  });
})();

// ---- Extras : jour/nuit, fonds de carte NASA, aurores, trace satellite, mesure, ciel ----
import { esc, store, showCard } from './ui.js';

const $ = (id) => document.getElementById(id);
const D2R = Math.PI / 180;

// ---- Position du Soleil (formules basse précision de l'Astronomical Almanac, ≈ 0,01°) ----
export function sunSubpoint(date) {
    const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;      // jours depuis J2000
    const L = (280.460 + 0.9856474 * n) % 360;
    const g = ((357.528 + 0.9856003 * n) % 360) * D2R;
    const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
    const eps = (23.439 - 0.0000004 * n) * D2R;
    const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
    const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
    const gmst = (((280.46061837 + 360.98564736629 * n) % 360) + 360) % 360;
    let lon = ra / D2R - gmst;
    lon = ((lon + 540) % 360) - 180;
    return { lat: dec / D2R, lon };
}

const fmtLL = (lat, lon) => `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'O'}`;

export function initExtras(ctx) {
    const { THREE, scene, globeGroup, earthMesh, latLonToVector3, tangentFrame } = ctx;

    // =====================================================================
    // 1. Matériau de la Terre : jour / nuit + fonds de carte
    // =====================================================================
    const politicalTex = earthMesh.material.map;
    const blackTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
    blackTex.needsUpdate = true;
    const uniforms = {
        dayMap: { value: politicalTex },
        nightMap: { value: blackTex },
        hasNight: { value: 0 },
        sunDir: { value: new THREE.Vector3(1, 0, 0) },
        dayNight: { value: 1 },
        nightLevel: { value: 0.5 },   // luminosité de la face nocturne (carte politique lisible)
    };
    const oldMat = earthMesh.material;
    earthMesh.material = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: `
            varying vec2 vUv; varying vec3 vNL; varying vec3 vNW;
            void main() {
                vUv = uv; vNL = normalize(normal); vNW = normalize(mat3(modelMatrix) * normal);
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
        fragmentShader: `
            uniform sampler2D dayMap; uniform sampler2D nightMap;
            uniform float hasNight; uniform float dayNight; uniform float nightLevel; uniform vec3 sunDir;
            varying vec2 vUv; varying vec3 vNL; varying vec3 vNW;
            void main() {
                vec3 day = texture2D(dayMap, vUv).rgb;
                vec3 col;
                if (dayNight < 0.5) {
                    float l = 0.60 + 0.40 * max(dot(normalize(vNW), normalize(vec3(5.0, 3.0, 5.0))), 0.0);
                    col = day * l;
                } else {
                    float d = dot(normalize(vNL), normalize(sunDir));
                    float t = smoothstep(-0.10, 0.07, d);
                    vec3 nightTex = texture2D(nightMap, vUv).rgb;
                    vec3 night = mix(day * nightLevel + vec3(0.0, 0.01, 0.04), nightTex * 1.3 + day * 0.03, hasNight);
                    vec3 lit = day * (0.80 + 0.30 * clamp(d, 0.0, 1.0));
                    col = mix(night, lit, t);
                    float tw = exp(-pow((d + 0.015) / 0.045, 2.0));
                    col += vec3(0.30, 0.10, 0.02) * tw * 0.35 * (1.0 - hasNight * 0.5);
                }
                gl_FragColor = vec4(col, 1.0);
                #include <colorspace_fragment>
            }`,
    });
    // Repli : si le shader ne compile pas sur cette carte graphique, retour à un matériau simple
    ctx.onShaderError = () => {
        if (earthMesh.material && earthMesh.material.isShaderMaterial) {
            earthMesh.material = new THREE.MeshBasicMaterial({ map: uniforms.dayMap.value });
        }
        if (ctx.atmosphereMesh && ctx.atmosphereMesh.material.isShaderMaterial) {
            ctx.atmosphereMesh.material = new THREE.MeshBasicMaterial({ color: 0x3388ff, transparent: true, opacity: 0.18, side: THREE.BackSide });
            ctx.atmosphereMesh.geometry.dispose();
            ctx.atmosphereMesh.geometry = new THREE.SphereGeometry(1.03, 64, 64);
        }
    };
    oldMat.dispose();

    // Atmosphère : halo de Fresnel
    if (ctx.atmosphereMesh) {
        const am = ctx.atmosphereMesh;
        am.material.dispose();
        am.geometry.dispose();
        am.geometry = new THREE.SphereGeometry(1.14, 64, 64);
        am.material = new THREE.ShaderMaterial({
            vertexShader: `varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: `varying vec3 vN; void main(){ float i = pow(max(0.72 - dot(vN, vec3(0.0, 0.0, 1.0)), 0.0), 3.0); gl_FragColor = vec4(0.28, 0.58, 1.0, 1.0) * clamp(i * 1.6, 0.0, 1.0); }`,
            side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
        });
    }

    // Ciel étoilé (fixe : ne tourne pas avec le globe)
    {
        const N = 1800, pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
            const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
            pos[i * 3] = 22 * r * Math.cos(th); pos[i * 3 + 1] = 22 * u; pos[i * 3 + 2] = 22 * r * Math.sin(th);
            const b = 0.35 + Math.random() * 0.65, tint = Math.random();
            col[i * 3] = b * (tint > 0.8 ? 1 : 0.85); col[i * 3 + 1] = b * 0.9; col[i * 3 + 2] = b * (tint < 0.3 ? 1 : 0.95);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        const stars = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.4, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false }));
        stars.renderOrder = -10;
        scene.add(stars);
    }

    // =====================================================================
    // 2. Soleil / jour-nuit
    // =====================================================================
    let dayNightOn = !!$('toggle-daynight').classList.contains('active');

    function updateSun() {
        const sp = sunSubpoint(new Date());
        const dir = latLonToVector3(sp.lat, sp.lon, 1).normalize();
        uniforms.sunDir.value.copy(dir);
        const txt = `☀ Soleil au zénith : ${fmtLL(sp.lat, sp.lon)}`;
        $('sun-status').textContent = dayNightOn ? txt : 'désactivé';
        $('sun-info').textContent = dayNightOn ? txt : '';
        ctx.sun = sp;
    }
    updateSun();
    setInterval(updateSun, 30000);
    $('toggle-daynight').addEventListener('click', () => {
        dayNightOn = !dayNightOn;
        uniforms.dayNight.value = dayNightOn ? 1 : 0;
        $('toggle-daynight').classList.toggle('active', dayNightOn);
        updateSun();
    });
    uniforms.dayNight.value = dayNightOn ? 1 : 0;

    // =====================================================================
    // 3. Fonds de carte et calques NASA GIBS (via le proxy /api/gibs)
    // =====================================================================
    const utcDay = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
    const BASE_LAYERS = {
        bluemarble: 'BlueMarble_ShadedRelief_Bathymetry',
        terra: 'MODIS_Terra_CorrectedReflectance_TrueColor',
        viirs: 'VIIRS_SNPP_CorrectedReflectance_TrueColor',
    };
    const bm = {
        mode: store.get('basemap', 'political'),
        date: store.get('basemapDate', utcDay(-1)),
        overlay: store.get('overlay', 'none'),
        night: store.get('nightlights', false),
    };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bm.date) || bm.date > utcDay(0)) bm.date = utcDay(-1);
    const texW = ctx.renderer.capabilities && ctx.renderer.capabilities.maxTextureSize >= 4096 ? 4096 : 2048;
    const setStatus = (t, color) => { const el = $('basemap-status'); el.textContent = t || ''; el.style.color = color || ''; };

    function loadImage(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('image indisponible'));
            img.src = url;
        });
    }
    function makeTexture(source) {
        const t = new THREE.Texture(source);
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = ctx.renderer.capabilities.getMaxAnisotropy ? ctx.renderer.capabilities.getMaxAnisotropy() : 1;
        t.needsUpdate = true;
        return t;
    }
    async function gibsImage(layer, time) {
        const q = (w) => `/api/gibs?layer=${encodeURIComponent(layer)}&w=${w}${time ? '&time=' + encodeURIComponent(time) : ''}`;
        try { return await loadImage(q(texW)); } catch { return await loadImage(q(2048)); }
    }
    const gibsTexture = async (layer, time) => makeTexture(await gibsImage(layer, time));

    // Fondu par luminance : l'imagerie GIBS n'a pas de vrai alpha (no-data = noir RGB opaque),
    // donc on ne peut pas fondre sur le canal alpha. On dessine le Blue Marble en dessous et
    // on n'applique les pixels du calque journalier que là où leur luminance dépasse le noir.
    function composeOver(overlayImg, baseImg, W, H) {
        const cv = document.createElement('canvas');
        cv.width = W; cv.height = H;
        const c2 = cv.getContext('2d', { willReadFrequently: true });
        c2.drawImage(baseImg, 0, 0, W, H);
        const out = c2.getImageData(0, 0, W, H);
        const ovCv = document.createElement('canvas');
        ovCv.width = W; ovCv.height = H;
        ovCv.getContext('2d', { willReadFrequently: true }).drawImage(overlayImg, 0, 0, W, H);
        const ov = ovCv.getContext('2d').getImageData(0, 0, W, H).data;
        const bd = out.data;
        for (let i = 0; i < bd.length; i += 4) {
            const lum = 0.2126 * ov[i] + 0.7152 * ov[i + 1] + 0.0722 * ov[i + 2];
            if (lum <= 8) continue;
            let k = (lum - 8) / 16; if (k > 1) k = 1;
            const inv = 1 - k;
            bd[i] = bd[i] * inv + ov[i] * k;
            bd[i + 1] = bd[i + 1] * inv + ov[i + 1] * k;
            bd[i + 2] = bd[i + 2] * inv + ov[i + 2] * k;
        }
        c2.putImageData(out, 0, 0);
        return cv;
    }
    // GIBS renvoie un JPEG noir (HTTP 200) quand la date demandée n'a pas d'imagerie —
    // c'est le cas du VIIRS SNPP, dont la publication GIBS est en retard d'~15 jours.
    // On détecte l'image « vide » et on remonte jusqu'à la date la plus récente publiée.
    function imageIsBlank(img) {
        const w = 256, h = 128;
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const c2 = cv.getContext('2d', { willReadFrequently: true });
        c2.drawImage(img, 0, 0, w, h);
        const d = c2.getImageData(0, 0, w, h).data;
        let nonBlank = 0, total = 0;
        for (let i = 0; i < d.length; i += 16) {             // échantillon 1 pixel sur 4
            // GIBS : no-data = noir opaque (JPEG) ou transparent (PNG) — les deux cas comptent
            if (d[i + 3] > 4 && 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2] > 8) nonBlank++;
            total++;
        }
        return nonBlank / total < 0.01;
    }
    const shiftDate = (d, days) => {
        const t = new Date(d + 'T12:00:00Z');
        t.setUTCDate(t.getUTCDate() - days);
        return t.toISOString().slice(0, 10);
    };
    async function resolveHasData(layer, fromDate, maxBack = 30) {
        const probe = async (date) => {
            try {
                // Image vide GIBS = réponse minuscule (< 1 Ko) : détection rapide avant décodage
                const url = `/api/gibs?layer=${encodeURIComponent(layer)}&w=1024&time=${encodeURIComponent(date)}`;
                const r = await fetch(url);
                if (!r.ok) return false;
                const len = +r.headers.get('Content-Length') || 0;
                if (len && len < 1000) return false;
                const img = await createImageBitmap(await r.blob());
                return !imageIsBlank(img);
            } catch { return false; }
        };
        if (await probe(fromDate)) return fromDate;
        for (let back = 1; back < maxBack; back += 4) {      // 4 dates en parallèle
            const window = [1, 2, 3, 4].map((o) => ({ off: o, dt: shiftDate(fromDate, back - 1 + o) }));
            const results = await Promise.all(window.map((w) => probe(w.dt).then((ok) => ({ ...w, ok }))));
            const hit = results.filter((r) => r.ok).sort((a, b) => a.off - b.off)[0];
            if (hit) return hit.dt;
        }
        return null;
    }
    const disposeTex = (t) => { if (t && t !== politicalTex) t.dispose(); };

    let baseToken = 0;
    async function applyBasemap() {
        const token = ++baseToken;
        store.set('basemap', bm.mode);
        uniforms.nightLevel.value = bm.mode === 'political' ? 0.5 : 0.12;
        if (bm.mode === 'political') {
            const old = uniforms.dayMap.value;
            uniforms.dayMap.value = politicalTex;
            disposeTex(old);
            setStatus('');
            return;
        }
        const layer = BASE_LAYERS[bm.mode];
        setStatus('chargement de l\'imagerie NASA…', '#fbbf24');
        try {
            let src, label;
            if (bm.mode === 'bluemarble') {
                src = await gibsImage(BASE_LAYERS.bluemarble, '');
                label = 'NASA Blue Marble';
            } else {
                // Fondu Terra/VIIRS + Blue Marble pour combler les trous orbitaux
                const date = bm.date;
                const good = await resolveHasData(layer, date);
                if (token !== baseToken) return;
                if (!good) throw new Error('imagerie indisponible');
                setStatus(`imagerie ${good !== date ? 'du ' + good : bm.date} + Blue Marble…`, '#fbbf24');
                const [baseRes, overRes] = await Promise.allSettled([
                    gibsImage(BASE_LAYERS.bluemarble, ''),
                    gibsImage(layer, good),
                ]);
                const over = overRes.status === 'fulfilled' ? overRes.value : null;
                if (!over) throw new Error('imagerie indisponible');
                if (baseRes.status === 'fulfilled') {
                    src = composeOver(over, baseRes.value, 2048, 1024);
                    label = `NASA GIBS ${good} + Blue Marble` + (good !== date ? ' (date la plus récente publiée)' : '');
                } else {
                    src = over;
                    label = `NASA GIBS — ${good}`;
                }
            }
            if (token !== baseToken) return;
            const tex = makeTexture(src);
            const old = uniforms.dayMap.value;
            uniforms.dayMap.value = tex;
            disposeTex(old);
            setStatus(label, '#4ade80');
        } catch (e) {
            if (token !== baseToken) return;
            setStatus('imagerie indisponible (date trop récente ?) — fond politique conservé', '#f87171');
            if (bm.mode !== 'political') {
                const old = uniforms.dayMap.value; uniforms.dayMap.value = politicalTex; disposeTex(old);
            }
        }
    }

    // Calque transparent
    let overlayMesh = null, overlayToken = 0;
    function overlayTime(layer) {
        if (layer === 'IMERG_Precipitation_Rate') {
            const d = new Date(Date.now() - 6 * 3600000);
            d.setUTCMinutes(d.getUTCMinutes() >= 30 ? 30 : 0, 0, 0);
            return d.toISOString().slice(0, 16) + ':00Z';
        }
        return bm.date;
    }
    async function applyOverlay() {
        const token = ++overlayToken;
        store.set('overlay', bm.overlay);
        if (overlayMesh) {
            globeGroup.remove(overlayMesh);
            overlayMesh.material.map && overlayMesh.material.map.dispose();
            overlayMesh.material.dispose(); overlayMesh.geometry.dispose();
            overlayMesh = null;
        }
        if (bm.overlay === 'none') return;
        setStatus('chargement du calque…', '#fbbf24');
        try {
            let time = overlayTime(bm.overlay);
            // Calques quotidiens (nuages, neige, aérosols…) : GIBS renvoie une image vide
            // si la date n'est pas encore publiée — on prend la plus récente dispo.
            if (bm.overlay !== 'IMERG_Precipitation_Rate') {
                const good = await resolveHasData(bm.overlay, bm.date);
                if (token !== overlayToken) return;
                if (good) time = good;
            }
            const tex = await gibsTexture(bm.overlay, time);
            if (token !== overlayToken) { tex.dispose(); return; }
            overlayMesh = new THREE.Mesh(
                new THREE.SphereGeometry(1.004, 64, 64),
                new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.85, depthWrite: false })
            );
            overlayMesh.renderOrder = 1;
            globeGroup.add(overlayMesh);
            const t0 = /^\d{4}-\d{2}-\d{2}$/.test(time) ? time : '';
            setStatus('Calque : ' + $('overlay').selectedOptions[0].textContent + (t0 && t0 !== bm.date ? ` (${t0})` : ''), '#4ade80');
        } catch {
            if (token === overlayToken) setStatus('calque indisponible pour cette date', '#f87171');
        }
    }

    async function applyNightLights() {
        store.set('nightlights', bm.night);
        $('toggle-nightlights').classList.toggle('active', bm.night);
        if (!bm.night) { uniforms.hasNight.value = 0; return; }
        try {
            const tex = await gibsTexture('VIIRS_Black_Marble', '');
            if (uniforms.nightMap.value && uniforms.nightMap.value !== blackTex) uniforms.nightMap.value.dispose();
            uniforms.nightMap.value = tex;
            uniforms.hasNight.value = 1;
        } catch {
            bm.night = false;
            $('toggle-nightlights').classList.remove('active');
            setStatus('lumières nocturnes indisponibles', '#f87171');
        }
    }

    $('basemap').value = bm.mode;
    $('overlay').value = bm.overlay;
    $('basemap-date').value = bm.date;
    $('basemap-date').max = utcDay(0);
    $('basemap').addEventListener('change', () => {
        bm.mode = $('basemap').value;
        // La choroplethe "Chiffres des pays" repose sur la carte politique
        if (bm.mode !== 'political' && ctx.stats && ctx.stats.visible()) {
            const btn = $('toggle-stats');
            if (btn) btn.click();
            setStatus('"Chiffres des pays" desactive (la choroplethe necessite la carte politique)', '#fbbf24');
        }
        applyBasemap();
        if (bm.mode === 'political' && ctx.stats && ctx.stats.visible()) ctx.stats.setTexture();
    });
    $('overlay').addEventListener('change', () => { bm.overlay = $('overlay').value; applyOverlay(); });
    $('basemap-date').addEventListener('change', () => {
        const v = $('basemap-date').value;
        if (!v) return;
        bm.date = v > utcDay(0) ? utcDay(0) : v;
        store.set('basemapDate', bm.date);
        if (bm.mode === 'terra' || bm.mode === 'viirs') applyBasemap();
        if (bm.overlay !== 'none') applyOverlay();
    });
    $('toggle-nightlights').addEventListener('click', () => { bm.night = !bm.night; applyNightLights(); });
    if (bm.mode !== 'political') applyBasemap();
    if (bm.overlay !== 'none') applyOverlay();
    if (bm.night) applyNightLights();

    // =====================================================================
    // 4. Aurores polaires + indice Kp (NOAA SWPC via /api/space-weather)
    // =====================================================================
    ctx.space = { kp: null, aurora: null };
    let auroraVisible = false, auroraPts = null;

    function auroraColor(v) {
        // 3-100 % : vert sombre -> vert vif -> jaune -> rose
        const c = new THREE.Color();
        if (v < 15) c.setRGB(0.05, 0.35 + v / 40, 0.15);
        else if (v < 40) c.setRGB(0.15 + (v - 15) / 60, 0.85, 0.25);
        else if (v < 70) c.setRGB(0.75, 0.9 - (v - 40) / 100, 0.3);
        else c.setRGB(0.95, 0.35, 0.65);
        return c;
    }
    function buildAurora() {
        if (auroraPts) { globeGroup.remove(auroraPts); auroraPts.geometry.dispose(); auroraPts.material.dispose(); auroraPts = null; }
        const a = ctx.space.aurora;
        if (!a || !a.points.length) return;
        const n = a.points.length, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            const [lon0, lat, v] = a.points[i];
            const lon = lon0 > 180 ? lon0 - 360 : lon0;
            const p = latLonToVector3(lat, lon, 1.006);
            pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
            const c = auroraColor(v);
            col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        auroraPts = new THREE.Points(g, new THREE.PointsMaterial({
            size: 4, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.75,
            depthWrite: false, blending: THREE.AdditiveBlending,
        }));
        auroraPts.frustumCulled = false;
        auroraPts.visible = auroraVisible;
        globeGroup.add(auroraPts);
    }
    function kpLabel(v) {
        const g = v >= 9 ? 'tempête G5' : v >= 8 ? 'tempête G4' : v >= 7 ? 'tempête G3' : v >= 6 ? 'tempête G2' : v >= 5 ? 'tempête G1' : v >= 4 ? 'agité' : 'calme';
        return g;
    }
    async function refreshSpace() {
        const st = $('aurora-status');
        try {
            const r = await fetch('/api/space-weather', { cache: 'no-store' });
            const j = await r.json();
            if (!j.ok) throw new Error(j.error);
            ctx.space.kp = j.data.kp || null;
            ctx.space.aurora = j.data.aurora || null;
            const kp = ctx.space.kp && ctx.space.kp.latest;
            $('kp-info').textContent = kp ? `🌌 Kp ${kp.kp.toFixed(1)} (${kpLabel(kp.kp)})` : '';
            const a = ctx.space.aurora;
            st.textContent = a ? `${kp ? 'Kp ' + kp.kp.toFixed(1) + ' · ' : ''}ovale auroral prévu (NOAA)` : 'données aurores indisponibles';
            st.style.color = a ? '#4ade80' : '#fbbf24';
            if (auroraVisible) buildAurora();
        } catch (e) {
            st.textContent = 'erreur de flux (NOAA SWPC)';
            st.style.color = '#f87171';
        }
    }
    $('toggle-aurora').addEventListener('click', () => {
        auroraVisible = !auroraVisible;
        $('toggle-aurora').classList.toggle('active', auroraVisible);
        if (auroraVisible) { ctx.space.aurora ? buildAurora() : refreshSpace(); }
        else if (auroraPts) auroraPts.visible = false;
    });
    refreshSpace();
    setInterval(refreshSpace, 10 * 60 * 1000);

    // =====================================================================
    // 5. Trace au sol + empreinte du satellite sélectionné
    // =====================================================================
    let trackSat = null, trackObj = null;
    function clearTrack() {
        if (trackObj) {
            globeGroup.remove(trackObj);
            trackObj.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
            trackObj = null;
        }
    }
    function geoAt(rec, date) {
        const pv = window.satellite.propagate(rec, date);
        if (!pv.position || pv.position.x === undefined || pv.position.x === null || pv.position.x === false) return null;
        const gmst = window.satellite.gstime(date);
        const g = window.satellite.eciToGeodetic(pv.position, gmst);
        return { lat: window.satellite.degreesLat(g.latitude), lon: window.satellite.degreesLong(g.longitude), altKm: Math.hypot(pv.position.x, pv.position.y, pv.position.z) - 6378.137 };
    }
    function rebuildTrack() {
        clearTrack();
        if (!trackSat || !window.satellite) return;
        const found = ctx.sats.find(trackSat.norad);
        if (!found) return;
        const now = Date.now();
        const group = new THREE.Group();
        const pts = [], cols = [];
        const past = new THREE.Color(0x7c3aed), fut = new THREE.Color(0xf0abfc);
        for (let m = -45; m <= 45; m++) {
            const g = geoAt(found.rec, new Date(now + m * 60000));
            if (!g) continue;
            pts.push(latLonToVector3(g.lat, g.lon, 1.006));
            const c = m < 0 ? past : fut;
            cols.push(c.r, c.g, c.b);
        }
        if (pts.length > 2) {
            const geo = new THREE.BufferGeometry().setFromPoints(pts);
            geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
            const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }));
            line.frustumCulled = false;
            group.add(line);
        }
        // Empreinte de visibilité (rayon angulaire = acos(R / (R + h)))
        const cur = geoAt(found.rec, new Date(now));
        if (cur) {
            const alpha = Math.acos(6371 / (6371 + Math.max(0, cur.altKm)));
            const { up, north, east } = tangentFrame(cur.lat, cur.lon);
            const ring = [];
            for (let k = 0; k <= 72; k++) {
                const b = (k / 72) * Math.PI * 2;
                const dir = north.clone().multiplyScalar(Math.cos(b)).add(east.clone().multiplyScalar(Math.sin(b)));
                ring.push(up.clone().multiplyScalar(Math.cos(alpha)).add(dir.multiplyScalar(Math.sin(alpha))).normalize().multiplyScalar(1.006));
            }
            const fl = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ring), new THREE.LineBasicMaterial({ color: 0xfde68a, transparent: true, opacity: 0.8 }));
            fl.frustumCulled = false;
            group.add(fl);
        }
        trackObj = group;
        globeGroup.add(group);
    }
    ctx.setTrackSat = (s) => { trackSat = s; rebuildTrack(); };
    setInterval(() => { if (trackSat) rebuildTrack(); }, 3000);

    // =====================================================================
    // 6. Outil de mesure (grand cercle)
    // =====================================================================
    let measuring = false, mPts = [], mObj = null;
    const clearMeasure = () => {
        if (mObj) { globeGroup.remove(mObj); mObj.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); mObj = null; }
    };
    function drawMeasure() {
        clearMeasure();
        const g = new THREE.Group();
        const mk = (p) => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.006, 10, 10), new THREE.MeshBasicMaterial({ color: 0xffd700 })); m.position.copy(latLonToVector3(p.lat, p.lon, 1.012)); return m; };
        mPts.forEach((p) => g.add(mk(p)));
        if (mPts.length === 2) {
            const a = latLonToVector3(mPts[0].lat, mPts[0].lon, 1).normalize(), b = latLonToVector3(mPts[1].lat, mPts[1].lon, 1).normalize();
            const w = Math.acos(Math.min(1, Math.max(-1, a.dot(b))));
            const arc = [];
            for (let i = 0; i <= 64; i++) {
                const t = i / 64;
                const v = w < 1e-6 ? a.clone() : a.clone().multiplyScalar(Math.sin((1 - t) * w) / Math.sin(w)).add(b.clone().multiplyScalar(Math.sin(t * w) / Math.sin(w)));
                arc.push(v.normalize().multiplyScalar(1.012 + 0.03 * Math.sin(Math.PI * t) * Math.min(1, w)));
            }
            g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(arc), new THREE.LineBasicMaterial({ color: 0xffd700 })));
        }
        mObj = g;
        globeGroup.add(g);
    }
    function measureCard() {
        const [A, B] = mPts;
        const φ1 = A.lat * D2R, φ2 = B.lat * D2R, dλ = (B.lon - A.lon) * D2R;
        const h = Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
        const km = 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
        const brg = (Math.atan2(Math.sin(dλ) * Math.cos(φ2), Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)) / D2R + 360) % 360;
        const f = (n, d = 0) => n.toLocaleString('fr-FR', { maximumFractionDigits: d });
        const hrs = km / 850;
        showCard({
            icon: '📏', title: `${f(km)} km`, subtitle: 'Distance à vol d\'oiseau (grand cercle)',
            rows: [['Miles', f(km * 0.621371)], ['Milles marins', f(km / 1.852)], ['Cap initial', `${f(brg)}°`],
                ['Avion (850 km/h)', `${Math.floor(hrs)} h ${String(Math.round((hrs % 1) * 60)).padStart(2, '0')}`],
                ['Départ', fmtLL(A.lat, A.lon)], ['Arrivée', fmtLL(B.lat, B.lon)], ['Tour de la Terre', `${f(km / 40075 * 100, 1)} %`]],
        });
    }
    const mBtn = $('btn-measure');
    mBtn.addEventListener('click', () => {
        measuring = !measuring;
        mBtn.classList.toggle('on', measuring);
        mPts = []; clearMeasure();
        ctx.container.style.cursor = measuring ? 'crosshair' : '';
        if (measuring) showCard({ icon: '📏', title: 'Mesure de distance', subtitle: 'Cliquez deux points sur le globe', rows: [] });
    });
    ctx.setClickInterceptor((lat, lon) => {
        if (!measuring) return false;
        if (mPts.length >= 2) { mPts = []; }
        mPts.push({ lat, lon });
        drawMeasure();
        if (mPts.length === 2) measureCard();
        else showCard({ icon: '📏', title: 'Mesure de distance', subtitle: 'Départ : ' + fmtLL(lat, lon) + ' — cliquez le point d\'arrivée', rows: [] });
        return true;
    });
}

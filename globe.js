import * as THREE from 'three';
import { esc, store, showCard, showCountryCard, showCityCard, loadCrew, setCursor, setZoomInfo, wmo, aqiLabel, initUI, diag } from './ui.js';
import { initExtras } from './extras.js';

// ---- Configuration ----
const ROTATION_SPEED = 0.003;
const TILT_SPEED = 0.002;
const AUTO_ROTATE_SPEED = 0.0006;
// Coordonnées vectorielles des côtes : Natural Earth 110m (TopoJSON, npm world-atlas)
// Téléchargées depuis https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json
const DATA_URL = 'data/countries-110m.json';
const COUNTRIES_URL = 'countries-data.json';

// ---- Éléments DOM ----
const container = document.getElementById('globe-canvas');
const $ = (id) => document.getElementById(id);
const D2R = Math.PI / 180;
const api = {};   // contexte partagé avec ui.js / extras.js (rempli dans init)

// ---- Zoom : distance caméra (le globe rayonne de 1, la caméra est sur +Z) ----
const MIN_CAMERA_DIST = 1.12;
const MAX_CAMERA_DIST = 10;
const ZOOM_BUTTON_STEP = 1.1;
let cameraDistance = 3.2;

function setCameraDistance(d) {
    cameraDistance = Math.min(MAX_CAMERA_DIST, Math.max(MIN_CAMERA_DIST, d));
    camera.position.z = cameraDistance;
    setZoomInfo(cameraDistance);
}

function zoomIn() { setCameraDistance(cameraDistance / ZOOM_BUTTON_STEP); }
function zoomOut() { setCameraDistance(cameraDistance * ZOOM_BUTTON_STEP); }
function resetView() {
    stopFollow();
    clearHighlight();
    flyTarget = { a: 0, b: 0, dist: 3.2 };
}

// ---- Liste des pays (nom français + capitale + coordonnées) : chargée depuis countries-data.json ----
// ---- Scène Three.js ----
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
    45,
    container.clientWidth / container.clientHeight,
    0.01,
    50
);
camera.position.set(0, 0, 3.2);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
container.appendChild(renderer.domElement);
window.addEventListener('error', (e) => diag('Erreur : ' + e.message + ' (' + String(e.filename || '').split('/').pop() + ':' + e.lineno + ')'));
window.addEventListener('unhandledrejection', (e) => diag('Erreur asynchrone : ' + (e.reason && e.reason.message || e.reason)));
if (renderer.debug) {
    renderer.debug.onShaderError = (gl, program, vs, fs) => {
        const log = (gl.getShaderInfoLog(fs) || gl.getShaderInfoLog(vs) || '').slice(0, 300);
        diag('Shader non compatible avec cette carte graphique — rendu simplifié activé. ' + log);
        if (api.onShaderError) api.onShaderError();
    };
}

// ---- Lumières ----
const ambientLight = new THREE.AmbientLight(0x404460, 1.5);
scene.add(ambientLight);

const sunLight = new THREE.DirectionalLight(0xffffff, 2.5);
sunLight.position.set(5, 3, 5);
scene.add(sunLight);

const fillLight = new THREE.DirectionalLight(0x4466aa, 0.8);
fillLight.position.set(-3, -2, -3);
scene.add(fillLight);

// ---- Groupe globe ----
const globeGroup = new THREE.Group();
scene.add(globeGroup);

let earthMesh = null;
let atmosphereMesh = null;

// ---- Navigation : vol vers un point, suivi d'un objet mobile ----
let flyTarget = null;       // { a, b, dist } angles cibles du groupe globe
let followRef = null;       // { kind, id } objet suivi
let followDist = null;
let clickInterceptor = null;
let dragDist = 0;
const wrapPi = (x) => ((x + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

function targetAngles(lat, lon) {
    const v = latLonToVector3(lat, lon, 1);
    return { a: Math.atan2(-v.x, v.z), b: Math.atan2(v.y, Math.hypot(v.x, v.z)) };
}
function flyTo(lat, lon, dist) {
    if (typeof lat !== 'number' || typeof lon !== 'number') return;
    const t = targetAngles(lat, lon);
    flyTarget = { a: t.a, b: t.b, dist: dist || null };
    if (autoRotate) toggleAutoRotate();
}
function follow(ref) {
    followRef = ref;
    followDist = flyTarget ? flyTarget.dist : null;
    $('btn-follow').hidden = !ref;
    if (ref && autoRotate) toggleAutoRotate();
}
function stopFollow() {
    followRef = null;
    followDist = null;
    $('btn-follow').hidden = true;
}
function vectorToLatLon(v) {
    const r = v.length() || 1;
    const lat = 90 - Math.acos(Math.max(-1, Math.min(1, v.y / r))) / D2R;
    let lon = Math.atan2(v.z, -v.x) / D2R - 180;
    if (lon < -180) lon += 360;
    return { lat, lon };
}

// ---- Sélection de pays par polygone (Natural Earth 110m, règle pair/impair) ----
let worldIndex = [];
const worldByName = new Map();
const countryByEn = new Map();
function buildWorldIndex(world) {
    worldIndex = world.map((c) => {
        const rings = c.rings.map(unwrapRing);
        let minLat = 90, maxLat = -90, minLon = 1e9, maxLon = -1e9;
        for (const r of rings) for (const [x, y] of r) {
            if (y < minLat) minLat = y; if (y > maxLat) maxLat = y;
            if (x < minLon) minLon = x; if (x > maxLon) maxLon = x;
        }
        return { name: c.name, rings, minLat, maxLat, minLon, maxLon };
    });
    for (const c of worldIndex) worldByName.set(c.name, c);
}
function pointInRing(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
        if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}
function countryAt(lat, lon) {
    for (const c of worldIndex) {
        if (lat < c.minLat || lat > c.maxLat) continue;
        for (const shift of [0, -360, 360]) {
            const lo = lon + shift;
            if (lo < c.minLon || lo > c.maxLon) continue;
            let inside = false;
            for (const r of c.rings) if (pointInRing(lo, lat, r)) inside = !inside;
            if (inside) return c;
        }
    }
    return null;
}
let highlightObj = null;
function clearHighlight() {
    if (!highlightObj) return;
    globeGroup.remove(highlightObj);
    highlightObj.geometry.dispose();
    highlightObj.material.dispose();
    highlightObj = null;
}
function highlightCountry(c) {
    clearHighlight();
    if (!c) return;
    const pos = [];
    for (const ring of c.rings) {
        for (let i = 0; i < ring.length - 1; i++) {
            if (Math.abs(ring[i + 1][0] - ring[i][0]) > 90) continue;
            const a = latLonToVector3(ring[i][1], ring[i][0], 1.009);
            const b = latLonToVector3(ring[i + 1][1], ring[i + 1][0], 1.009);
            pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    highlightObj = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffd700 }));
    highlightObj.frustumCulled = false;
    globeGroup.add(highlightObj);
}
function selectionChanged(kind) {
    if (kind !== 'sat' && api.setTrackSat) api.setTrackSat(null);
    if (kind !== 'country') clearHighlight();
}

// ---- Décodage TopoJSON (Natural Earth) : coordonnées vectorielles des côtes ----
function decodeTopology(topo) {
    const [sx, sy] = topo.transform.scale;
    const [tx, ty] = topo.transform.translate;

    // Décode les arcs en coordonnées lon/lat absolues
    const arcs = topo.arcs.map((arc) => {
        let x = 0, y = 0;
        return arc.map(([dx, dy]) => {
            x += dx;
            y += dy;
            return [x * sx + tx, y * sy + ty];
        });
    });

    // Reconstruit un anneau (liste de points) depuis des index d'arcs
    const decodeRing = (ring) => {
        let pts = [];
        for (const ai of ring) {
            let a = arcs[ai < 0 ? ~ai : ai];
            if (ai < 0) a = a.slice().reverse();
            pts = pts.concat(pts.length ? a.slice(1) : a);
        }
        return pts;
    };

    return topo.objects.countries.geometries.map((g) => {
        let rings = [];
        if (g.type === 'Polygon') {
            rings = g.arcs.map(decodeRing);
        } else if (g.type === 'MultiPolygon') {
            rings = g.arcs.map((r) => r.map(decodeRing)).flat();
        }
        return rings.length ? { name: g.properties.name, rings } : null;
    }).filter(Boolean);
}

// ---- Centroïde / aire d'un anneau (formule du sabot à cordon) ----
function ringArea(ring) {
    let a = 0;
    for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[i + 1];
        a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a / 2);
}

function ringCentroid(ring) {
    let area = 0, cx = 0, cy = 0;
    for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[i + 1];
        const cross = x1 * y2 - x2 * y1;
        area += cross;
        cx += (x1 + x2) * cross;
        cy += (y1 + y2) * cross;
    }
    area /= 2;
    if (Math.abs(area) < 1e-9) return null;
    return [cx / (6 * area), cy / (6 * area)];
}

function signedRingArea(ring) {
    let a = 0;
    for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[i + 1];
        a += x1 * y2 - x2 * y1;
    }
    return a / 2;
}

// ---- Centroïde géographique d'un pays (moyenne pondérée par l'aire,
//      les trous / îles inclus, à partir des anneaux Natural Earth) ----
function countryGeoCentroid(country) {
    let signedSum = 0, scx = 0, scy = 0;
    let absSum = 0, acx = 0, acy = 0;
    for (const ring of country.rings) {
        const c = ringCentroid(ring);
        if (!c) continue;
        const a = signedRingArea(ring);
        const aa = Math.abs(a);
        signedSum += a; scx += c[0] * a; scy += c[1] * a;
        absSum += aa; acx += c[0] * aa; acy += c[1] * aa;
    }
    if (Math.abs(signedSum) > 1e-9) return [scx / signedSum, scy / signedSum];
    if (absSum > 1e-9) return [acx / absSum, acy / absSum];
    return null;
}

// ---- Déroule un anneau en longitudes continues (évite les sauts ±180°) ----
function unwrapRing(ring) {
    const out = [[ring[0][0], ring[0][1]]];
    for (let i = 1; i < ring.length; i++) {
        let lon = ring[i][0];
        const prev = out[out.length - 1][0];
        while (lon - prev > 180) lon -= 360;
        while (lon - prev < -180) lon += 360;
        out.push([lon, ring[i][1]]);
    }
    return out;
}

// ---- Frontières + côtes vectorielles 3D (nettes à tout zoom) ----
// Construit des segments de ligne depuis les anneaux Natural Earth, sur un
// rayon légèrement supérieur au globe pour rester au-dessus de la texture.
function buildVectorLines(world) {
    const LINE_RADIUS = 1.006;
    const positions = [];
    let maxLon, minLon;

    for (const country of world) {
        for (const ring of country.rings) {
            const uw = unwrapRing(ring);
            for (let i = 0; i < uw.length - 1; i++) {
                // Saut > 90° = arc de grille à l'antiméridien : on saute
                const dLon = uw[i + 1][0] - uw[i][0];
                if (Math.abs(dLon) > 90) continue;
                const a = latLonToVector3(uw[i][1], uw[i][0], LINE_RADIUS);
                const b = latLonToVector3(uw[i + 1][1], uw[i + 1][0], LINE_RADIUS);
                positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
            }
        }
    }

    // Grille lat/lon + équateur, également vectorisés
    const SEG = 2;
    for (let lat = -60; lat <= 60; lat += 30) {
        for (let lon = -180; lon < 180; lon += SEG) {
            const a = latLonToVector3(lat, lon, LINE_RADIUS);
            const b = latLonToVector3(lat, lon + SEG, LINE_RADIUS);
            positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
        }
    }
    for (let lon = -180; lon < 180; lon += 30) {
        for (let lat = -88; lat < 88; lat += SEG) {
            const a = latLonToVector3(lat, lon, LINE_RADIUS);
            const b = latLonToVector3(lat + SEG, lon, LINE_RADIUS);
            positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
        }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.5,
    });
    const lines = new THREE.LineSegments(geometry, material);
    globeGroup.add(lines);
    return lines;
}

// ---- Couleur par pays (palette verte déterministe) ----
function hashColor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    const hue = 80 + (h % 60);
    const light = 30 + (h % 14);
    return `hsl(${hue}, 45%, ${light}%)`;
}

// ---- Texture Terre dessinée depuis les coordonnées vectorielles ----
function createEarthTexture(world, colorFor) {
    const canvas = document.createElement('canvas');
    canvas.width = 2048;
    canvas.height = 1024;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    // Fond océan
    const oceanGrad = ctx.createLinearGradient(0, 0, 0, h);
    oceanGrad.addColorStop(0, '#1a3a6a');
    oceanGrad.addColorStop(0.5, '#1e4d8f');
    oceanGrad.addColorStop(1, '#0d2a52');
    ctx.fillStyle = oceanGrad;
    ctx.fillRect(0, 0, w, h);

    // Dessin des pays réels (côtes + frontières Natural Earth).
    // Chaque anneau est dessiné 3 fois (décalé de -360°, 0, +360°) pour
    // couvrir les pays traversant l'antiméridien (Russie, Fidji, NZ...)
    // sans tracer de ligne traversant toute la carte.
    if (world.length) {
        for (const country of world) {
            const path = new Path2D();
            for (const ring of country.rings) {
                const uw = unwrapRing(ring);
                for (const shift of [-360, 0, 360]) {
                    uw.forEach(([lon, lat], i) => {
                        const x = (lon + 180 + shift) / 360 * w;
                        const y = (90 - lat) / 180 * h;
                        if (i === 0) path.moveTo(x, y);
                        else path.lineTo(x, y);
                    });
                    path.closePath();
                }
            }
            ctx.fillStyle = colorFor ? colorFor(country.name) : hashColor(country.name);
            ctx.fill(path, 'evenodd');
        }
    }

    // Frontières, côtes, grille lat/lon et équateur : dessinés vectoriellement
    // en 3D par buildVectorLines() (nets à tout zoom), plus ici sur la texture.

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

// ---- Choroplethe "Chiffres des pays" (Banque mondiale) ----
const STAT_STOPS = ['#1e3a8a', '#38bdf8', '#fbbf24', '#ef4444'].map((s) => parseInt(s.slice(1), 16));
function statLerp(t) {
    t = Math.max(0, Math.min(1, t));
    const f = t * (STAT_STOPS.length - 1);
    const i = Math.min(STAT_STOPS.length - 2, Math.floor(f));
    const k = f - i;
    const a = STAT_STOPS[i], b = STAT_STOPS[i + 1];
    const r = Math.round(((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * k);
    const g = Math.round(((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * k);
    const bl = Math.round((a & 255) + ((b & 255) - (a & 255)) * k);
    return { css: 'rgb(' + r + ',' + g + ',' + bl + ')', r, g, b };
}
let statsVisible = false;
let statsIndicator = store.get('statsIndicator', 'NY.GDP.PCAP.CD');
let statsValues = null;   // { [iso3]: number }
let statsYear = null;
let statsUnit = '';
let statsTexture = null;
let statsNameToCode = new Map();
let statsResolver = null; // (labelName, labelEn) -> ISO3, via liste WB + alias + inclusion
let worldRef = [];   // rempli dans init() (les polygones Natural Earth)
const STAT_NO_DATA = '#475569';

function fmtStatValue(v) {
    if (v == null || !isFinite(v)) return 'n/d';
    const a = Math.abs(v);
    if (a >= 1e6) return new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
    return v.toLocaleString('fr-FR', { maximumFractionDigits: a < 1 ? 2 : (a < 100 ? 1 : 0) });
}
function statColor(v, min, max) {
    if (v == null || !isFinite(v) || !isFinite(min) || !isFinite(max) || max <= min) return { css: STAT_NO_DATA, r: 0x47, g: 0x55, b: 0x69 };
    return statLerp((v - min) / (max - min));
}

function applyStats() {
    let min = Infinity, max = -Infinity;
    if (statsValues) for (const v of Object.values(statsValues)) {
        if (typeof v === 'number' && isFinite(v)) { if (v < min) min = v; if (v > max) max = v; }
    }
    if (!isFinite(min)) { min = 0; max = 1; }
    for (const label of labelElements) {
        const rec = label.country;
        const code = (statsResolver && statsResolver(rec.name, rec.en)) || statsNameToCode.get(rec.name) || statsNameToCode.get(rec.en);
        const v = code && statsValues ? statsValues[code] : undefined;
        const has = v !== undefined && v !== null && isFinite(v);
        const valEl = label.element.querySelector('.l-val');
        if (valEl) {
            valEl.textContent = has ? (fmtStatValue(v) + (statsUnit ? ' ' + statsUnit : '')) : 'n/d';
        }
        const c = statColor(has ? v : null, min, max);
        label.element.classList.toggle('has-val', has);
        label.element.style.color = c.css;
    }
    // Legende
    const lg = document.getElementById('stat-legend');
    if (lg) {
        const grad = 'linear-gradient(to right, ' + STAT_STOPS.map((s) => '#' + s.toString(16).padStart(6, '0')).join(', ') + ')';
        lg.style.display = 'block';
        lg.innerHTML =
            '<div class="stat-grad" style="background:' + grad + '"></div>' +
            '<div class="stat-ends"><span>' + fmtStatValue(min) + '</span><span>' + fmtStatValue(max) + (statsUnit ? ' ' + statsUnit : '') + '</span></div>' +
            '<div class="stat-meta">' + (statsYear ? statsYear + ' - ' : '') + 'grise = sans donnees (source : Banque mondiale)</div>';
    }
}

function rebuildStatsTexture(world) {
    const values = statsValues || {};
    const all = Object.values(values).filter((v) => typeof v === 'number' && isFinite(v));
    const min = all.length ? Math.min.apply(null, all) : 0;
    const max = all.length ? Math.max.apply(null, all) : 1;
    const colorBy = {};
    for (const [k, v] of Object.entries(values)) colorBy[k] = statColor(v, min, max);
    const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
    const tex = createEarthTexture(world, (name) => {
        // Recherche par nom exact, puis par nom normalise (sans accents/espaces).
        const code = (statsResolver && statsResolver(name, null)) || statsNameToCode.get(name) || statsNameToCode.get(norm(name));
        if (code && colorBy[code]) return colorBy[code].css;
        return statColor(null, min, max).css;
    });
    const old = statsTexture;
    statsTexture = tex;
    if (old && old.dispose) old.dispose();
    if (earthMesh) {
        if (earthMesh.material.uniforms && earthMesh.material.uniforms.dayMap) earthMesh.material.uniforms.dayMap.value = tex;
        else earthMesh.material.map = tex;
        earthMesh.material.needsUpdate = true;
    }
}

async function refreshStats() {
    const st = document.getElementById('stat-status');
    if (st) { st.textContent = 'chargement...'; st.style.color = '#a78bfa'; }
    try {
        const r = await fetch('/api/stats?indicator=' + encodeURIComponent(statsIndicator), { cache: 'no-store' });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || 'HTTP ' + r.status);
        statsValues = j.data && j.data.values || null;
        statsYear = j.data && j.data.year || null;
        statsUnit = j.data && j.data.unit || '';
        // Correspondance NOM (pays, en anglais) -> ISO3, extraite directement de
        // la reponse Banque mondiale (country.value). Independante de REST Countries.
        if (j.data && j.data.names) {
            const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
            for (const [iso3, nm] of Object.entries(j.data.names)) {
                if (!nm) continue;
                if (!statsNameToCode.has(nm)) statsNameToCode.set(nm, iso3);
                const nk = norm(nm);
                if (nk && !statsNameToCode.has(nk)) statsNameToCode.set(nk, iso3);
            }
        }
        if (st) {
            const n = statsValues ? Object.keys(statsValues).length : 0;
            st.textContent = 'OK ' + n + ' pays' + (statsYear ? ' (' + statsYear + ')' : '') + (j.stale ? ' - cache' : '');
            st.style.color = '#4ade80';
        }
        // La texture DOIT etre reconstruite apres le chargement des valeurs
        // (avant, elle etait construite avec statsValues=null -> tout gris).
        if (worldRef && worldRef.length) rebuildStatsTexture(worldRef);
        applyStats();
    } catch (e) {
        if (st) { st.textContent = 'erreur : ' + (e && e.message || e); st.style.color = '#f87171'; }
        if (worldRef && worldRef.length) rebuildStatsTexture(worldRef);
        applyStats();
    }
}

function activateStats() {
    const btn = document.getElementById('toggle-stats');
    if (btn) btn.classList.add('active');
    statsVisible = true;
    store.set('statsVisible', true);
    // La choroplethe repose sur la carte politique : on la force si besoin
    const sel = document.getElementById('basemap');
    if (sel && sel.value !== 'political') {
        sel.value = 'political';
        sel.dispatchEvent(new Event('change'));
    }
    // Correspondance nom (pays) -> code ISO3 via la LISTE OFFICIELLE Banque
    // mondiale (/api/stats/countries). REST Countries v3 est deprecie (301),
    // donc on ne depend plus de lui. On garde aussi le repli sur les noms WB
    // renvoyes par /api/stats (populate dans refreshStats).
    const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
    // Mapping direct nom du label (FR/EN normalise) -> code ISO3. Couvre les cas
    // ou le nom du label differe du nom officiel Banque mondiale (Slovaquie,
    // Turquie, Kirghizistan, RD Congo, Laos, Palestine, Taïwan, Falkland, etc.).
    const LABEL_ISO = {
        'slovaquie': 'SVK', 'slovakia': 'SVK',
        'turquie': 'TUR', 'turkey': 'TUR', 'turkiye': 'TUR',
        'kirghizistan': 'KGZ', 'kyrgyzstan': 'KGZ',
        'rdcongo': 'COD', 'demrepcongo': 'COD', 'congodemrep': 'COD',
        'laos': 'LAO',
        'palestine': 'PDR',
        'cotedivoire': 'CIV', "coted'ivoire": 'CIV',
        'isefalkland': 'FLK', 'falklandis': 'FLK',
        'antarctique': 'ATA', 'antarctica': 'ATA',
        'saharaoccidental': 'ESH', 'wsahara': 'ESH',
        'terresaustralesfrancaises': 'ATF', 'frsantarcticlands': 'ATF',
        'taiwan': 'TWN',
        'congo': 'COG',
        'coréedunord': 'PRK', 'northkorea': 'PRK',
        'coréedusud': 'KOR', 'southkorea': 'KOR',
    };
    function buildMapFrom(list) {
        // list : [{ iso3, name }] — source WB officielle (296 pays)
        const wbExact = {};
        const wbList = [];
        for (const r of list) {
            const nk = norm(r.name);
            if (nk) { wbExact[nk] = r.iso3; wbList.push({ iso: r.iso3, nk }); }
        }
        return (labelName, labelEn) => {
            // 1) mapping direct label -> ISO3 (casse des variantes de noms)
            for (const cand of [labelEn, labelName]) {
                if (!cand) continue;
                const nk = norm(cand);
                if (LABEL_ISO[nk]) return LABEL_ISO[nk];
            }
            // 2) nom exact = nom WB (normalise)
            for (const cand of [labelEn, labelName]) {
                const nk = norm(cand);
                if (nk && wbExact[nk]) return wbExact[nk];
            }
            // 3) inclusion (ex: "congo" -> "congorep") si unique
            for (const cand of [labelEn, labelName]) {
                const nk = norm(cand);
                if (!nk || nk.length < 3) continue;
                const hits = wbList.filter((x) => x.nk.includes(nk) || nk.includes(x.nk));
                if (hits.length === 1) return hits[0].iso;
            }
            return null;
        };
    }
    const finish = () => { rebuildStatsTexture(worldRef); refreshStats(); };
    if (statsResolver) { finish(); return; }
    else {
        fetch('/api/stats/countries', { cache: 'no-store' }).then((r) => r.json()).then((j) => {
            if (j.ok && Array.isArray(j.data) && j.data.length) {
                statsResolver = buildMapFrom(j.data);
                for (const rec of j.data) {
                    const nk = norm(rec.name);
                    if (nk && !statsNameToCode.has(nk)) statsNameToCode.set(nk, rec.iso3 || rec.id);
                }
            }
            finish();
        }).catch((e) => {
            const st = document.getElementById('stat-status');
            if (st) { st.textContent = 'erreur : ' + (e && e.message || e); st.style.color = '#f87171'; }
            finish();
        });
    }
}

function deactivateStats() {
    const btn = document.getElementById('toggle-stats');
    if (btn) btn.classList.remove('active');
    statsVisible = false;
    store.set('statsVisible', false);
    statsValues = null; statsYear = null; statsUnit = '';
    for (const label of labelElements) {
        const valEl = label.element.querySelector('.l-val');
        if (valEl) valEl.textContent = '';
        label.element.classList.remove('has-val');
        label.element.style.color = '';
    }
    const lg = document.getElementById('stat-legend');
    if (lg) lg.style.display = 'none';
    const sel = document.getElementById('basemap');
    if (sel && sel.value !== 'political') {
        sel.value = 'political';
        sel.dispatchEvent(new Event('change'));
    }
}

function toggleStats() {
    if (statsVisible) deactivateStats();
    else activateStats();
}

// ---- Conversion lat/lon -> vecteur 3D sur la sphère ----
function latLonToVector3(lat, lon, radius = 1.01) {
    const phi = (90 - lat) * (Math.PI / 180);
    const theta = (lon + 180) * (Math.PI / 180);
    const x = -(radius * Math.sin(phi) * Math.cos(theta));
    const y = radius * Math.cos(phi);
    const z = radius * Math.sin(phi) * Math.sin(theta);
    return new THREE.Vector3(x, y, z);
}

// ---- Étiquettes pays ----
const labelElements = [];

function buildLabels(countryList, world) {
    // Centroïdes géographiques calculés depuis les côtes Natural Earth, indexés par nom anglais
    const centroidsByName = {};
    for (const c of world) {
        const cd = countryGeoCentroid(c);
        if (cd) centroidsByName[c.name] = cd;
    }

    // Remanues manuelles : certains centroïdes sont déformés par des territoires
    // ultramarins, des archipels ou la ligne de date (Russie), donc on fixe
    // la position de l'étiquette sur la masse continentale principale.
    const labelOverrides = {
        'France': { lat: 46.6, lon: 2.5 },
        'Russie': { lat: 55.8, lon: 37.6 },
        'Russia': { lat: 55.8, lon: 37.6 },
        'États-Unis': { lat: 39.0, lon: -98.5 },
        'United States of America': { lat: 39.0, lon: -98.5 },
        'Canada': { lat: 56.0, lon: -106.0 },
        // Archipels / masses éparpillées : le centroïde géométrique tombe dans
        // l'océan. On ancre l'étiquette sur la masse principale.
        'Malaisie': { lat: 3.1, lon: 101.7 },   // péninsule (Kuala Lumpur)
        'Malaysia': { lat: 3.1, lon: 101.7 },
        'Indonésie': { lat: -7.0, lon: 110.0 }, // Java (centre)
        'Indonesia': { lat: -7.0, lon: 110.0 },
    };

    for (const country of countryList) {
        // Position sur le globe : priorité à la manuelle, sinon centroïde
        // géographique, sinon coordonnées du fichier countries-data.json
        const override = labelOverrides[country.en] || labelOverrides[country.name];
        let lat = country.lat;
        let lon = country.lon;
        if (override) {
            lat = override.lat;
            lon = override.lon;
        } else {
            const cd = centroidsByName[country.en] || centroidsByName[country.name];
            if (cd) {
                lon = cd[0];
                lat = cd[1];
            }
        }

        if (typeof lat !== 'number' || typeof lon !== 'number' || isNaN(lat) || isNaN(lon)) {
            continue;
        }

        const position = latLonToVector3(lat, lon, 1.02);

        // Point doré sur le globe
        const pointGeometry = new THREE.SphereGeometry(0.0035, 8, 8);
        const pointMaterial = new THREE.MeshBasicMaterial({ color: 0xffd700 });
        const pointMesh = new THREE.Mesh(pointGeometry, pointMaterial);
        pointMesh.position.copy(position);
        globeGroup.add(pointMesh);

        // Étiquette HTML projetée en temps réel
        const label = document.createElement('div');
        label.className = 'country-label';
        label.innerHTML = '<span class="l-name">' + country.name + '</span><span class="l-val"></span>';
        label.style.display = 'none';
        container.appendChild(label);

        labelElements.push({
            element: label,
            position: position.clone(),
            country: { ...country, lat, lon },
            mesh: pointMesh,
        });
    }
}

// ---- Avions (temps réel, OpenSky via /api/flights) ----
// Contour de chaque avion dessiné en segments de ligne (pas de remplissage),
// un seul LineSegments pour tous les vols. Ajouté au globeGroup : tourne avec
// le globe, net à tout zoom.
let flightsPoints = null;
let flightsVisible = false;
let labelsVisible = true;
let flightsCount = 0;
let flightsData = [];          // dernier jeu de vols (pour le clic)
let flightsPositions = [];     // positions 3D correspondantes

const PLANE_SCALE = 0.0018; // taille d'un avion (rayon du globe = 1)

// Silhouette d'avion vue de dessus (nez vers +X, ailes en ±Y) :
// uniquement le contour, dessiné en segments de ligne (pas de remplissage)
const PLANE_OUTLINE = [
    [0.62, 0], [0.45, 0.05], [0.30, 0.07], [0.10, 0.07],
    [0.02, 0.55], [-0.12, 0.60], [-0.20, 0.12], [-0.38, 0.10],
    [-0.42, 0.30], [-0.50, 0.32], [-0.55, 0.10], [-0.60, 0.05],
    [-0.62, 0],
    [-0.60, -0.05], [-0.55, -0.10], [-0.50, -0.32], [-0.42, -0.30],
    [-0.38, -0.10], [-0.20, -0.12], [-0.12, -0.60], [0.02, -0.55],
    [0.10, -0.07], [0.30, -0.07], [0.45, -0.05],
];

// Position sur la sphère avec léger décalage selon l'altitude (max ~0,05 rayon)
function altitudeRadius(lat, lon, altM) {
    const t = Math.max(0, Math.min(13000, altM || 0)) / 13000;
    return latLonToVector3(lat, lon, 1.012 + t * 0.05);
}

// Position + base tangentielle (nord, est) en un point lat/lon de la sphère
function tangentFrame(lat, lon) {
    const phi = (90 - lat) * (Math.PI / 180);
    const theta = (lon + 180) * (Math.PI / 180);
    const sp = Math.sin(phi), cp = Math.cos(phi);
    const ct = Math.cos(theta), st = Math.sin(theta);
    const up = new THREE.Vector3(-cp * ct, sp, cp * st).normalize();
    const north = new THREE.Vector3(cp * ct, sp, -cp * st).normalize();
    const east = new THREE.Vector3(sp * st, 0, sp * ct).normalize();
    return { up, north, east };
}

function buildFlightsMesh(flights) {
    if (flightsPoints) {
        globeGroup.remove(flightsPoints);
        flightsPoints.geometry.dispose();
        flightsPoints.material.dispose();
        flightsPoints = null;
    }
    if (!flights.length) return;

    // Contour de l'avion (pas de remplissage) : un segment par arête,
    // projeté dans l'espace monde -> un seul LineSegments, net à tout zoom.
    const N = PLANE_OUTLINE.length;
    const positions = new Float32Array(flights.length * N * 2 * 3);
    const colors = new Float32Array(flights.length * N * 2 * 3);
    const cGround = new THREE.Color(0x9fb4c8);
    const cAir = new THREE.Color(0x7dd3fc);
    const S = PLANE_SCALE;

    flightsData = flights;
    flightsPositions = new Array(flights.length);
    let idx = 0;
    for (let i = 0; i < flights.length; i++) {
        const f = flights[i];
        const { up, north, east } = tangentFrame(f.lat, f.lon);

        // Cap (track, horaire depuis le nord) -> vecteur de progression tangent
        const trackRad = (f.track != null ? f.track : 0) * (Math.PI / 180);
        const heading = north.clone()
            .multiplyScalar(Math.cos(trackRad))
            .add(east.clone().multiplyScalar(Math.sin(trackRad)))
            .normalize();
        const yAxis = new THREE.Vector3().crossVectors(up, heading).normalize();
        const pos = altitudeRadius(f.lat, f.lon, f.geoAlt);
        flightsPositions[i] = pos.clone();
        const c = f.onGround ? cGround : cAir;

        // Point local (lx, ly) -> monde : pos + heading*(lx*S) + yAxis*(ly*S)
        for (let k = 0; k < N; k++) {
            const a = PLANE_OUTLINE[k];
            const b = PLANE_OUTLINE[(k + 1) % N];
            positions[idx] = pos.x + (heading.x * a[0] + yAxis.x * a[1]) * S;
            positions[idx + 1] = pos.y + (heading.y * a[0] + yAxis.y * a[1]) * S;
            positions[idx + 2] = pos.z + (heading.z * a[0] + yAxis.z * a[1]) * S;
            colors[idx] = c.r; colors[idx + 1] = c.g; colors[idx + 2] = c.b;
            idx += 3;
            positions[idx] = pos.x + (heading.x * b[0] + yAxis.x * b[1]) * S;
            positions[idx + 1] = pos.y + (heading.y * b[0] + yAxis.y * b[1]) * S;
            positions[idx + 2] = pos.z + (heading.z * b[0] + yAxis.z * b[1]) * S;
            colors[idx] = c.r; colors[idx + 1] = c.g; colors[idx + 2] = c.b;
            idx += 3;
        }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.frustumCulled = false;
    lines.visible = flightsVisible;
    flightsPoints = lines;
    globeGroup.add(lines);
}

async function refreshFlights() {
    if (!flightsVisible) return;
    try {
        const r = await fetch('/api/flights', { cache: 'no-store' });
        const j = await r.json();
        if (!j.ok) throw { rateLimited: !!j.rateLimited, error: j.error || `HTTP ${r.status}`, retryInSec: j.retryInSec || 0 };
        flightsCount = j.count;
        buildFlightsMesh(j.flights);
        updateFlightStatus(false, j);
    } catch (e) {
        console.warn('Rafraîchissement vols:', e);
        updateFlightStatus(true, e);
    }
}

function updateFlightStatus(err, result) {
    const el = document.getElementById('flight-status');
    if (!el) return;
    if (err) {
        const rl = err && err.rateLimited;
        const retryMin = err && err.retryInSec ? Math.ceil(err.retryInSec / 60) : null;
        el.textContent = rl
            ? (retryMin ? `✈ OpenSky saturé — dans ~${retryMin} min` : '✈ OpenSky saturé (429)')
            : '✈ erreur de flux';
        el.title = (err && err.error) || 'Le serveur ou la source OpenSky n\'a pas répondu';
        el.style.color = '#f87171';
    } else if (result && result.stale) {
        el.textContent = `✈ ${flightsCount.toLocaleString('fr-FR')} en vol (cache)`;
        el.title = `Dernières données OpenSky du ${new Date(result.fetchedAt).toLocaleTimeString('fr-FR')} (source en refroidissement)`;
        el.style.color = '#fbbf24';
    } else {
        el.textContent = `✈ ${flightsCount.toLocaleString('fr-FR')} en vol (OpenSky)`;
        el.style.color = '#7dd3fc';
    }
}

function toggleFlights() {
    flightsVisible = !flightsVisible;
    if (flightsPoints) flightsPoints.visible = flightsVisible;
    const btn = document.getElementById('toggle-flights');
    btn.classList.toggle('active', flightsVisible);
    btn.title = flightsVisible
        ? 'Masquer les avions'
        : 'Afficher les avions (données temps réel OpenSky)';
    if (flightsVisible) refreshFlights();
    updateFlightStatus();
}

// Rafraîchissement périodique des vols (60 s) tant qu'ils sont visibles
setInterval(() => { if (flightsVisible) refreshFlights(); }, 60000);

// ---- Navires (temps réel, AIS via /api/ships) ----
// Contour de coque vu de dessus (poupe plate, étrave pointue), même échelle
// que les avions (PLANE_SCALE), couleur ambre pour les distinguer.
let shipsVisible = false;
let shipsPoints = null;
let shipsCount = 0;
let shipsData = [];
let shipsPositions = [];
const SHIP_STYLE = {
    cargo: { c: 0x4ade80, l: 'Cargo' }, tanker: { c: 0xf87171, l: 'Pétrolier / citerne' }, passenger: { c: 0x60a5fa, l: 'Passagers' },
    fishing: { c: 0xfde047, l: 'Pêche' }, tug: { c: 0xa3a3a3, l: 'Remorqueur / pilote' }, service: { c: 0x94a3b8, l: 'Service / secours' },
    pleasure: { c: 0xf472b6, l: 'Plaisance / voilier' }, highspeed: { c: 0x22d3ee, l: 'Navire rapide' }, military: { c: 0x78716c, l: 'Militaire' },
    other: { c: 0xfbbf24, l: 'Autre' }, unknown: { c: 0xfbbf24, l: 'Type non renseigné' },
};

// Coque vue de dessus (étrave pointue vers +X = direction d'avancement,
// poupe plate vers -X, largeur ±Y) — même convention que l'avion (nez vers +X)
const SHIP_OUTLINE = [
    [0.62, 0],
    [0.52, -0.08],
    [0.30, -0.16],
    [0.05, -0.22],
    [-0.18, -0.24],
    [-0.42, -0.22],
    [-0.60, -0.16],
    [-0.60, 0.16],
    [-0.42, 0.22],
    [-0.18, 0.24],
    [0.05, 0.22],
    [0.30, 0.16],
    [0.52, 0.08],
];

function buildShipsMesh(ships) {
    if (shipsPoints) {
        globeGroup.remove(shipsPoints);
        shipsPoints.geometry.dispose();
        shipsPoints.material.dispose();
        shipsPoints = null;
    }
    if (!ships.length) return;

    const N = SHIP_OUTLINE.length;
    const positions = new Float32Array(ships.length * N * 2 * 3);
    const colors = new Float32Array(ships.length * N * 2 * 3);
    const S = PLANE_SCALE;

    shipsData = ships;
    shipsPositions = new Array(ships.length);
    let idx = 0;
    for (let i = 0; i < ships.length; i++) {
        const s = ships[i];
        const { up, north, east } = tangentFrame(s.lat, s.lon);

        // Cap (COG, horaire depuis le nord) -> direction d'avancement
        const cogRad = (s.cog != null ? s.cog : 0) * (Math.PI / 180);
        const heading = north.clone()
            .multiplyScalar(Math.cos(cogRad))
            .add(east.clone().multiplyScalar(Math.sin(cogRad)))
            .normalize();
        const yAxis = new THREE.Vector3().crossVectors(up, heading).normalize();
        // À la surface : léger décalage au-dessus de l'eau (comme les avions bas)
        const pos = latLonToVector3(s.lat, s.lon, 1.012);
        shipsPositions[i] = pos.clone();
        const sc = new THREE.Color((SHIP_STYLE[s.cat] || SHIP_STYLE.unknown).c);

        for (let k = 0; k < N; k++) {
            const a = SHIP_OUTLINE[k];
            const b = SHIP_OUTLINE[(k + 1) % N];
            positions[idx] = pos.x + (heading.x * a[0] + yAxis.x * a[1]) * S;
            positions[idx + 1] = pos.y + (heading.y * a[0] + yAxis.y * a[1]) * S;
            positions[idx + 2] = pos.z + (heading.z * a[0] + yAxis.z * a[1]) * S;
            positions[idx + 3] = pos.x + (heading.x * b[0] + yAxis.x * b[1]) * S;
            positions[idx + 4] = pos.y + (heading.y * b[0] + yAxis.y * b[1]) * S;
            positions[idx + 5] = pos.z + (heading.z * b[0] + yAxis.z * b[1]) * S;
            for (let q = 0; q < 2; q++) { colors[idx + q * 3] = sc.r; colors[idx + q * 3 + 1] = sc.g; colors[idx + q * 3 + 2] = sc.b; }
            idx += 6;
        }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.frustumCulled = false;
    lines.visible = shipsVisible;
    shipsPoints = lines;
    globeGroup.add(lines);
}

async function refreshShips() {
    if (!shipsVisible) return;
    try {
        const r = await fetch('/api/ships', { cache: 'no-store' });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
        shipsCount = j.count;
        buildShipsMesh(j.ships);
        updateShipStatus(false, j);
    } catch (e) {
        console.warn('Rafraîchissement navires:', e);
        updateShipStatus(true, e);
    }
}

function updateShipStatus(err, result) {
    const el = document.getElementById('ship-status');
    if (!el) return;
    if (err) {
        el.textContent = '⚓ erreur de flux';
        el.title = 'Le serveur ou la source AIS n\'a pas répondu';
        el.style.color = '#f87171';
    } else if (!result.keyConfigured) {
        el.textContent = '⚓ clé AIS à configurer';
        el.title = 'Définissez la variable AISSTREAM_API_KEY (gratuite sur aisstream.io) ou créez un fichier .aisstream_key';
        el.style.color = '#fbbf24';
    } else {
        el.textContent = `⚓ ${shipsCount.toLocaleString('fr-FR')} navire(s) (AIS)`;
        el.style.color = '#fbbf24';
    }
}

function toggleShips() {
    shipsVisible = !shipsVisible;
    if (shipsPoints) shipsPoints.visible = shipsVisible;
    const btn = document.getElementById('toggle-ships');
    btn.classList.toggle('active', shipsVisible);
    btn.title = shipsVisible ? 'Masquer les navires' : 'Afficher les navires (données temps réel AIS)';
    if (shipsVisible) refreshShips();
}

// Rafraîchissement périodique des navires (20 s) tant qu'ils sont visibles
setInterval(() => { if (shipsVisible) refreshShips(); }, 20000);

// ---- Satellites (temps réel : TLE CelesTrak via /api/satellites + SGP4 satellite.js) ----
// Le serveur sert le catalogue TLE (≈ 10 000 objets actifs, cache 1 h). Côté
// navigateur on propage chaque orbite avec satellite.js (SGP4) à l'heure
// exacte du rafraîchissement, puis on affiche :
//  - un segment orienté dans la direction de la vitesse (comme avion/navire),
//  - un arc d'orbite (±3° d'argument central ≈ quelques minutes de vol).
// Le catalogue complet est trop dense (débris, LEO/MEO/GEO) : on garde les
// N_SATS premiers objets du groupe CelesTrak « active » dans une altitude
// raisonnable (200 km à 60 000 km, exclut le débris haut et le soleil/lune).
const N_SATS = 1200;
const ALT_MIN_KM = 200;
const ALT_MAX_KM = 60000;

let satsVisible = false;
let satsPoints = null;      // LineSegments : point + queue de chaque satellite
let satsOrbits = null;      // LineSegments : arcs d'orbite
let satsData = [];
let satsPositions = [];
let satsCount = 0;
let satsRecs = [];          // satrecs satellite.js (en parallèle de satsData)
let satsLoading = false;
let satsTleText = null;
let satsFetchedAt = 0;
let satsGroup = store.get('satGroup', 'active');
const SAT_SPECIAL = new Set(['25544', '48274', '20580']); // ISS, Tiangong, Hubble : toujours affichés

function satGeoFromEci(r, date) {
    const gmst = satellite.gstime(date);
    const g = satellite.eciToGeodetic(r, gmst);
    return {
        lat: satellite.degreesLat(g.latitude),
        lon: satellite.degreesLong(g.longitude),
        altKm: Math.hypot(r.x, r.y, r.z) - 6378.137,
    };
}

function buildSatMeshes() {
    if (!satsData.length) return;
    if (satsPoints) {
        globeGroup.remove(satsPoints);
        satsPoints.geometry.dispose();
        satsPoints.material.dispose();
        satsPoints = null;
    }
    if (satsOrbits) {
        globeGroup.remove(satsOrbits);
        satsOrbits.geometry.dispose();
        satsOrbits.material.dispose();
        satsOrbits = null;
    }

    const n = satsData.length;
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
    const pMat = new THREE.LineBasicMaterial({ color: 0xe879f9, transparent: true, opacity: 0.95 });
    satsPoints = new THREE.LineSegments(pGeo, pMat);
    satsPoints.frustumCulled = false;
    satsPoints.visible = satsVisible;
    globeGroup.add(satsPoints);

    const oGeo = new THREE.BufferGeometry();
    oGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 16 * 2 * 3), 3));
    const oMat = new THREE.LineBasicMaterial({ color: 0x8b5cf6, transparent: true, opacity: 0.30 });
    satsOrbits = new THREE.LineSegments(oGeo, oMat);
    satsOrbits.frustumCulled = false;
    satsOrbits.visible = satsVisible;
    globeGroup.add(satsOrbits);

    updateSatMeshes(true);
}

// Recalcule positions + arcs SGP4 à l'heure courante puis écrit les buffers.
function updateSatMeshes(withOrbits = true) {
    if (!satsPoints || !satsData.length) return;
    const now = new Date();
    const SEG = 16;                 // segments d'arc d'orbite
    const halfRad = 3 * (Math.PI / 180); // ±3° d'argument central

    const pPos = satsPoints.geometry.attributes.position.array;
    const oPos = satsOrbits.geometry.attributes.position.array;
    satsPositions = new Array(satsData.length);

    let pi = 0, oi = 0;
    for (let i = 0; i < satsData.length; i++) {
        const s = satsData[i];
        const pv = satellite.propagate(satsRecs[i], now);
        if (!pv.position || pv.position.x === null) continue;
        const geo = satGeoFromEci(pv.position, now);
        const pos = satRadius(geo.lat, geo.lon, geo.altKm);
        satsPositions[i] = pos.clone();
        s.lat = geo.lat; s.lon = geo.lon; s.altKm = geo.altKm;
        s.velKmS = Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z);

        // Orientation : deux propagations SGP4 (t, t+1s) -> vecteur vitesse
        // dans le repère globe, sans mélange ECI / ECEF.
        const nowPlus = new Date(now.getTime() + 1000);
        const pvNext = satellite.propagate(satsRecs[i], nowPlus);
        let vTan = new THREE.Vector3(0, 1, 0);
        if (pvNext.position && pvNext.position.x !== null) {
            const geoNext = satGeoFromEci(pvNext.position, nowPlus);
            const posNext = satRadius(geoNext.lat, geoNext.lon, geoNext.altKm);
            const v = posNext.clone().sub(pos);
            if (isFinite(v.x) && v.lengthSq() > 1e-12) vTan = v.normalize();
        }
        const S = s.special ? PLANE_SCALE * 3 : PLANE_SCALE;
        pPos[pi] = pos.x - vTan.x * S; pPos[pi + 1] = pos.y - vTan.y * S; pPos[pi + 2] = pos.z - vTan.z * S;
        pPos[pi + 3] = pos.x + vTan.x * S; pPos[pi + 4] = pos.y + vTan.y * S; pPos[pi + 5] = pos.z + vTan.z * S;
        pi += 6;

        // Arc d'orbite : propagation SGP4 à t ± k/SEG * halfRad / n_moyen
        const nRad = withOrbits ? satsRecs[i].no : 0; // rad/min
        if (!withOrbits) {
            // mise à jour des positions seules : les arcs gardent leur dernier calcul
        } else if (nRad > 0) {
            for (let k = 0; k < SEG; k++) {
                const d1 = ((k / SEG) - 0.5) * 2 * halfRad;
                const d2 = (((k + 1) / SEG) - 0.5) * 2 * halfRad;
                const d1Date = new Date(now.getTime() + (d1 / nRad) * 60000);
                const d2Date = new Date(now.getTime() + (d2 / nRad) * 60000);
                const q1 = satellite.propagate(satsRecs[i], d1Date);
                const q2 = satellite.propagate(satsRecs[i], d2Date);
                if (!q1.position || q1.position.x === null || !q2.position || q2.position.x === null) { oi += 6; continue; }
                const g1 = satGeoFromEci(q1.position, d1Date);
                const g2 = satGeoFromEci(q2.position, d2Date);
                const a1 = satRadius(g1.lat, g1.lon, g1.altKm);
                const a2 = satRadius(g2.lat, g2.lon, g2.altKm);
                oPos[oi] = a1.x; oPos[oi + 1] = a1.y; oPos[oi + 2] = a1.z;
                oPos[oi + 3] = a2.x; oPos[oi + 4] = a2.y; oPos[oi + 5] = a2.z;
                oi += 6;
            }
        } else {
            oi += SEG * 2 * 3;
        }
    }
    satsPoints.geometry.attributes.position.needsUpdate = true;
    satsOrbits.geometry.attributes.position.needsUpdate = true;
}

function satRadius(lat, lon, altKm) {
    const t = Math.max(0, Math.min(12000, altKm || 0)) / 12000;
    return latLonToVector3(lat, lon, 1.012 + t * 0.09);
}

// Parse le texte TLE CelesTrak (trièts nom/1/2) et propage le catalogue
// voulu. Renvoie { data, recs } — vide si satellite.js n'est pas chargé.
function parseTleCatalog(text) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const cands = [];
    for (let i = 1; i + 1 < lines.length; i++) {
        if (!lines[i].startsWith('1 ') || !lines[i + 1].startsWith('2 ')) continue;
        const name = lines[i - 1].trim();
        const l1 = lines[i], l2 = lines[i + 1];
        i += 1;
        let rec;
        try { rec = satellite.twoline2satrec(l1, l2); } catch { continue; }
        if (!rec || rec.error) continue;
        const norad = l1.substring(2, 7).trim();
        const a = rec.a * 6378.137, e = rec.ecco || 0;
        const perigee = a * (1 - e) - 6378.137, apogee = a * (1 + e) - 6378.137;
        if (!SAT_SPECIAL.has(norad) && (perigee < ALT_MIN_KM || apogee > ALT_MAX_KM)) continue;
        cands.push({ name: name.replace(/^\d{5}\s*/, ''), norad, rec });
    }
    // Échantillon réparti uniformément (au lieu des N premiers = les plus anciens)
    const specials = cands.filter((c) => SAT_SPECIAL.has(c.norad));
    const others = cands.filter((c) => !SAT_SPECIAL.has(c.norad));
    const room = Math.max(0, N_SATS - specials.length);
    let chosen = others;
    if (others.length > room) {
        const stride = others.length / room;
        chosen = [];
        for (let k = 0; k < room; k++) chosen.push(others[Math.floor(k * stride)]);
    }
    const out = [], recs = [];
    const now = new Date();
    for (const c of specials.concat(chosen)) {
        const pv = satellite.propagate(c.rec, now);
        if (!pv.position || pv.position.x === null || pv.position.x === false) continue;
        const geo = satGeoFromEci(pv.position, now);
        out.push({ name: c.name, norad: c.norad, special: SAT_SPECIAL.has(c.norad), lat: geo.lat, lon: geo.lon, altKm: geo.altKm, velKmS: Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z) });
        recs.push(c.rec);
    }
    return { data: out, recs };
}

function resetSats() {
    satsData = []; satsRecs = []; satsPositions = []; satsCount = 0; satsFetchedAt = 0; satsTleText = null;
    for (const k of ['satsPoints', 'satsOrbits']) {
        const o = k === 'satsPoints' ? satsPoints : satsOrbits;
        if (o) { globeGroup.remove(o); o.geometry.dispose(); o.material.dispose(); }
    }
    satsPoints = null; satsOrbits = null;
}

async function refreshSatellites() {
    if (!satsVisible && satsData.length) return;
    if (satsLoading) return;
    if (!window.satellite) {
        updateSatelliteStatus(true, { error: 'satellite.js non chargé (hors-ligne ?)' });
        return;
    }
    if (!satsData.length) {
        satsLoading = true;
        updateSatelliteStatus(true, { loading: true });
    }
    try {
        let tleText = null;
        if (!satsData.length || Date.now() - satsFetchedAt > 60 * 60 * 1000) {
            const r = await fetch('/api/satellites?group=' + encodeURIComponent(satsGroup), { cache: 'no-store' });
            const j = await r.json();
            if (!j.ok) throw { error: j.error || `HTTP ${r.status}`, stale: !!j.stale };
            tleText = j.tle;
            satsFetchedAt = Date.now();
        } else {
            tleText = satsTleText;
        }
        if (!satsData.length) {
            const cat = parseTleCatalog(tleText);
            satsData = cat.data;
            satsRecs = cat.recs;
            satsTleText = tleText;
            buildSatMeshes();
        } else {
            updateSatMeshes(true);
        }
        satsCount = satsData.length;
        updateSatelliteStatus(false, { count: satsCount });
    } catch (e) {
        console.warn('Rafraîchissement satellites:', e);
        updateSatelliteStatus(true, e);
    } finally {
        satsLoading = false;
    }
}

function updateSatelliteStatus(err, result) {
    const el = document.getElementById('satellite-status');
    if (!el) return;
    if (err) {
        if (result && result.loading) {
            el.textContent = '🛰 chargement du catalogue…';
            el.style.color = '#e879f9';
            el.title = 'Téléchargement des TLE CelesTrak (~10 000 objets)';
        } else {
            el.textContent = '🛰 erreur de flux';
            el.title = (result && result.error) || 'CelesTrak n\'a pas répondu';
            el.style.color = '#f87171';
        }
    } else if (result && result.stale) {
        el.textContent = `🛰 ${satsCount.toLocaleString('fr-FR')} satellites (TLE cache)`;
        el.title = 'Catalogue CelesTrak en cache (amont indisponible)';
        el.style.color = '#fbbf24';
    } else {
        el.textContent = `🛰 ${satsCount.toLocaleString('fr-FR')} satellites (temps réel)`;
        el.style.color = '#e879f9';
    }
}

function toggleSatellites() {
    satsVisible = !satsVisible;
    if (satsPoints) satsPoints.visible = satsVisible;
    if (satsOrbits) satsOrbits.visible = satsVisible;
    const btn = document.getElementById('toggle-satellites');
    btn.classList.toggle('active', satsVisible);
    btn.title = satsVisible
        ? 'Masquer les satellites'
        : 'Afficher les satellites (TLE CelesTrak, positions temps réel)';
    if (satsVisible) refreshSatellites();
}

// Rafraîchissement périodique (15 s) tant qu'ils sont visibles : on recalcule
// positions SGP4 à l'heure exacte, les arcs d'orbite suivent.
setInterval(() => { if (satsVisible) refreshSatellites(); }, 15000);
// Positions recalculées toutes les 2 s (mouvement fluide) ; les arcs d'orbite toutes les 15 s
setInterval(() => { if (satsVisible && satsPoints && satsData.length) updateSatMeshes(false); }, 2000);

async function goToSat(norad) {
    if (!satsVisible) $('toggle-satellites').click();
    let s = satsData.find((x) => x.norad === norad);
    if (!s) {
        if (satsGroup !== 'stations') {
            satsGroup = 'stations';
            store.set('satGroup', satsGroup);
            $('sat-group').value = satsGroup;
            resetSats();
            refreshSatellites();
        }
        for (let i = 0; i < 80 && !s; i++) {
            await new Promise((r) => setTimeout(r, 250));
            s = satsData.find((x) => x.norad === norad);
        }
    }
    if (s) { showSatInfo(s); flyTo(s.lat, s.lon, 2.0); follow({ kind: 'sat', id: norad }); }
}

// ---- Séismes (USGS GeoJSON, direct navigateur — CORS OK) ----
// Rafraîchi uniquement au chargement de la page et à l'activation du toggle
// (pas d'auto-refresh périodique). Anneau à la surface, diamètre proportionnel
// à la magnitude, couleur par classe.
const QUAKE_BASE = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/';
const QUAKE_FEEDS = {
    hour: { file: 'all_hour.geojson', label: 'heure dernière' },
    day: { file: 'all_day.geojson', label: '24 h' },
    week: { file: '2.5_week.geojson', label: '7 jours, M 2,5+' },
    month: { file: '4.5_month.geojson', label: '30 jours, M 4,5+' },
    sig: { file: 'significant_month.geojson', label: 'significatifs, 30 jours' },
};
let quakeWindow = store.get('quakeWindow', 'hour');
if (!QUAKE_FEEDS[quakeWindow]) quakeWindow = 'hour';

let quakesVisible = false;
let quakesRing = null;
let quakesData = [];
let quakesPositions = [];
let quakesCount = 0;
let quakesStale = false;

function quakeColor(mag) {
    if (mag >= 6) return new THREE.Color(0xef4444); // rouge
    if (mag >= 4) return new THREE.Color(0xfb923c); // orange
    if (mag >= 3) return new THREE.Color(0xfacc15); // jaune
    return new THREE.Color(0x4ade80);               // vert
}

function buildQuakesMesh(quakes) {
    if (quakesRing) {
        globeGroup.remove(quakesRing);
        quakesRing.geometry.dispose();
        quakesRing.material.dispose();
        quakesRing = null;
    }
    if (!quakes.length) return;

    const SEG = 18; // segments par anneau + 3 rayons (épicentre -> bord)
    const positions = new Float32Array(quakes.length * (SEG + 3) * 2 * 3);
    const colors = new Float32Array(quakes.length * (SEG + 3) * 2 * 3);

    quakesData = quakes;
    quakesPositions = new Array(quakes.length);
    let idx = 0;
    for (let i = 0; i < quakes.length; i++) {
        const q = quakes[i];
        const pos = latLonToVector3(q.lat, q.lon, 1.012);
        quakesPositions[i] = pos.clone();
        const r = 0.004 + (q.mag || 0) * 0.0035;
        const c = quakeColor(q.mag || 0);
        const { up, north, east } = tangentFrame(q.lat, q.lon);
        for (let k = 0; k < SEG; k++) {
            const a1 = (k / SEG) * Math.PI * 2;
            const a2 = ((k + 1) / SEG) * Math.PI * 2;
            const p1 = north.clone().multiplyScalar(Math.cos(a1) * r).add(east.clone().multiplyScalar(Math.sin(a1) * r));
            const p2 = north.clone().multiplyScalar(Math.cos(a2) * r).add(east.clone().multiplyScalar(Math.sin(a2) * r));
            positions[idx] = pos.x + p1.x; positions[idx + 1] = pos.y + p1.y; positions[idx + 2] = pos.z + p1.z;
            colors[idx] = c.r; colors[idx + 1] = c.g; colors[idx + 2] = c.b;
            idx += 3;
            positions[idx] = pos.x + p2.x; positions[idx + 1] = pos.y + p2.y; positions[idx + 2] = pos.z + p2.z;
            colors[idx] = c.r; colors[idx + 1] = c.g; colors[idx + 2] = c.b;
            idx += 3;
        }
        // Trois rayons (épicentre -> bord) pour matérialiser le point central
        for (let k = 0; k < 3; k++) {
            const a = (k / 3) * Math.PI * 2;
            const pe = north.clone().multiplyScalar(Math.cos(a) * r).add(east.clone().multiplyScalar(Math.sin(a) * r));
            positions[idx] = pos.x; positions[idx + 1] = pos.y; positions[idx + 2] = pos.z;
            colors[idx] = c.r; colors[idx + 1] = c.g; colors[idx + 2] = c.b;
            idx += 3;
            positions[idx] = pos.x + pe.x; positions[idx + 1] = pos.y + pe.y; positions[idx + 2] = pos.z + pe.z;
            colors[idx] = c.r; colors[idx + 1] = c.g; colors[idx + 2] = c.b;
            idx += 3;
        }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 });
    const lines = new THREE.LineSegments(geo, mat);
    lines.frustumCulled = false;
    lines.visible = quakesVisible;
    quakesRing = lines;
    globeGroup.add(lines);
}

async function fetchQuakes(url) {
    const r = await fetch(url, { cache: 'no-store' });
    const j = await r.json();
    const feats = (j && j.features) || [];
    return feats
        .map((f) => {
            const p = f.properties || {};
            const c = (f.geometry || {}).coordinates || [];
            return {
                id: f.id,
                mag: typeof p.mag === 'number' ? p.mag : null,
                place: p.place || '',
                time: p.time || null,
                depthKm: typeof c[2] === 'number' ? c[2] : null,
                lat: c[1],
                lon: c[0],
                url: p.url || '',
                tsunami: p.tsunami ? 1 : 0,
                felt: typeof p.felt === 'number' ? p.felt : null,
                alert: p.alert || '',
            };
        })
        .filter((q) =>
            typeof q.lat === 'number' && typeof q.lon === 'number' &&
            !isNaN(q.lat) && !isNaN(q.lon) &&
            q.lat >= -90 && q.lat <= 90 && q.lon >= -180 && q.lon <= 180
        )
        .sort((a, b) => (b.time || 0) - (a.time || 0));
}

async function refreshQuakes() {
    try {
        let quakes;
        try {
            quakes = await fetchQuakes(QUAKE_BASE + QUAKE_FEEDS[quakeWindow].file);
            quakesStale = false;
        } catch (e) {
            // Flux demandé indisponible : on retombe sur le flux 24 h (stale)
            quakes = await fetchQuakes(QUAKE_BASE + QUAKE_FEEDS.day.file);
            quakesStale = true;
        }
        quakesCount = quakes.length;
        buildQuakesMesh(quakes);
        updateQuakeStatus(false, quakes);
    } catch (e) {
        console.warn('Rafraîchissement séismes:', e);
        updateQuakeStatus(true, e);
    }
}

function updateQuakeStatus(err, result) {
    const el = document.getElementById('quake-status');
    if (!el) return;
    if (err) {
        el.textContent = '🌐 erreur de flux';
        el.title = 'USGS n\'a pas répondu (connexion ?)';
        el.style.color = '#f87171';
    } else if (quakesStale) {
        el.textContent = `🌐 ${quakesCount.toLocaleString('fr-FR')} séismes (24 h, flux de secours)`;
        el.style.color = '#fbbf24';
    } else {
        el.textContent = `🌐 ${quakesCount.toLocaleString('fr-FR')} séismes (${QUAKE_FEEDS[quakeWindow].label}, USGS)`;
        el.style.color = '#4ade80';
    }
}

function toggleQuakes() {
    quakesVisible = !quakesVisible;
    if (quakesRing) quakesRing.visible = quakesVisible;
    const btn = document.getElementById('toggle-quakes');
    btn.classList.toggle('active', quakesVisible);
    btn.title = quakesVisible
        ? 'Masquer les séismes'
        : 'Afficher les séismes (USGS, heure dernière)';
    if (quakesVisible) refreshQuakes();
}

// ---- EONET (NASA : événements naturels ouverts, direct navigateur) ----
// Toutes les catégories EONET (incendies, tempêtes, volcans, inondations, glaces…),
// filtrables par pastilles. Anneau coloré à la position la plus récente ; les
// événements avec trajectoire (tempêtes, icebergs) dessinent leur trace.
const EONET_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open';
const EONET_CATS = {
    wildfires: { label: 'Incendies', icon: '🔥', color: 0xfb923c },
    severeStorms: { label: 'Tempêtes', icon: '🌀', color: 0x38bdf8 },
    volcanoes: { label: 'Volcans', icon: '🌋', color: 0xef4444 },
    floods: { label: 'Inondations', icon: '🌊', color: 0x3b82f6 },
    seaLakeIce: { label: 'Glaces', icon: '🧊', color: 0xa5f3fc },
    drought: { label: 'Sécheresses', icon: '🏜', color: 0xd97706 },
    dustHaze: { label: 'Poussières / brume', icon: '🌫', color: 0xa8a29e },
    landslides: { label: 'Glissements', icon: '⛰', color: 0xb45309 },
    snow: { label: 'Neige', icon: '❄', color: 0xe0f2fe },
    tempExtremes: { label: 'Températures extrêmes', icon: '🌡', color: 0xf43f5e },
    waterColor: { label: 'Couleur de l\'eau', icon: '💧', color: 0x14b8a6 },
    manmade: { label: 'Origine humaine', icon: '🏭', color: 0xc084fc },
};

let eonetVisible = false;
let eonetGroup = null;
let eonetData = [];        // événements affichés (après filtre)
let eonetAll = [];         // tous les événements téléchargés
let eonetPositions = [];
const eonetOff = new Set(store.get('eonetOff', []));

function buildEonetMesh(events) {
    if (eonetGroup) {
        globeGroup.remove(eonetGroup);
        eonetGroup.traverse((o) => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) o.material.dispose();
        });
        eonetGroup = null;
    }
    eonetData = events;
    eonetPositions = new Array(events.length);
    if (!events.length) return;

    const ringPts = [], ringCols = [], pathPts = [], pathCols = [];
    for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        const cur = ev.current;
        const c = new THREE.Color(ev.color);
        const { north, east } = tangentFrame(cur.lat, cur.lon);
        const center = latLonToVector3(cur.lat, cur.lon, 1.012);
        eonetPositions[i] = center.clone();
        if (ev.path.length >= 2) {
            const path = ev.path.map((q) => latLonToVector3(q.lat, q.lon, 1.015)).filter((v) => isFinite(v.x) && isFinite(v.y) && isFinite(v.z));
            for (let k = 0; k < path.length - 1; k++) { pathPts.push(path[k], path[k + 1]); pathCols.push(c.r, c.g, c.b, c.r, c.g, c.b); }
        }
        const before = ringPts.length;
        pushRing(ringPts, center, ev.cat === 'wildfires' ? 0.006 : ev.cat === 'severeStorms' ? 0.01 : 0.008, north, east, 18);
        for (let k = before; k < ringPts.length; k++) ringCols.push(c.r, c.g, c.b);
    }

    const group = new THREE.Group();
    group.visible = eonetVisible;
    const mk = (pts, cols, opacity) => {
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
        const line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity }));
        line.frustumCulled = false;
        group.add(line);
    };
    if (ringPts.length) mk(ringPts, ringCols, 0.95);
    if (pathPts.length) mk(pathPts, pathCols, 0.5);
    eonetGroup = group;
    globeGroup.add(group);
}

// Écris les segments d'un anneau (paires de points) dans un tableau plat.
function pushRing(out, center, r, north, east, seg) {
    for (let k = 0; k < seg; k++) {
        const a1 = (k / seg) * Math.PI * 2;
        const a2 = ((k + 1) / seg) * Math.PI * 2;
        const p1 = center.clone()
            .add(north.clone().multiplyScalar(Math.cos(a1) * r))
            .add(east.clone().multiplyScalar(Math.sin(a1) * r));
        const p2 = center.clone()
            .add(north.clone().multiplyScalar(Math.cos(a2) * r))
            .add(east.clone().multiplyScalar(Math.sin(a2) * r));
        out.push(p1, p2);
    }
}

function applyEonetFilter() {
    buildEonetMesh(eonetAll.filter((e) => !eonetOff.has(e.cat)));
    updateEonetStatus(false);
}

async function refreshEonet() {
    try {
        const r = await fetch(EONET_URL, { cache: 'no-store' });
        if (!r.ok) {
            const err = new Error('EONET HTTP ' + r.status);
            err.status = r.status;
            throw err;
        }
        const j = await r.json();
        const raw = (j && j.events) || [];
        const valid = (v) => typeof v === 'number' && !isNaN(v);
        const events = [];
        for (const ev of raw) {
            const cat = (ev.categories || []).map((c) => c.id).find((id) => EONET_CATS[id]);
            if (!cat) continue;
            const path = [];
            for (const g of ev.geometry || []) {
                let lon, lat;
                if (g && g.type === 'Point' && Array.isArray(g.coordinates)) { lon = g.coordinates[0]; lat = g.coordinates[1]; }
                else if (g && g.type === 'Polygon' && Array.isArray(g.coordinates) && g.coordinates[0] && g.coordinates[0].length) {
                    const ring = g.coordinates[0];
                    lon = ring.reduce((a, q) => a + q[0], 0) / ring.length;
                    lat = ring.reduce((a, q) => a + q[1], 0) / ring.length;
                }
                if (!valid(lon) || !valid(lat)) continue;
                path.push({ lat, lon, date: g.date || null, magnitudeValue: g.magnitudeValue != null ? g.magnitudeValue : null, unit: g.magnitudeUnit || '' });
            }
            if (!path.length) continue;
            path.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
            const last = path[path.length - 1];
            const def = EONET_CATS[cat];
            events.push({
                id: ev.id, cat, label: def.label, icon: def.icon, color: def.color,
                name: (ev.title || 'Événement sans nom').trim(), desc: ev.description || '', link: ev.link || '',
                magnitudeValue: last.magnitudeValue, unit: last.unit, date: last.date, path,
                current: { lat: last.lat, lon: last.lon },
            });
        }
        eonetAll = events;
        applyEonetFilter();
    } catch (e) {
        console.warn('Rafraîchissement EONET:', e);
        updateEonetStatus(true, e);
    }
}

function updateEonetStatus(err, e) {
    const el = document.getElementById('eonet-status');
    if (!el) return;
    if (err) {
        const upstream = e && e.status >= 500;
        el.textContent = '🔥 erreur de flux';
        el.title = upstream
            ? 'NASA EONET est momentanément indisponible (HTTP ' + e.status + ') — réessayez au rechargement ou à la réactivation.'
            : 'NASA EONET n\'a pas répondu (connexion ?)';
        el.style.color = '#f87171';
        return;
    }
    const counts = {};
    for (const ev of eonetData) counts[ev.cat] = (counts[ev.cat] || 0) + 1;
    const txt = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${EONET_CATS[k].icon} ${n.toLocaleString('fr-FR')}`).join(' · ');
    el.textContent = `${eonetData.length.toLocaleString('fr-FR')} événement(s) ${txt ? '— ' + txt : ''} (NASA EONET)`;
    el.style.color = '#fb923c';
}

function toggleEonet() {
    eonetVisible = !eonetVisible;
    if (eonetGroup) eonetGroup.visible = eonetVisible;
    const btn = document.getElementById('toggle-eonet');
    btn.classList.toggle('active', eonetVisible);
    btn.title = eonetVisible
        ? 'Masquer les événements naturels'
        : 'Afficher les événements naturels (NASA EONET)';
    if (eonetVisible) refreshEonet();
}

// Rafraîchissement périodique (15 min) tant que la couche est visible
setInterval(() => { if (eonetVisible) refreshEonet(); }, 15 * 60 * 1000);

// ---- Météo (Open-Meteo, direct navigateur — CORS OK, sans clé) ----
// Météo actuelle (température, vent, pluie) sur un jeu de grandes villes du
// monde. Anneau à la surface, couleur par température (bleu -> rouge). Vent et
// précipitations détaillés au clic. Rafraîchi uniquement à l'activation du
// toggle (pas d'auto-refresh périodique).
const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';
const WEATHER_FIELDS = 'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_direction_10m,precipitation,weather_code,cloud_cover,surface_pressure';
const AIR_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';

// Grandes villes du monde (nom, pays, lat, lon) — couverture tous continents.
const WEATHER_CITIES = [
    // ---- Europe ----
    { name: 'Paris', country: 'France', lat: 48.8566, lon: 2.3522 },
    { name: 'Lyon', country: 'France', lat: 45.764, lon: 4.8357 },
    { name: 'Marseille', country: 'France', lat: 43.2961, lon: 5.3698 },
    { name: 'Toulouse', country: 'France', lat: 43.6047, lon: 1.4442 },
    { name: 'Bordeaux', country: 'France', lat: 44.8378, lon: -0.5792 },
    { name: 'Lille', country: 'France', lat: 50.6292, lon: 3.0573 },
    { name: 'Nantes', country: 'France', lat: 47.2184, lon: -1.5536 },
    { name: 'Strasbourg', country: 'France', lat: 48.5734, lon: 7.7521 },
    { name: 'Nice', country: 'France', lat: 43.7102, lon: 7.262 },
    { name: 'Montpellier', country: 'France', lat: 43.6108, lon: 3.8767 },
    { name: 'Londres', country: 'Royaume-Uni', lat: 51.5074, lon: -0.1278 },
    { name: 'Manchester', country: 'Royaume-Uni', lat: 53.4808, lon: -2.2426 },
    { name: 'Birmingham', country: 'Royaume-Uni', lat: 52.4862, lon: -1.8904 },
    { name: 'Glasgow', country: 'Royaume-Uni', lat: 55.8642, lon: -4.2518 },
    { name: 'Édimbourg', country: 'Royaume-Uni', lat: 55.9533, lon: -3.1883 },
    { name: 'Madrid', country: 'Espagne', lat: 40.4168, lon: -3.7038 },
    { name: 'Barcelone', country: 'Espagne', lat: 41.3874, lon: 2.1686 },
    { name: 'Valence', country: 'Espagne', lat: 39.4699, lon: -0.3763 },
    { name: 'Séville', country: 'Espagne', lat: 37.3891, lon: -5.9845 },
    { name: 'Lisbonne', country: 'Portugal', lat: 38.7223, lon: -9.1393 },
    { name: 'Porto', country: 'Portugal', lat: 41.1579, lon: -8.6291 },
    { name: 'Berlin', country: 'Allemagne', lat: 52.52, lon: 13.405 },
    { name: 'Hambourg', country: 'Allemagne', lat: 53.5511, lon: 9.9937 },
    { name: 'Munich', country: 'Allemagne', lat: 48.1351, lon: 11.582 },
    { name: 'Francfort', country: 'Allemagne', lat: 50.1109, lon: 8.6821 },
    { name: 'Cologne', country: 'Allemagne', lat: 50.9375, lon: 6.9603 },
    { name: 'Rome', country: 'Italie', lat: 41.9028, lon: 12.4964 },
    { name: 'Milan', country: 'Italie', lat: 45.4642, lon: 9.19 },
    { name: 'Naples', country: 'Italie', lat: 40.8518, lon: 14.2681 },
    { name: 'Florence', country: 'Italie', lat: 43.7696, lon: 11.2558 },
    { name: 'Moscou', country: 'Russie', lat: 55.7558, lon: 37.6173 },
    { name: 'Saint-Pétersbourg', country: 'Russie', lat: 59.9311, lon: 30.3609 },
    { name: 'Kazan', country: 'Russie', lat: 55.7963, lon: 49.1088 },
    { name: 'Yekaterinburg', country: 'Russie', lat: 56.8389, lon: 60.6057 },
    { name: 'Vladivostok', country: 'Russie', lat: 43.1155, lon: 131.8855 },
    { name: 'Istanbul', country: 'Turquie', lat: 41.0082, lon: 28.9784 },
    { name: 'Ankara', country: 'Turquie', lat: 39.9334, lon: 32.8597 },
    { name: 'Izmir', country: 'Turquie', lat: 38.4237, lon: 27.122 },
    { name: 'Amsterdam', country: 'Pays-Bas', lat: 52.3676, lon: 4.9041 },
    { name: 'Rotterdam', country: 'Pays-Bas', lat: 51.9244, lon: 4.4777 },
    { name: 'Bruxelles', country: 'Belgique', lat: 50.8503, lon: 4.3517 },
    { name: 'Anvers', country: 'Belgique', lat: 51.2194, lon: 4.4025 },
    { name: 'Zurich', country: 'Suisse', lat: 47.3769, lon: 8.5417 },
    { name: 'Genève', country: 'Suisse', lat: 46.2044, lon: 6.1432 },
    { name: 'Berne', country: 'Suisse', lat: 46.9481, lon: 7.4474 },
    { name: 'Vienne', country: 'Autriche', lat: 48.2082, lon: 16.3738 },
    { name: 'Varsovie', country: 'Pologne', lat: 52.2297, lon: 21.0122 },
    { name: 'Cracovie', country: 'Pologne', lat: 50.0647, lon: 19.945 },
    { name: 'Stockholm', country: 'Suède', lat: 59.3293, lon: 18.0686 },
    { name: 'Göteborg', country: 'Suède', lat: 57.7089, lon: 11.9746 },
    { name: 'Oslo', country: 'Norvège', lat: 59.9139, lon: 10.7522 },
    { name: 'Bergen', country: 'Norvège', lat: 60.3913, lon: 5.3221 },
    { name: 'Copenhague', country: 'Danemark', lat: 55.6761, lon: 12.5683 },
    { name: 'Helsinki', country: 'Finlande', lat: 60.1699, lon: 24.9384 },
    { name: 'Dublin', country: 'Irlande', lat: 53.3498, lon: -6.2603 },
    { name: 'Athènes', country: 'Grèce', lat: 37.9838, lon: 23.7275 },
    { name: 'Thessalonique', country: 'Grèce', lat: 40.6401, lon: 22.9444 },
    { name: 'Prague', country: 'Tchéquie', lat: 50.0755, lon: 14.4378 },
    { name: 'Budapest', country: 'Hongrie', lat: 47.4979, lon: 19.0402 },
    { name: 'Bucarest', country: 'Roumanie', lat: 44.4268, lon: 26.1025 },
    { name: 'Sofia', country: 'Bulgarie', lat: 42.6977, lon: 23.3219 },
    { name: 'Belgrade', country: 'Serbie', lat: 44.7866, lon: 20.4489 },
    { name: 'Zagreb', country: 'Croatie', lat: 45.815, lon: 15.9819 },
    { name: 'Ljubljana', country: 'Slovénie', lat: 46.0569, lon: 14.5058 },
    { name: 'Kiev', country: 'Ukraine', lat: 50.4501, lon: 30.5234 },
    { name: 'Reykjavik', country: 'Islande', lat: 64.1466, lon: -21.9426 },
    { name: 'Tallinn', country: 'Estonie', lat: 59.437, lon: 24.7536 },
    { name: 'Riga', country: 'Lettonie', lat: 56.9496, lon: 24.1052 },
    { name: 'Vilnius', country: 'Lituanie', lat: 54.6872, lon: 25.2797 },
    { name: 'Ponta Delgada', country: 'Portugal', lat: 37.751, lon: -25.6678 },
    // ---- Afrique ----
    { name: 'Le Caire', country: 'Égypte', lat: 30.0444, lon: 31.2357 },
    { name: 'Nairobi', country: 'Kenya', lat: -1.2921, lon: 36.8219 },
    { name: 'Mombasa', country: 'Kenya', lat: -4.0435, lon: 39.6682 },
    { name: 'Le Cap', country: 'Afrique du Sud', lat: -33.9249, lon: 18.4241 },
    { name: 'Johannesburg', country: 'Afrique du Sud', lat: -26.2041, lon: 28.0473 },
    { name: 'Durban', country: 'Afrique du Sud', lat: -29.8587, lon: 31.0218 },
    { name: 'Lagos', country: 'Nigéria', lat: 6.5244, lon: 3.3792 },
    { name: 'Kano', country: 'Nigéria', lat: 12.0022, lon: 8.592 },
    { name: 'Dakar', country: 'Sénégal', lat: 14.7167, lon: -17.4677 },
    { name: 'Tunis', country: 'Tunisie', lat: 36.8065, lon: 10.1815 },
    { name: 'Alger', country: 'Algérie', lat: 36.7538, lon: 3.0588 },
    { name: 'Casablanca', country: 'Maroc', lat: 33.5731, lon: -7.5898 },
    { name: 'Marrakech', country: 'Maroc', lat: 31.6295, lon: -7.9811 },
    { name: 'Khartoum', country: 'Soudan', lat: 15.5007, lon: 32.5599 },
    { name: 'Addis-Abeba', country: 'Éthiopie', lat: 9.03, lon: 38.74 },
    { name: 'Accra', country: 'Ghana', lat: 5.6037, lon: -0.187 },
    { name: 'Abidjan', country: 'Côte d’Ivoire', lat: 5.3599, lon: -4.0245 },
    { name: 'Luanda', country: 'Angola', lat: -8.839, lon: 13.2894 },
    { name: 'Dar es Salaam', country: 'Tanzanie', lat: -6.7924, lon: 39.2083 },
    { name: 'Harare', country: 'Zimbabwe', lat: -17.8292, lon: 31.0522 },
    { name: 'Yaoundé', country: 'Cameroun', lat: 3.8727, lon: 11.5186 },
    { name: 'Antananarivo', country: 'Madagascar', lat: -18.8792, lon: 47.5079 },
    { name: 'Maputo', country: 'Mozambique', lat: -25.9692, lon: 32.5732 },
    { name: 'Bamako', country: 'Mali', lat: 12.6392, lon: -8.0029 },
    { name: 'Ouagadougou', country: 'Burkina Faso', lat: 12.3714, lon: -1.5197 },
    { name: 'Libreville', country: 'Gabon', lat: 0.4226, lon: 9.45 },
    // ---- Moyen-Orient ----
    { name: 'Dubaï', country: 'Émirats arabes unis', lat: 25.2048, lon: 55.2708 },
    { name: 'Abu Dhabi', country: 'Émirats arabes unis', lat: 24.4539, lon: 54.3773 },
    { name: 'Téhéran', country: 'Iran', lat: 35.6892, lon: 51.389 },
    { name: 'Isfahan', country: 'Iran', lat: 32.6546, lon: 51.668 },
    { name: 'Machhad', country: 'Iran', lat: 36.2976, lon: 59.6163 },
    { name: 'Riyad', country: 'Arabie saoudite', lat: 24.7136, lon: 46.6753 },
    { name: 'Jeddah', country: 'Arabie saoudite', lat: 21.4858, lon: 39.1925 },
    { name: 'Tél-Aviv', country: 'Israël', lat: 32.0853, lon: 34.7818 },
    { name: 'Jérusalem', country: 'Israël', lat: 31.7683, lon: 35.2137 },
    { name: 'Bagdad', country: 'Irak', lat: 33.3152, lon: 44.3661 },
    { name: 'Amman', country: 'Jordanie', lat: 31.9539, lon: 35.9106 },
    { name: 'Beyrouth', country: 'Liban', lat: 33.8938, lon: 35.5018 },
    { name: 'Doha', country: 'Qatar', lat: 25.2868, lon: 51.5333 },
    { name: 'Koweït', country: 'Koweït', lat: 29.3759, lon: 47.9774 },
    { name: 'Mascate', country: 'Oman', lat: 23.588, lon: 58.382 },
    { name: 'Manama', country: 'Bahreïn', lat: 26.2285, lon: 50.586 },
    // ---- Asie ----
    { name: 'Dhaka', country: 'Bangladesh', lat: 23.8103, lon: 90.4125 },
    { name: 'Kathmandou', country: 'Népal', lat: 27.7172, lon: 85.324 },
    { name: 'New Delhi', country: 'Inde', lat: 28.6139, lon: 77.209 },
    { name: 'Mumbai', country: 'Inde', lat: 19.076, lon: 72.8777 },
    { name: 'Kolkata', country: 'Inde', lat: 22.5726, lon: 88.3639 },
    { name: 'Chennai', country: 'Inde', lat: 13.0827, lon: 80.2707 },
    { name: 'Bengaluru', country: 'Inde', lat: 12.9716, lon: 77.5946 },
    { name: 'Hyderabad', country: 'Inde', lat: 17.385, lon: 78.4867 },
    { name: 'Ahmedabad', country: 'Inde', lat: 23.0225, lon: 72.5714 },
    { name: 'Pune', country: 'Inde', lat: 18.5204, lon: 73.8567 },
    { name: 'Bangkok', country: 'Thaïlande', lat: 13.7563, lon: 100.5018 },
    { name: 'Chiang Mai', country: 'Thaïlande', lat: 18.7883, lon: 98.9853 },
    { name: 'Jakarta', country: 'Indonésie', lat: -6.2088, lon: 106.8456 },
    { name: 'Surabaya', country: 'Indonésie', lat: -7.2575, lon: 112.7521 },
    { name: 'Bandung', country: 'Indonésie', lat: -6.9175, lon: 107.6192 },
    { name: 'Medan', country: 'Indonésie', lat: 3.5952, lon: 98.6722 },
    { name: 'Denpasar', country: 'Indonésie', lat: -8.6705, lon: 115.2126 },
    { name: 'Manille', country: 'Philippines', lat: 14.5995, lon: 120.9842 },
    { name: 'Cebu', country: 'Philippines', lat: 9.2659, lon: 123.2312 },
    { name: 'Cagayan de Oro', country: 'Philippines', lat: 8.4542, lon: 124.5651 },
    { name: 'Singapour', country: 'Singapour', lat: 1.3521, lon: 103.8198 },
    { name: 'Kuala Lumpur', country: 'Malaisie', lat: 3.139, lon: 101.6869 },
    { name: 'Penang', country: 'Malaisie', lat: 5.4142, lon: 100.3289 },
    { name: 'Johor Bahru', country: 'Malaisie', lat: 1.4929, lon: 103.7411 },
    { name: 'Hanoï', country: 'Vietnam', lat: 21.0285, lon: 105.8542 },
    { name: 'Hô Chi Minh-Ville', country: 'Vietnam', lat: 10.8231, lon: 106.6297 },
    { name: 'Da Nang', country: 'Vietnam', lat: 16.0544, lon: 108.0 },
    { name: 'Pékin', country: 'Chine', lat: 39.9042, lon: 116.4074 },
    { name: 'Shanghai', country: 'Chine', lat: 31.2304, lon: 121.4737 },
    { name: 'Hong Kong', country: 'Chine', lat: 22.3193, lon: 114.1694 },
    { name: 'Guangzhou', country: 'Chine', lat: 23.1291, lon: 113.2644 },
    { name: 'Shenzhen', country: 'Chine', lat: 22.5431, lon: 114.0579 },
    { name: 'Chengdu', country: 'Chine', lat: 30.5728, lon: 104.0668 },
    { name: 'Wuhan', country: 'Chine', lat: 30.5928, lon: 114.3055 },
    { name: 'Taipei', country: 'Chine', lat: 25.033, lon: 121.5654 },
    { name: 'Tokyo', country: 'Japon', lat: 35.6762, lon: 139.6503 },
    { name: 'Osaka', country: 'Japon', lat: 34.6937, lon: 135.5023 },
    { name: 'Nagoya', country: 'Japon', lat: 35.1815, lon: 136.9066 },
    { name: 'Sapporo', country: 'Japon', lat: 43.0618, lon: 141.3545 },
    { name: 'Séoul', country: 'Corée du Sud', lat: 37.5665, lon: 126.978 },
    { name: 'Busan', country: 'Corée du Sud', lat: 35.1796, lon: 129.0756 },
    { name: 'Ulaanbaatar', country: 'Mongolie', lat: 47.8864, lon: 106.9057 },
    { name: 'Almaty', country: 'Kazakhstan', lat: 43.222, lon: 76.8512 },
    { name: 'Astana', country: 'Kazakhstan', lat: 51.1694, lon: 71.4491 },
    { name: 'Yangon', country: 'Myanmar', lat: 16.8661, lon: 96.2 },
    { name: 'Colombo', country: 'Sri Lanka', lat: 6.9271, lon: 79.8612 },
    { name: 'Karaçi', country: 'Pakistan', lat: 24.8607, lon: 67.0011 },
    { name: 'Lahore', country: 'Pakistan', lat: 31.5204, lon: 74.3587 },
    { name: 'Islamabad', country: 'Pakistan', lat: 33.6844, lon: 73.0479 },
    { name: 'Kaboul', country: 'Afghanistan', lat: 34.5553, lon: 69.2075 },
    { name: 'Tachkent', country: 'Ouzbékistan', lat: 41.2995, lon: 69.2401 },
    // ---- Amérique du Nord ----
    { name: 'Vancouver', country: 'Canada', lat: 49.2827, lon: -123.1207 },
    { name: 'Toronto', country: 'Canada', lat: 43.6532, lon: -79.3832 },
    { name: 'Montréal', country: 'Canada', lat: 45.5017, lon: -73.5673 },
    { name: 'Calgary', country: 'Canada', lat: 51.0447, lon: -114.0719 },
    { name: 'Edmonton', country: 'Canada', lat: 53.5461, lon: -113.4938 },
    { name: 'Québec', country: 'Canada', lat: 46.8139, lon: -71.208 },
    { name: 'New York', country: 'États-Unis', lat: 40.7128, lon: -74.006 },
    { name: 'Washington', country: 'États-Unis', lat: 38.9072, lon: -77.0369 },
    { name: 'Miami', country: 'États-Unis', lat: 25.7617, lon: -80.1918 },
    { name: 'Dallas', country: 'États-Unis', lat: 32.7767, lon: -96.797 },
    { name: 'Los Angeles', country: 'États-Unis', lat: 34.0522, lon: -118.2437 },
    { name: 'Chicago', country: 'États-Unis', lat: 41.8781, lon: -87.6298 },
    { name: 'San Francisco', country: 'États-Unis', lat: 37.7749, lon: -122.4194 },
    { name: 'Anchorage', country: 'États-Unis', lat: 61.2181, lon: -149.9003 },
    { name: 'Houston', country: 'États-Unis', lat: 29.7604, lon: -95.3698 },
    { name: 'Phoenix', country: 'États-Unis', lat: 33.4484, lon: -112.074 },
    { name: 'Boston', country: 'États-Unis', lat: 42.3601, lon: -71.0589 },
    { name: 'Seattle', country: 'États-Unis', lat: 47.6062, lon: -122.3321 },
    { name: 'Denver', country: 'États-Unis', lat: 39.7392, lon: -104.9903 },
    { name: 'Atlanta', country: 'États-Unis', lat: 33.749, lon: -84.388 },
    { name: 'Mexico', country: 'Mexique', lat: 19.4326, lon: -99.1332 },
    { name: 'Guadalajara', country: 'Mexique', lat: 20.6597, lon: -103.3496 },
    { name: 'Monterrey', country: 'Mexique', lat: 25.6866, lon: -100.3161 },
    { name: 'Havane', country: 'Cuba', lat: 23.1136, lon: -82.3666 },
    { name: 'Guatemala', country: 'Guatemala', lat: 14.6349, lon: -90.5069 },
    { name: 'Kingston', country: 'Jamaïque', lat: 17.9714, lon: -76.7932 },
    { name: 'Panama', country: 'Panama', lat: 8.9824, lon: -79.5199 },
    { name: 'Santo Domingo', country: 'République dominicaine', lat: 18.4861, lon: -69.9312 },
    { name: 'Port-au-Prince', country: 'Haïti', lat: 18.5392, lon: -72.3411 },
    // ---- Amérique du Sud ----
    { name: 'Santiago', country: 'Chili', lat: -33.4489, lon: -70.6693 },
    { name: 'Buenos Aires', country: 'Argentine', lat: -34.6037, lon: -58.3816 },
    { name: 'Córdoba', country: 'Argentine', lat: -31.4201, lon: -64.1888 },
    { name: 'Rosario', country: 'Argentine', lat: -32.9442, lon: -60.8233 },
    { name: 'Brasilia', country: 'Brésil', lat: -15.7942, lon: -47.8822 },
    { name: 'São Paulo', country: 'Brésil', lat: -23.5505, lon: -46.6333 },
    { name: 'Rio de Janeiro', country: 'Brésil', lat: -22.9068, lon: -43.1729 },
    { name: 'Salvador', country: 'Brésil', lat: -12.9714, lon: -38.5014 },
    { name: 'Porto Alegre', country: 'Brésil', lat: -30.0346, lon: -51.2177 },
    { name: 'Fortaleza', country: 'Brésil', lat: -3.7321, lon: -38.5277 },
    { name: 'Curitiba', country: 'Brésil', lat: -25.4284, lon: -49.2733 },
    { name: 'Bogota', country: 'Colombie', lat: 4.711, lon: -74.0721 },
    { name: 'Medellin', country: 'Colombie', lat: 6.2442, lon: -75.5812 },
    { name: 'Cali', country: 'Colombie', lat: 3.4516, lon: -76.532 },
    { name: 'Lima', country: 'Pérou', lat: -12.0464, lon: -77.0428 },
    { name: 'Cusco', country: 'Pérou', lat: -13.532, lon: -71.9675 },
    { name: 'Arequipa', country: 'Pérou', lat: -16.409, lon: -71.5375 },
    { name: 'Quito', country: 'Équateur', lat: -0.1807, lon: -78.4678 },
    { name: 'Caracas', country: 'Venezuela', lat: 10.4806, lon: -66.9036 },
    { name: 'Maracaibo', country: 'Venezuela', lat: 10.1521, lon: -68.0178 },
    { name: 'Montevideo', country: 'Uruguay', lat: -34.9011, lon: -56.1645 },
    { name: 'Asuncion', country: 'Paraguay', lat: -25.2637, lon: -57.5758 },
    { name: 'La Paz', country: 'Bolivie', lat: -16.5, lon: -68.15 },
    { name: 'Santa Cruz', country: 'Bolivie', lat: -17.7833, lon: -63.3167 },
    { name: 'Georgetown', country: 'Guyane', lat: 6.8013, lon: -58.1553 },
    { name: 'Paramaribo', country: 'Suriname', lat: 5.852, lon: -55.2038 },
    { name: 'Cayenne', country: 'Guyane', lat: 4.9331, lon: -52.3315 },
    // ---- Océanie ----
    { name: "Port Moresby", country: 'Papouasie-Nouvelle-Guinée', lat: -9.4438, lon: 147.1793 },
    { name: 'Auckland', country: 'Nouvelle-Zélande', lat: -36.8509, lon: 174.766 },
    { name: 'Wellington', country: 'Nouvelle-Zélande', lat: -41.2866, lon: 174.7756 },
    { name: 'Christchurch', country: 'Nouvelle-Zélande', lat: -43.5321, lon: 172.6362 },
    { name: 'Sydney', country: 'Australie', lat: -33.8688, lon: 151.2093 },
    { name: 'Melbourne', country: 'Australie', lat: -37.8136, lon: 144.9631 },
    { name: 'Brisbane', country: 'Australie', lat: -27.4698, lon: 153.0251 },
    { name: 'Perth', country: 'Australie', lat: -31.9505, lon: 115.8605 },
    { name: 'Adélaïde', country: 'Australie', lat: -34.9285, lon: 138.6007 },
    { name: 'Darwin', country: 'Australie', lat: -12.4634, lon: 130.8456 },
    { name: 'Hobart', country: 'Australie', lat: -42.8821, lon: 147.3272 },
    { name: 'Canberra', country: 'Australie', lat: -35.2809, lon: 149.13 },

    { name: 'Rennes', country: 'France', lat: 48.11, lon: -1.68 },
    { name: 'Grenoble', country: 'France', lat: 45.19, lon: 5.72 },
    { name: 'Saint-Étienne', country: 'France', lat: 45.44, lon: 4.39 },
    { name: 'Dijon', country: 'France', lat: 47.32, lon: 5.04 },
    { name: 'Rouen', country: 'France', lat: 49.44, lon: 1.1 },
    { name: 'Metz', country: 'France', lat: 49.12, lon: 6.17 },
    { name: 'Limoges', country: 'France', lat: 45.83, lon: 1.26 },
    { name: 'Toulon', country: 'France', lat: 43.12, lon: 5.93 },
    { name: 'Le Havre', country: 'France', lat: 49.49, lon: 0.11 },
    { name: 'Brest', country: 'France', lat: 48.39, lon: -4.49 },
    { name: 'Troyes', country: 'France', lat: 48.3, lon: 4.07 },
    { name: 'Amiens', country: 'France', lat: 49.89, lon: 2.3 },
    { name: 'Caen', country: 'France', lat: 49.18, lon: -0.37 },
    { name: 'Reims', country: 'France', lat: 49.26, lon: 4.03 },
    { name: 'Annecy', country: 'France', lat: 45.7, lon: 6.13 },
    { name: 'Angers', country: 'France', lat: 47.47, lon: -0.55 },
    { name: 'Clermont-Ferrand', country: 'France', lat: 45.78, lon: 3.08 },
    { name: 'La Rochelle', country: 'France', lat: 46.16, lon: -1.15 },
    { name: 'Calais', country: 'France', lat: 50.95, lon: 1.85 },
    { name: 'Nîmes', country: 'France', lat: 43.83, lon: 4.36 },
    { name: 'Liverpool', country: 'Royaume-Uni', lat: 53.41, lon: -2.99 },
    { name: 'Leeds', country: 'Royaume-Uni', lat: 53.8, lon: -1.55 },
    { name: 'Newcastle upon Tyne', country: 'Royaume-Uni', lat: 54.98, lon: -1.61 },
    { name: 'Bristol', country: 'Royaume-Uni', lat: 51.45, lon: -2.59 },
    { name: 'Brighton', country: 'Royaume-Uni', lat: 50.83, lon: -0.14 },
    { name: 'Cardiff', country: 'Pays de Galles', lat: 51.48, lon: -3.18 },
    { name: 'Swansea', country: 'Pays de Galles', lat: 51.62, lon: -3.94 },
    { name: 'Belfast', country: 'Irlande du Nord', lat: 54.59, lon: -5.93 },
    { name: 'Aberdeen', country: 'Écosse', lat: 57.15, lon: -2.09 },
    { name: 'Dundee', country: 'Écosse', lat: 56.46, lon: -2.97 },
    { name: 'Bilbao', country: 'Espagne', lat: 43.26, lon: -2.93 },
    { name: 'Zaragoza', country: 'Espagne', lat: 41.65, lon: -0.88 },
    { name: 'Murcie', country: 'Espagne', lat: 37.99, lon: -1.13 },
    { name: 'Alicante', country: 'Espagne', lat: 38.34, lon: -0.48 },
    { name: 'Granada', country: 'Espagne', lat: 37.18, lon: -3.59 },
    { name: 'Pamplona', country: 'Espagne', lat: 42.82, lon: -1.64 },
    { name: 'Santander', country: 'Espagne', lat: 43.46, lon: -3.8 },
    { name: 'Tarragone', country: 'Espagne', lat: 41.12, lon: 1.25 },
    { name: 'A Coruña', country: 'Espagne', lat: 43.36, lon: -8.41 },
    { name: 'Coimbra', country: 'Portugal', lat: 40.2, lon: -8.41 },
    { name: 'Braga', country: 'Portugal', lat: 41.55, lon: -8.42 },
    { name: 'Faro', country: 'Portugal', lat: 37.02, lon: -7.93 },
    { name: 'Aveiro', country: 'Portugal', lat: 40.64, lon: -8.65 },
    { name: 'Évora', country: 'Portugal', lat: 38.57, lon: -7.91 },
    { name: 'Setúbal', country: 'Portugal', lat: 38.53, lon: -8.89 },
    { name: 'Stuttgart', country: 'Allemagne', lat: 48.78, lon: 9.18 },
    { name: 'Düsseldorf', country: 'Allemagne', lat: 51.23, lon: 6.78 },
    { name: 'Leipzig', country: 'Allemagne', lat: 51.34, lon: 12.37 },
    { name: 'Dresde', country: 'Allemagne', lat: 51.05, lon: 13.74 },
    { name: 'Nuremberg', country: 'Allemagne', lat: 49.45, lon: 11.08 },
    { name: 'Dortmund', country: 'Allemagne', lat: 51.51, lon: 7.47 },
    { name: 'Essen', country: 'Allemagne', lat: 51.46, lon: 7.01 },
    { name: 'Bonn', country: 'Allemagne', lat: 50.73, lon: 7.1 },
    { name: 'Bremen', country: 'Allemagne', lat: 53.08, lon: 8.8 },
    { name: 'Kiel', country: 'Allemagne', lat: 54.32, lon: 10.13 },
    { name: 'Rostock', country: 'Allemagne', lat: 54.09, lon: 12.13 },
    { name: 'Magdebourg', country: 'Allemagne', lat: 52.13, lon: 11.63 },
    { name: 'Duisburg', country: 'Allemagne', lat: 51.43, lon: 6.76 },
    { name: 'Turin', country: 'Italie', lat: 45.07, lon: 7.69 },
    { name: 'Venise', country: 'Italie', lat: 45.44, lon: 12.32 },
    { name: 'Bologne', country: 'Italie', lat: 44.49, lon: 11.34 },
    { name: 'Gênes', country: 'Italie', lat: 44.41, lon: 8.93 },
    { name: 'Bari', country: 'Italie', lat: 41.12, lon: 16.87 },
    { name: 'Palerme', country: 'Italie', lat: 38.12, lon: 13.36 },
    { name: 'Catane', country: 'Italie', lat: 37.5, lon: 15.09 },
    { name: 'Vérone', country: 'Italie', lat: 45.44, lon: 10.99 },
    { name: 'Modène', country: 'Italie', lat: 44.65, lon: 10.92 },
    { name: 'Trieste', country: 'Italie', lat: 45.65, lon: 13.78 },
    { name: 'Reggio de Calabre', country: 'Italie', lat: 38.11, lon: 15.64 },
    { name: 'Pérouse', country: 'Italie', lat: 43.11, lon: 12.39 },
    { name: 'Novossibirsk', country: 'Russie', lat: 55.03, lon: 82.92 },
    { name: 'Nijni Novgorod', country: 'Russie', lat: 56.33, lon: 44 },
    { name: 'Krasnodar', country: 'Russie', lat: 45.04, lon: 38.97 },
    { name: 'Rostov-sur-le-Don', country: 'Russie', lat: 47.23, lon: 39.72 },
    { name: 'Perm', country: 'Russie', lat: 58.01, lon: 56.25 },
    { name: 'Volgograd', country: 'Russie', lat: 48.71, lon: 44.51 },
    { name: 'Samara', country: 'Russie', lat: 53.2, lon: 50.15 },
    { name: 'Omsk', country: 'Russie', lat: 54.99, lon: 73.37 },
    { name: 'Krasnoïarsk', country: 'Russie', lat: 56.01, lon: 92.87 },
    { name: 'Oul', country: 'Russie', lat: 56.83, lon: 49.39 },
    { name: 'Saratov', country: 'Russie', lat: 51.53, lon: 46.03 },
    { name: 'Tchebiarksk', country: 'Russie', lat: 55.16, lon: 61.41 },
    { name: 'Adana', country: 'Turquie', lat: 37, lon: 35.32 },
    { name: 'Gaziantep', country: 'Turquie', lat: 37.07, lon: 37.38 },
    { name: 'Kayseri', country: 'Turquie', lat: 38.73, lon: 35.49 },
    { name: 'Mersin', country: 'Turquie', lat: 36.85, lon: 34.63 },
    { name: 'Antalya', country: 'Turquie', lat: 36.89, lon: 30.71 },
    { name: 'Konya', country: 'Turquie', lat: 37.87, lon: 32.48 },
    { name: 'Diyarbakir', country: 'Turquie', lat: 37.91, lon: 40.23 },
    { name: 'Izmit', country: 'Turquie', lat: 40.77, lon: 29.92 },
    { name: 'Trabzon', country: 'Turquie', lat: 41, lon: 39.72 },
    { name: 'Eindhoven', country: 'Pays-Bas', lat: 51.42, lon: 5.47 },
    { name: 'Groningue', country: 'Pays-Bas', lat: 53.22, lon: 6.57 },
    { name: 'Utrecht', country: 'Pays-Bas', lat: 52.09, lon: 5.12 },
    { name: 'Tilburg', country: 'Pays-Bas', lat: 51.56, lon: 5.09 },
    { name: 'Maastricht', country: 'Pays-Bas', lat: 50.85, lon: 5.69 },
    { name: 'Arnhem', country: 'Pays-Bas', lat: 51.98, lon: 5.91 },
    { name: 'Zwolle', country: 'Pays-Bas', lat: 52.51, lon: 6.09 },
    { name: 'Breda', country: 'Pays-Bas', lat: 51.59, lon: 4.78 },
    { name: 'Gand', country: 'Belgique', lat: 51.05, lon: 3.72 },
    { name: 'Louvain', country: 'Belgique', lat: 50.88, lon: 4.7 },
    { name: 'Namur', country: 'Belgique', lat: 50.47, lon: 4.87 },
    { name: 'Liège', country: 'Belgique', lat: 50.63, lon: 5.57 },
    { name: 'Mons', country: 'Belgique', lat: 50.45, lon: 3.08 },
    { name: 'Charleroi', country: 'Belgique', lat: 50.41, lon: 4.44 },
    { name: 'Lucerne', country: 'Suisse', lat: 47.05, lon: 8.31 },
    { name: 'Saint-Gall', country: 'Suisse', lat: 47.42, lon: 9.38 },
    { name: 'Lausanne', country: 'Suisse', lat: 46.52, lon: 6.57 },
    { name: 'Neuchâtel', country: 'Suisse', lat: 46.99, lon: 6.93 },
    { name: 'Bâle', country: 'Suisse', lat: 47.56, lon: 7.59 },
    { name: 'Fribourg', country: 'Suisse', lat: 46.79, lon: 7.26 },
    { name: 'Vevey', country: 'Suisse', lat: 46.5, lon: 6.83 },
    { name: 'Sion', country: 'Suisse', lat: 46.19, lon: 7.36 },
    { name: 'Graz', country: 'Autriche', lat: 47.07, lon: 15.44 },
    { name: 'Salzbourg', country: 'Autriche', lat: 47.81, lon: 13.05 },
    { name: 'Innsbruck', country: 'Autriche', lat: 47.27, lon: 11.4 },
    { name: 'Linz', country: 'Autriche', lat: 48.31, lon: 14.29 },
    { name: 'Klagenfurt', country: 'Autriche', lat: 46.62, lon: 14.31 },
    { name: 'Gdańsk', country: 'Pologne', lat: 54.35, lon: 18.65 },
    { name: 'Szczecin', country: 'Pologne', lat: 53.43, lon: 14.55 },
    { name: 'Łódź', country: 'Pologne', lat: 51.75, lon: 19.46 },
    { name: 'Wrocław', country: 'Pologne', lat: 51.11, lon: 17.03 },
    { name: 'Gdynia', country: 'Pologne', lat: 54.52, lon: 18.53 },
    { name: 'Białystok', country: 'Pologne', lat: 53.13, lon: 23.16 },
    { name: 'Częstochowa', country: 'Pologne', lat: 50.81, lon: 19.12 },
    { name: 'Uppsala', country: 'Suède', lat: 59.86, lon: 17.64 },
    { name: 'Malmö', country: 'Suède', lat: 55.61, lon: 13 },
    { name: 'Umeå', country: 'Suède', lat: 63.83, lon: 20.26 },
    { name: 'Lund', country: 'Suède', lat: 55.71, lon: 13.19 },
    { name: 'Västerås', country: 'Suède', lat: 59.61, lon: 16.55 },
    { name: 'Trondheim', country: 'Norvège', lat: 63.43, lon: 10.39 },
    { name: 'Stavanger', country: 'Norvège', lat: 58.97, lon: 5.73 },
    { name: 'Tromsø', country: 'Norvège', lat: 69.65, lon: 18.96 },
    { name: 'Kristiansand', country: 'Norvège', lat: 58.15, lon: 8 },
    { name: 'Ålesund', country: 'Norvège', lat: 62.47, lon: 6.15 },
    { name: 'Aarhus', country: 'Danemark', lat: 56.16, lon: 10.21 },
    { name: 'Odense', country: 'Danemark', lat: 55.4, lon: 10.39 },
    { name: 'Aalborg', country: 'Danemark', lat: 57.05, lon: 9.92 },
    { name: 'Vejle', country: 'Danemark', lat: 55.57, lon: 9.08 },
    { name: 'Tampere', country: 'Finlande', lat: 61.5, lon: 23.76 },
    { name: 'Turku', country: 'Finlande', lat: 60.45, lon: 22.27 },
    { name: 'Oulu', country: 'Finlande', lat: 65.01, lon: 25.47 },
    { name: 'Lahti', country: 'Finlande', lat: 60.98, lon: 25.7 },
    { name: 'Pori', country: 'Finlande', lat: 61.51, lon: 21.81 },
    { name: 'Cork', country: 'Irlande', lat: 51.9, lon: -8.47 },
    { name: 'Galway', country: 'Irlande', lat: 53.27, lon: -9.06 },
    { name: 'Limerick', country: 'Irlande', lat: 52.66, lon: -8.62 },
    { name: 'Derry', country: 'Irlande du Nord', lat: 55, lon: -7.29 },
    { name: 'Waterford', country: 'Irlande', lat: 52.25, lon: -7.11 },
    { name: 'Sligo', country: 'Irlande', lat: 54.27, lon: -8.48 },
    { name: 'Patras', country: 'Grèce', lat: 38.25, lon: 21.73 },
    { name: 'Héraklion', country: 'Grèce', lat: 35.34, lon: 25.13 },
    { name: 'Larissa', country: 'Grèce', lat: 39.64, lon: 22.42 },
    { name: 'Ioannina', country: 'Grèce', lat: 39.75, lon: 20.94 },
    { name: 'Volos', country: 'Grèce', lat: 39.36, lon: 22.94 },
    { name: 'Kalamata', country: 'Grèce', lat: 37.07, lon: 22.11 },
    { name: 'Chania', country: 'Grèce', lat: 35.5, lon: 24.13 },
    { name: 'Rhodes', country: 'Grèce', lat: 36.44, lon: 28.22 },
    { name: 'Brno', country: 'Tchéquie', lat: 49.2, lon: 16.61 },
    { name: 'Ostrava', country: 'Tchéquie', lat: 49.82, lon: 18.28 },
    { name: 'Plzeň', country: 'Tchéquie', lat: 49.75, lon: 13.67 },
    { name: 'Olomouc', country: 'Tchéquie', lat: 49.59, lon: 17.25 },
    { name: 'Liberec', country: 'Tchéquie', lat: 50.77, lon: 15.05 },
    { name: 'Debrecen', country: 'Hongrie', lat: 47.53, lon: 21.62 },
    { name: 'Miskolc', country: 'Hongrie', lat: 48.16, lon: 20.76 },
    { name: 'Szeged', country: 'Hongrie', lat: 46.25, lon: 20.3 },
    { name: 'Pécs', country: 'Hongrie', lat: 46.07, lon: 18.23 },
    { name: 'Győr', country: 'Hongrie', lat: 47.67, lon: 17.62 },
    { name: 'Cluj-Napoca', country: 'Roumanie', lat: 46.77, lon: 23.59 },
    { name: 'Timișoara', country: 'Roumanie', lat: 45.76, lon: 21.23 },
    { name: 'Iași', country: 'Roumanie', lat: 47.16, lon: 27.6 },
    { name: 'Constanța', country: 'Roumanie', lat: 44.18, lon: 28.65 },
    { name: 'Craiova', country: 'Roumanie', lat: 44.33, lon: 23.8 },
    { name: 'Plovdiv', country: 'Bulgarie', lat: 42.15, lon: 24.75 },
    { name: 'Varna', country: 'Bulgarie', lat: 43.2, lon: 27.91 },
    { name: 'Bourgas', country: 'Bulgarie', lat: 42.5, lon: 27.47 },
    { name: 'Rousé', country: 'Bulgarie', lat: 43.83, lon: 26.05 },
    { name: 'Novi Sad', country: 'Serbie', lat: 45.25, lon: 19.84 },
    { name: 'Niš', country: 'Serbie', lat: 43.32, lon: 21.9 },
    { name: 'Kragujevac', country: 'Serbie', lat: 44.01, lon: 20.92 },
    { name: 'Split', country: 'Croatie', lat: 43.51, lon: 16.44 },
    { name: 'Rijeka', country: 'Croatie', lat: 45.33, lon: 14.21 },
    { name: 'Zadar', country: 'Croatie', lat: 44.12, lon: 15.23 },
    { name: 'Osijek', country: 'Croatie', lat: 46.11, lon: 18.33 },
    { name: 'Maribor', country: 'Slovénie', lat: 46.55, lon: 15.65 },
    { name: 'Celje', country: 'Slovénie', lat: 46.22, lon: 15.25 },
    { name: 'Khariv', country: 'Ukraine', lat: 49.99, lon: 36.23 },
    { name: 'Dnipro', country: 'Ukraine', lat: 48.47, lon: 35.04 },
    { name: 'Zaporijjia', country: 'Ukraine', lat: 47.89, lon: 35.15 },
    { name: 'Lviv', country: 'Ukraine', lat: 49.84, lon: 24.03 },
    { name: 'Vinnitsia', country: 'Ukraine', lat: 49.23, lon: 28.47 },
    { name: 'Odesa', country: 'Ukraine', lat: 46.48, lon: 30.73 },
    { name: 'Khmelnivka', country: 'Ukraine', lat: 49.42, lon: 26.98 },
    { name: 'Akureyri', country: 'Islande', lat: 65.68, lon: -18.09 },
    { name: 'Höfn', country: 'Islande', lat: 64.26, lon: -15.21 },
    { name: 'Tartu', country: 'Estonie', lat: 58.38, lon: 26.71 },
    { name: 'Pärnu', country: 'Estonie', lat: 58.35, lon: 24.51 },
    { name: 'Ventspils', country: 'Lettonie', lat: 57.39, lon: 21.56 },
    { name: 'Liepāja', country: 'Lettonie', lat: 56.51, lon: 21.01 },
    { name: 'Šiauliai', country: 'Lituanie', lat: 55.93, lon: 23.29 },
    { name: 'Kaunas', country: 'Lituanie', lat: 54.9, lon: 23.9 },
    { name: 'Bakou', country: 'Azerbaïdjan', lat: 40.41, lon: 49.87 },
    { name: 'Gandja', country: 'Azerbaïdjan', lat: 40.67, lon: 47.32 },
    { name: 'Erevan', country: 'Arménie', lat: 40.18, lon: 44.51 },
    { name: 'Gyumri', country: 'Arménie', lat: 40.76, lon: 44.37 },
    { name: 'Tbilissi', country: 'Géorgie', lat: 41.72, lon: 44.79 },
    { name: 'Koutaïsi', country: 'Géorgie', lat: 42.14, lon: 42.69 },
    { name: 'Batoumi', country: 'Géorgie', lat: 41.65, lon: 41.64 },
    { name: 'Zougli', country: 'Géorgie', lat: 42.59, lon: 41.5 },
    { name: 'Nicosie', country: 'Chypre', lat: 35.17, lon: 33.36 },
    { name: 'Limassol', country: 'Chypre', lat: 34.69, lon: 33.04 },
    { name: 'Larnaca', country: 'Chypre', lat: 34.92, lon: 33.62 },
    { name: 'Chisinau', country: 'Moldavie', lat: 47.01, lon: 28.86 },
    { name: 'Tiraspol', country: 'Moldavie', lat: 46.86, lon: 29.61 },
    { name: 'Skopje', country: 'Macédoine du Nord', lat: 42, lon: 21.43 },
    { name: 'Bitola', country: 'Macédoine du Nord', lat: 41.02, lon: 21.32 },
    { name: 'Tirana', country: 'Albanie', lat: 41.33, lon: 19.82 },
    { name: 'Durazzo', country: 'Albanie', lat: 41.33, lon: 19.45 },
    { name: 'Vlorë', country: 'Albanie', lat: 40.47, lon: 19.51 },
    { name: 'Shkodër', country: 'Albanie', lat: 42.07, lon: 19.51 },
    { name: 'Sarajevo', country: 'Bosnie-Herzégovine', lat: 43.86, lon: 18.41 },
    { name: 'Banja Luka', country: 'Bosnie-Herzégovine', lat: 44.77, lon: 17.19 },
    { name: 'Mostar', country: 'Bosnie-Herzégovine', lat: 43.34, lon: 17.81 },
    { name: 'Podgorica', country: 'Monténégro', lat: 42.44, lon: 19.26 },
    { name: 'Nikšić', country: 'Monténégro', lat: 42.78, lon: 19.03 },
    { name: 'Pristina', country: 'Kosovo', lat: 42.66, lon: 21.17 },
    { name: 'Vaduz', country: 'Liechtenstein', lat: 47.14, lon: 9.52 },
    { name: 'Andorra la Vella', country: 'Andorre', lat: 42.5, lon: 1.52 },
    { name: 'Monaco', country: 'Monaco', lat: 43.73, lon: 7.42 },
    { name: 'San Marino', country: 'Saint-Marin', lat: 43.94, lon: 12.45 },
    { name: 'La Valette', country: 'Malte', lat: 35.9, lon: 14.51 },
    { name: 'Tórshavn', country: 'Îles Féroé', lat: 62.01, lon: -6.77 },
    { name: 'Santa Cruz de Tenerife', country: 'Espagne', lat: 28.46, lon: -16.25 },
    { name: 'Las Palmas', country: 'Espagne', lat: 28.11, lon: -15.43 },
    { name: 'Horta', country: 'Portugal', lat: 38.53, lon: -28.63 },
    { name: 'Pico', country: 'Portugal', lat: 38.56, lon: -26.73 },
    { name: 'Longyearbyen', country: 'Norvège', lat: 78.22, lon: 15.65 },
    { name: 'Alexandrie', country: 'Égypte', lat: 31.2, lon: 29.92 },
    { name: 'Port Saïd', country: 'Égypte', lat: 31.26, lon: 32.3 },
    { name: 'Suez', country: 'Égypte', lat: 29.97, lon: 32.53 },
    { name: 'Marsa Matruh', country: 'Égypte', lat: 31.35, lon: 27.23 },
    { name: 'Aswan', country: 'Égypte', lat: 24.09, lon: 32.9 },
    { name: 'Luxor', country: 'Égypte', lat: 25.69, lon: 32.64 },
    { name: 'Assiout', country: 'Égypte', lat: 27.18, lon: 31.18 },
    { name: 'Minya', country: 'Égypte', lat: 28.1, lon: 30.75 },
    { name: 'Qena', country: 'Égypte', lat: 26.16, lon: 32.73 },
    { name: 'Ismailia', country: 'Égypte', lat: 30.6, lon: 32.27 },
    { name: 'Sfax', country: 'Tunisie', lat: 34.74, lon: 10.76 },
    { name: 'Sousse', country: 'Tunisie', lat: 35.83, lon: 10.64 },
    { name: 'Bizerte', country: 'Tunisie', lat: 37.27, lon: 9.87 },
    { name: 'Gabès', country: 'Tunisie', lat: 33.95, lon: 10.09 },
    { name: 'Médenine', country: 'Tunisie', lat: 34.1, lon: 10.86 },
    { name: 'Nabeul', country: 'Tunisie', lat: 36.31, lon: 10.74 },
    { name: 'Djerba', country: 'Tunisie', lat: 33.81, lon: 10.86 },
    { name: 'Oran', country: 'Algérie', lat: 35.7, lon: -0.65 },
    { name: 'Constantine', country: 'Algérie', lat: 36.36, lon: 6.61 },
    { name: 'Annaba', country: 'Algérie', lat: 36.9, lon: 7.77 },
    { name: 'Batna', country: 'Algérie', lat: 35.55, lon: 6.17 },
    { name: 'Tlemcen', country: 'Algérie', lat: 34.88, lon: -1.31 },
    { name: 'Tébessa', country: 'Algérie', lat: 35.4, lon: 8.12 },
    { name: 'Sétif', country: 'Algérie', lat: 36.19, lon: 5.41 },
    { name: 'Jijel', country: 'Algérie', lat: 36.82, lon: 5.76 },
    { name: 'Béjaïa', country: 'Algérie', lat: 36.75, lon: 5.25 },
    { name: 'Fès', country: 'Maroc', lat: 34.03, lon: -5 },
    { name: 'Rabat', country: 'Maroc', lat: 34.02, lon: -6.84 },
    { name: 'Oujda', country: 'Maroc', lat: 34.68, lon: -1.91 },
    { name: 'Tétouan', country: 'Maroc', lat: 35.57, lon: -5.37 },
    { name: 'El Jadida', country: 'Maroc', lat: 33.07, lon: -9.04 },
    { name: 'Kenitra', country: 'Maroc', lat: 34.26, lon: -6.58 },
    { name: 'Tanger', country: 'Maroc', lat: 35.76, lon: -5.83 },
    { name: 'Agadir', country: 'Maroc', lat: 30.42, lon: -9.6 },
    { name: 'Taza', country: 'Maroc', lat: 34.22, lon: -2.07 },
    { name: 'Béni Mellal', country: 'Maroc', lat: 32.34, lon: -6.04 },
    { name: 'Conakry', country: 'Guinée', lat: 9.64, lon: -13.58 },
    { name: 'Bissau', country: 'Guinée-Bissau', lat: 11.86, lon: -15.59 },
    { name: 'Thiès', country: 'Sénégal', lat: 14.79, lon: -16.93 },
    { name: 'Ziguinchor', country: 'Sénégal', lat: 12.57, lon: -16.27 },
    { name: 'Saint-Louis', country: 'Sénégal', lat: 16.02, lon: -16.48 },
    { name: 'Tamale', country: 'Ghana', lat: 9.4, lon: -0.85 },
    { name: 'Kumasi', country: 'Ghana', lat: 6.69, lon: -1.62 },
    { name: 'Takoradi', country: 'Ghana', lat: 4.9, lon: -1.76 },
    { name: 'Ho', country: 'Ghana', lat: 5.84, lon: 0.55 },
    { name: 'Keta', country: 'Ghana', lat: 5.86, lon: 1.09 },
    { name: 'Bolgatanga', country: 'Ghana', lat: 10.94, lon: -0.72 },
    { name: 'Tarkwa', country: 'Ghana', lat: 5.07, lon: -1.97 },
    { name: 'Cape Coast', country: 'Ghana', lat: 5.11, lon: -1.25 },
    { name: 'Lomé', country: 'Togo', lat: 6.13, lon: 1.22 },
    { name: 'Kpalimé', country: 'Togo', lat: 7.08, lon: 1.13 },
    { name: 'Atakpamé', country: 'Togo', lat: 7.17, lon: 0.89 },
    { name: 'Dapaong', country: 'Togo', lat: 10.27, lon: 0.32 },
    { name: 'Aného', country: 'Togo', lat: 6.17, lon: 1.17 },
    { name: 'Cotonou', country: 'Bénin', lat: 6.37, lon: 2.39 },
    { name: 'Porto-Novo', country: 'Bénin', lat: 6.5, lon: 2.61 },
    { name: 'Parakou', country: 'Bénin', lat: 9.07, lon: 2.4 },
    { name: 'Abomey', country: 'Bénin', lat: 7.17, lon: 1.83 },
    { name: 'Dassa-Zoumè', country: 'Bénin', lat: 8.05, lon: 2.16 },
    { name: 'Freetown', country: 'Sierra Leone', lat: 8.48, lon: -13.23 },
    { name: 'Makeni', country: 'Sierra Leone', lat: 7.79, lon: -11.77 },
    { name: 'Bo', country: 'Sierra Leone', lat: 7.44, lon: -11.71 },
    { name: 'Kenema', country: 'Sierra Leone', lat: 7.94, lon: -11.22 },
    { name: 'Monrovia', country: 'Libéria', lat: 6.34, lon: -10.8 },
    { name: 'Abuja', country: 'Nigéria', lat: 9.06, lon: 7.49 },
    { name: 'Port Harcourt', country: 'Nigéria', lat: 4.82, lon: 7.02 },
    { name: 'Ibadan', country: 'Nigéria', lat: 7.37, lon: 3.94 },
    { name: 'Jos', country: 'Nigéria', lat: 9.92, lon: 8.88 },
    { name: 'Aba', country: 'Nigéria', lat: 5.05, lon: 7.33 },
    { name: 'Enugu', country: 'Nigéria', lat: 6.49, lon: 7.51 },
    { name: 'Kaduna', country: 'Nigéria', lat: 10.52, lon: 7.44 },
    { name: 'Benin City', country: 'Nigéria', lat: 6.33, lon: 5.61 },
    { name: 'Calabar', country: 'Nigéria', lat: 4.95, lon: 8.32 },
    { name: 'Sokoto', country: 'Nigéria', lat: 13.06, lon: 5.21 },
    { name: 'Banjul', country: 'Gambie', lat: 13.45, lon: -16.58 },
    { name: 'Mamou', country: 'Guinée', lat: 10.53, lon: -12.95 },
    { name: 'Boké', country: 'Guinée', lat: 11.73, lon: -14.05 },
    { name: 'Kankan', country: 'Guinée', lat: 10.38, lon: -8.02 },
    { name: 'Labe', country: 'Guinée', lat: 7.92, lon: -10.88 },
    { name: 'Kissidougou', country: 'Guinée', lat: 8.02, lon: -11.35 },
    { name: 'Nouakchott', country: 'Mauritanie', lat: 18.09, lon: -15.98 },
    { name: 'Nouadhibou', country: 'Mauritanie', lat: 20.94, lon: -17.03 },
    { name: 'Tidjikja', country: 'Mauritanie', lat: 17.09, lon: -11.52 },
    { name: 'Malabo', country: 'Guinée équatoriale', lat: 3.75, lon: 8.78 },
    { name: 'Djibouti', country: 'Djibouti', lat: 11.59, lon: 43.15 },
    { name: 'Kigali', country: 'Rwanda', lat: -1.94, lon: 30.06 },
    { name: 'Bujumbura', country: 'Burundi', lat: -3.38, lon: 29.36 },
    { name: 'Lubumbashi', country: 'RD Congo', lat: -11.66, lon: 27.48 },
    { name: 'Kananga', country: 'RD Congo', lat: -5.06, lon: 22.43 },
    { name: 'Mbuji-Mayi', country: 'RD Congo', lat: -6.04, lon: 23.59 },
    { name: 'Goma', country: 'RD Congo', lat: -1.67, lon: 29.22 },
    { name: 'Bukavu', country: 'RD Congo', lat: -4.45, lon: 28.85 },
    { name: 'Kinshasa', country: 'RD Congo', lat: -4.44, lon: 15.27 },
    { name: 'Kisumu', country: 'Kenya', lat: -0.09, lon: 34.77 },
    { name: 'Eldoret', country: 'Kenya', lat: 0.51, lon: 35.27 },
    { name: 'Nakuru', country: 'Kenya', lat: -0.3, lon: 36.08 },
    { name: 'Lamu', country: 'Kenya', lat: -2.27, lon: 40.9 },
    { name: 'Arusha', country: 'Tanzanie', lat: -3.38, lon: 36.68 },
    { name: 'Morogoro', country: 'Tanzanie', lat: -10.02, lon: 37.66 },
    { name: 'Dodoma', country: 'Tanzanie', lat: -6.17, lon: 35.75 },
    { name: 'Tabora', country: 'Tanzanie', lat: -5.02, lon: 32.8 },
    { name: 'Mwanza', country: 'Tanzanie', lat: -2.52, lon: 32.9 },
    { name: 'Kampala', country: 'Ouganda', lat: 0.35, lon: 32.58 },
    { name: 'Mbarara', country: 'Ouganda', lat: -0.67, lon: 30.64 },
    { name: 'Gulu', country: 'Ouganda', lat: 2.78, lon: 32.29 },
    { name: 'Arua', country: 'Ouganda', lat: 3.03, lon: 30.91 },
    { name: 'Mbale', country: 'Ouganda', lat: 1.08, lon: 33.4 },
    { name: 'Juba', country: 'Soudan du Sud', lat: 4.85, lon: 31.58 },
    { name: 'Malakal', country: 'Soudan du Sud', lat: 9.53, lon: 31.66 },
    { name: 'Bentiu', country: 'Soudan du Sud', lat: 8.48, lon: 31.18 },
    { name: 'Asmara', country: 'Érythrée', lat: 15.34, lon: 38.93 },
    { name: 'Massawa', country: 'Érythrée', lat: 15.64, lon: 39.4 },
    { name: 'Mogadiscio', country: 'Somalie', lat: 2.05, lon: 45.31 },
    { name: 'Kismayo', country: 'Somalie', lat: -0.35, lon: 42.54 },
    { name: 'Hodeïda', country: 'Yémen', lat: 14.8, lon: 42.95 },
    { name: 'Aden', country: 'Yémen', lat: 12.78, lon: 45.04 },
    { name: 'Taiz', country: 'Yémen', lat: 15.48, lon: 44.19 },
    { name: 'Bloemfontein', country: 'Afrique du Sud', lat: -29.12, lon: 26.21 },
    { name: 'Pretoria', country: 'Afrique du Sud', lat: -25.75, lon: 28.19 },
    { name: 'Maseru', country: 'Lesotho', lat: -29.32, lon: 27.49 },
    { name: 'Mbabane', country: 'Eswatini', lat: -26.3, lon: 31.14 },
    { name: 'Windhoek', country: 'Namibie', lat: -22.56, lon: 17.08 },
    { name: 'Walvis Bay', country: 'Namibie', lat: -22.95, lon: 14.51 },
    { name: 'Oranjemund', country: 'Namibie', lat: -28.27, lon: 16.43 },
    { name: 'Oshakati', country: 'Namibie', lat: -17.93, lon: 14.51 },
    { name: 'Keetmanshoop', country: 'Namibie', lat: -28.59, lon: 18.13 },
    { name: 'Luderitz', country: 'Namibie', lat: -26.64, lon: 15.16 },
    { name: 'Tsumeb', country: 'Namibie', lat: -19.23, lon: 17.72 },
    { name: 'Otjiwarongo', country: 'Namibie', lat: -19.51, lon: 16.93 },
    { name: 'Gaborone', country: 'Botswana', lat: -24.62, lon: 25.92 },
    { name: 'Francistown', country: 'Botswana', lat: -21.17, lon: 27.5 },
    { name: 'Maun', country: 'Botswana', lat: -19.98, lon: 23.42 },
    { name: 'Selebi-Phikwe', country: 'Botswana', lat: -21.99, lon: 27.84 },
    { name: 'Lilongwe', country: 'Malawi', lat: -13.98, lon: 33.79 },
    { name: 'Blantyre', country: 'Malawi', lat: -15.79, lon: 35.02 },
    { name: 'Mzuzu', country: 'Malawi', lat: -11.4, lon: 34.02 },
    { name: 'Lusaka', country: 'Zambie', lat: -15.42, lon: 28.29 },
    { name: 'Luanshya', country: 'Zambie', lat: -14.58, lon: 28.51 },
    { name: 'Ndola', country: 'Zambie', lat: -12.97, lon: 31.48 },
    { name: 'Chipata', country: 'Zambie', lat: -13.65, lon: 31.55 },
    { name: 'Solwezi', country: 'Zambie', lat: -12.05, lon: 26.4 },
    { name: 'Mongu', country: 'Zambie', lat: -14.72, lon: 23.22 },
    { name: 'Bulawayo', country: 'Zimbabwe', lat: -20.16, lon: 28.58 },
    { name: 'Gweru', country: 'Zimbabwe', lat: -19.87, lon: 30.22 },
    { name: 'Mutare', country: 'Zimbabwe', lat: -17.8, lon: 32.66 },
    { name: 'Masvingo', country: 'Zimbabwe', lat: -20.25, lon: 30.91 },
    { name: 'Kwekwe', country: 'Zimbabwe', lat: -19.46, lon: 30.83 },
    { name: 'Mbombela', country: 'Afrique du Sud', lat: -25.49, lon: 31.03 },
    { name: 'Middelburg', country: 'Afrique du Sud', lat: -25.76, lon: 30.39 },
    { name: 'Kimberley', country: 'Afrique du Sud', lat: -28.74, lon: 24.75 },
    { name: 'Polokwane', country: 'Afrique du Sud', lat: -23.92, lon: 29.46 },
    { name: 'Mafikeng', country: 'Afrique du Sud', lat: -25.71, lon: 28.02 },
    { name: 'Mthatha', country: 'Afrique du Sud', lat: -31.44, lon: 27.74 },
    { name: 'Mossel Bay', country: 'Afrique du Sud', lat: -34.19, lon: 22.15 },
    { name: 'East London', country: 'Afrique du Sud', lat: -33.02, lon: 27.91 },
    { name: 'Gqeberha', country: 'Afrique du Sud', lat: -33.96, lon: 25.6 },
    { name: 'Graaff-Reinet', country: 'Afrique du Sud', lat: -32.27, lon: 24.66 },
    { name: 'Knysna', country: 'Afrique du Sud', lat: -34.64, lon: 23.03 },
    { name: 'Hermanus', country: 'Afrique du Sud', lat: -34.42, lon: 19.24 },
    { name: 'Nampula', country: 'Mozambique', lat: -15.12, lon: 38.92 },
    { name: 'Pemba', country: 'Mozambique', lat: -11.88, lon: 40.27 },
    { name: 'Beira', country: 'Mozambique', lat: -19.83, lon: 34.85 },
    { name: 'Luanda-Norte', country: 'Angola', lat: -8.84, lon: 13.23 },
    { name: 'Benguela', country: 'Angola', lat: -12.58, lon: 13.41 },
    { name: 'Cabinda', country: 'Angola', lat: -5.55, lon: 12.2 },
    { name: 'Mbandaka', country: 'RD Congo', lat: -0.05, lon: 18.25 },
    { name: 'Mbandaka-N', country: 'RD Congo', lat: -0.05, lon: 18.25 },
    { name: 'Kisangani', country: 'RD Congo', lat: 0.52, lon: 25.2 },
    { name: 'Bujumbura-N', country: 'Burundi', lat: -3.38, lon: 29.36 },
    { name: 'Dakar-N', country: 'Sénégal', lat: 14.75, lon: -17.48 },
    { name: 'Kolda', country: 'Sénégal', lat: 13.78, lon: -12.05 },
    { name: 'Touba', country: 'Sénégal', lat: 14.78, lon: -16.03 },
    { name: 'Lobito', country: 'Angola', lat: -12.36, lon: 13.54 },
    { name: 'Soyo', country: 'Angola', lat: -6.13, lon: 12.35 },
    { name: 'Mbanza-Kongo', country: 'Angola', lat: -7.61, lon: 13.4 },
    { name: 'Malanje', country: 'Angola', lat: -9.54, lon: 16.3 },
    { name: 'Huambo', country: 'Angola', lat: -12.78, lon: 15.74 },
    { name: 'Dili', country: 'Timor oriental', lat: -8.56, lon: 125.56 },
    { name: 'Kigali-N', country: 'Rwanda', lat: -1.94, lon: 30.06 },
    { name: 'Marrakech-N', country: 'Maroc', lat: 31.63, lon: -8.01 },
    { name: 'Dakar-N2', country: 'Sénégal', lat: 14.75, lon: -17.48 },
    { name: 'Bamako-N', country: 'Mali', lat: 12.65, lon: -8 },
    { name: 'Sikasso', country: 'Mali', lat: 11.32, lon: -6.17 },
    { name: 'Kayes', country: 'Mali', lat: 14.44, lon: -11.45 },
    { name: 'Mopti', country: 'Mali', lat: 14.5, lon: -4.18 },
    { name: 'Ségou', country: 'Mali', lat: 13.44, lon: -5.64 },
    { name: 'Koutiala', country: 'Mali', lat: 10.64, lon: -6.27 },
    { name: 'Bobo-Dioulasso', country: 'Burkina Faso', lat: 12.36, lon: -4.28 },
    { name: 'Koudougou', country: 'Burkina Faso', lat: 12.28, lon: -1.52 },
    { name: 'Ouargaye', country: 'Burkina Faso', lat: 10.38, lon: -3.9 },
    { name: 'Nouna', country: 'Burkina Faso', lat: 10.79, lon: -2.17 },
    { name: 'Abidjan-N', country: 'Côte d\'Ivoire', lat: 5.36, lon: -4.03 },
    { name: 'Bouaké', country: 'Côte d\'Ivoire', lat: 7.7, lon: -5.02 },
    { name: 'Man', country: 'Côte d\'Ivoire', lat: 7.41, lon: -7.55 },
    { name: 'Daloa', country: 'Côte d\'Ivoire', lat: 7.56, lon: -5.09 },
    { name: 'Accra-N', country: 'Ghana', lat: 5.6, lon: -0.19 },
    { name: 'Douala', country: 'Cameroun', lat: 4.05, lon: 9.7 },
    { name: 'Yaoundé-N', country: 'Cameroun', lat: 3.87, lon: 11.52 },
    { name: 'Garoua', country: 'Cameroun', lat: 7.34, lon: 13.48 },
    { name: 'Bafoussam', country: 'Cameroun', lat: 5.46, lon: 10.18 },
    { name: 'Ndjamena', country: 'Tchad', lat: 12.11, lon: 15.05 },
    { name: 'Moundou', country: 'Tchad', lat: 8.52, lon: 18.11 },
    { name: 'Abéché', country: 'Tchad', lat: 13.82, lon: 20.83 },
    { name: 'N\'Djamena', country: 'Tchad', lat: 12.11, lon: 15.05 },
    { name: 'Malakal-N', country: 'Soudan du Sud', lat: 9.53, lon: 31.66 },
    { name: 'Khartoum-N', country: 'Soudan', lat: 15.5, lon: 32.56 },
    { name: 'Atbara', country: 'Soudan', lat: 17.69, lon: 33.9 },
    { name: 'Port-Soudan', country: 'Soudan', lat: 19.62, lon: 37.22 },
    { name: 'Wadi-Saleh', country: 'Soudan', lat: 12.56, lon: 25.2 },
    { name: 'El-Obeid', country: 'Soudan', lat: 13.8, lon: 29.35 },
    { name: 'Kassala', country: 'Soudan', lat: 15.45, lon: 36.34 },
    { name: 'Sennar', country: 'Soudan', lat: 13.47, lon: 33.62 },
    { name: 'Gaza', country: 'Palestine', lat: 31.5, lon: 34.47 },
    { name: 'Nablous', country: 'Palestine', lat: 32.22, lon: 35.26 },
    { name: 'Gaza-N', country: 'Palestine', lat: 31.5, lon: 34.47 },
    { name: 'Al Ain', country: 'Émirats arabes unis', lat: 24.21, lon: 55.74 },
    { name: 'Ras Al Khaimah', country: 'Émirats arabes unis', lat: 25.79, lon: 55.93 },
    { name: 'Fujairah', country: 'Émirats arabes unis', lat: 25.12, lon: 56.32 },
    { name: 'Sharjah', country: 'Émirats arabes unis', lat: 25.35, lon: 55.41 },
    { name: 'Al Khor', country: 'Qatar', lat: 24.5, lon: 51.47 },
    { name: 'Al Wakrah', country: 'Qatar', lat: 24.77, lon: 50.09 },
    { name: 'Al Rayyan', country: 'Qatar', lat: 25.24, lon: 51.33 },
    { name: 'Salalah', country: 'Oman', lat: 17.02, lon: 54.09 },
    { name: 'Sur', country: 'Oman', lat: 22.57, lon: 59.53 },
    { name: 'Nizwa', country: 'Oman', lat: 22.93, lon: 57.53 },
    { name: 'Sohar', country: 'Oman', lat: 24.35, lon: 56.75 },
    { name: 'Duqm', country: 'Oman', lat: 19.65, lon: 57.72 },
    { name: 'Chiraz', country: 'Iran', lat: 29.59, lon: 52.58 },
    { name: 'Tabriz', country: 'Iran', lat: 38.08, lon: 46.29 },
    { name: 'Kerman', country: 'Iran', lat: 30.29, lon: 57.08 },
    { name: 'Zahedan', country: 'Iran', lat: 29.47, lon: 60.88 },
    { name: 'Sari', country: 'Iran', lat: 36.54, lon: 53.05 },
    { name: 'Gorgan', country: 'Iran', lat: 36.9, lon: 54.37 },
    { name: 'Yazd', country: 'Iran', lat: 31.89, lon: 54.36 },
    { name: 'Borujerd', country: 'Iran', lat: 32.79, lon: 51.55 },
    { name: 'Khorramabad', country: 'Iran', lat: 33.49, lon: 48.36 },
    { name: 'Sanandaj', country: 'Iran', lat: 35.3, lon: 47.02 },
    { name: 'Semnan', country: 'Iran', lat: 35.56, lon: 53.42 },
    { name: 'Qazvin', country: 'Iran', lat: 36.27, lon: 50 },
    { name: 'Ardabil', country: 'Iran', lat: 38.27, lon: 48.42 },
    { name: 'Rasht', country: 'Iran', lat: 37.3, lon: 49.57 },
    { name: 'Babolsar', country: 'Iran', lat: 36.42, lon: 50.28 },
    { name: 'Anzali', country: 'Iran', lat: 37.5, lon: 49.4 },
    { name: 'Khorramshahr', country: 'Iran', lat: 30.5, lon: 48.18 },
    { name: 'Abadan', country: 'Iran', lat: 30.37, lon: 48.22 },
    { name: 'Bandar Abbas', country: 'Iran', lat: 27.18, lon: 56.27 },
    { name: 'Sirjan', country: 'Iran', lat: 29.59, lon: 56.46 },
    { name: 'Bam', country: 'Iran', lat: 29.11, lon: 58.4 },
    { name: 'Mehriz', country: 'Iran', lat: 28.28, lon: 54.91 },
    { name: 'Fasa', country: 'Iran', lat: 28.83, lon: 54.18 },
    { name: 'Kazeroon', country: 'Iran', lat: 32.35, lon: 51.53 },
    { name: 'Najafabad', country: 'Iran', lat: 33.65, lon: 51.58 },
    { name: 'Saveh', country: 'Iran', lat: 33.52, lon: 50.97 },
    { name: 'Arak', country: 'Iran', lat: 34.09, lon: 49.67 },
    { name: 'Malayer', country: 'Iran', lat: 34.9, lon: 48.8 },
    { name: 'Bijar', country: 'Iran', lat: 35.62, lon: 47.15 },
    { name: 'Maku', country: 'Iran', lat: 36.8, lon: 44.84 },
    { name: 'Urmia', country: 'Iran', lat: 37.55, lon: 45.07 },
    { name: 'Ahar', country: 'Iran', lat: 38.4, lon: 45.91 },
    { name: 'Sarab', country: 'Iran', lat: 38.13, lon: 45.69 },
    { name: 'Maragheh', country: 'Iran', lat: 37.39, lon: 46.23 },
    { name: 'Miyaneh', country: 'Iran', lat: 35.62, lon: 46.37 },
    { name: 'Tonekabon', country: 'Iran', lat: 36.8, lon: 51.32 },
    { name: 'Chalus', country: 'Iran', lat: 36.48, lon: 51.54 },
    { name: 'Kojur', country: 'Iran', lat: 36.7, lon: 52.82 },
    { name: 'Amol', country: 'Iran', lat: 36.65, lon: 53.12 },
    { name: 'Shabestar', country: 'Iran', lat: 36.59, lon: 56.29 },
    { name: 'Mardin', country: 'Turquie', lat: 37.31, lon: 41.98 },
    { name: 'Şanlıurfa', country: 'Turquie', lat: 37.16, lon: 38.79 },
    { name: 'Erzurum', country: 'Turquie', lat: 39.9, lon: 41.27 },
    { name: 'Erzincan', country: 'Turquie', lat: 39.75, lon: 39.49 },
    { name: 'Malatya', country: 'Turquie', lat: 38.35, lon: 38.31 },
    { name: 'Sivas', country: 'Turquie', lat: 39.75, lon: 37.02 },
    { name: 'Kahramanmaras', country: 'Turquie', lat: 37.58, lon: 36.93 },
    { name: 'Elazig', country: 'Turquie', lat: 38.68, lon: 39.22 },
    { name: 'Siirt', country: 'Turquie', lat: 37.93, lon: 42 },
    { name: 'Batman', country: 'Turquie', lat: 37.83, lon: 41.17 },
    { name: 'Van', country: 'Turquie', lat: 38.49, lon: 43.4 },
    { name: 'Bitlis', country: 'Turquie', lat: 38.4, lon: 43.05 },
    { name: 'Hakkari', country: 'Turquie', lat: 37.55, lon: 43.75 },
    { name: 'Mus', country: 'Turquie', lat: 39.55, lon: 41.7 },
    { name: 'Haïfa', country: 'Israël', lat: 32.79, lon: 35.02 },
    { name: 'Beersheva', country: 'Israël', lat: 31.25, lon: 34.79 },
    { name: 'Ashdod', country: 'Israël', lat: 31.8, lon: 34.65 },
    { name: 'Nazareth', country: 'Israël', lat: 32.7, lon: 35.3 },
    { name: 'Sdérot', country: 'Israël', lat: 31.57, lon: 34.57 },
    { name: 'Irbid', country: 'Jordan', lat: 32.55, lon: 36.02 },
    { name: 'Al-Salt', country: 'Jordan', lat: 32.12, lon: 35.8 },
    { name: 'Zarqa', country: 'Jordan', lat: 32.07, lon: 35.97 },
    { name: 'Tafileh', country: 'Jordan', lat: 32.12, lon: 35.72 },
    { name: 'Ma\'an', country: 'Jordan', lat: 30.35, lon: 35.43 },
    { name: 'Basra', country: 'Irak', lat: 30.51, lon: 47.81 },
    { name: 'Mosoul', country: 'Irak', lat: 36.34, lon: 43.13 },
    { name: 'Kirkouk', country: 'Irak', lat: 35.46, lon: 44.39 },
    { name: 'Hilla', country: 'Irak', lat: 32.47, lon: 44.41 },
    { name: 'Karbala', country: 'Irak', lat: 32.62, lon: 44.02 },
    { name: 'Najaf', country: 'Irak', lat: 31.98, lon: 44.23 },
    { name: 'Ramadi', country: 'Irak', lat: 33.42, lon: 43.3 },
    { name: 'Al-Kut', country: 'Irak', lat: 32.47, lon: 45.87 },
    { name: 'Dohuk', country: 'Irak', lat: 36.86, lon: 43 },
    { name: 'Tripoli', country: 'Liban', lat: 34.44, lon: 35.84 },
    { name: 'Saida', country: 'Liban', lat: 33.56, lon: 35.37 },
    { name: 'Tyre', country: 'Liban', lat: 33.27, lon: 35.2 },
    { name: 'Baalbek', country: 'Liban', lat: 34.01, lon: 36.2 },
    { name: 'Hasbaya', country: 'Liban', lat: 33.43, lon: 35.69 },
    { name: 'Byblos', country: 'Liban', lat: 34.12, lon: 35.65 },
    { name: 'Aley', country: 'Liban', lat: 33.87, lon: 35.55 },
    { name: 'Alep', country: 'Syrie', lat: 36.2, lon: 37.14 },
    { name: 'Homs', country: 'Syrie', lat: 34.73, lon: 36.72 },
    { name: 'Hama', country: 'Syrie', lat: 35.13, lon: 36.75 },
    { name: 'Lattakieh', country: 'Syrie', lat: 35.52, lon: 35.79 },
    { name: 'Daraa', country: 'Syrie', lat: 32.63, lon: 36.09 },
    { name: 'Deir ez-Zor', country: 'Syrie', lat: 35.33, lon: 40.1 },
    { name: 'Raqqa', country: 'Syrie', lat: 35.95, lon: 39.01 },
    { name: 'Idlib', country: 'Syrie', lat: 35.93, lon: 36.63 },
    { name: 'Qamishli', country: 'Syrie', lat: 36.25, lon: 40.75 },
    { name: 'Jisr al-Shughour', country: 'Syrie', lat: 34.78, lon: 36.43 },
    { name: 'Salamiyah', country: 'Syrie', lat: 35.33, lon: 37.22 },
    { name: 'Tartous', country: 'Syrie', lat: 34.88, lon: 35.88 },
    { name: 'Jableh', country: 'Syrie', lat: 33.92, lon: 35.93 },
    { name: 'Arqa', country: 'Syrie', lat: 34.96, lon: 36.71 },
    { name: 'Masyaf', country: 'Syrie', lat: 34.95, lon: 36.55 },
    { name: 'Abha', country: 'Arabie saoudite', lat: 18.22, lon: 42.51 },
    { name: 'Al-Ula', country: 'Arabie saoudite', lat: 26.6, lon: 38.15 },
    { name: 'Hail', country: 'Arabie saoudite', lat: 27.51, lon: 41.67 },
    { name: 'Al-Kharj', country: 'Arabie saoudite', lat: 24.18, lon: 47.42 },
    { name: 'Qatif', country: 'Arabie saoudite', lat: 27.08, lon: 50.12 },
    { name: 'Al-Baha', country: 'Arabie saoudite', lat: 20, lon: 41.53 },
    { name: 'Najran', country: 'Arabie saoudite', lat: 17.49, lon: 44.13 },
    { name: 'Al-Jawf', country: 'Arabie saoudite', lat: 29.81, lon: 38.97 },
    { name: 'Al-Ahsa', country: 'Arabie saoudite', lat: 25.36, lon: 49.63 },
    { name: 'Taif', country: 'Arabie saoudite', lat: 21.27, lon: 40.42 },
    { name: 'Al-Majmaah', country: 'Arabie saoudite', lat: 25.35, lon: 40.97 },
    { name: 'Muharraq', country: 'Bahreïn', lat: 26.25, lon: 50.61 },
    { name: 'Riffa', country: 'Bahreïn', lat: 26, lon: 50.39 },
    { name: 'Al Ahmadi', country: 'Koweït', lat: 29.17, lon: 48.09 },
    { name: 'Al Farwaniyah', country: 'Koweït', lat: 29.24, lon: 47.96 },
    { name: 'Bishkek', country: 'Kirghizistan', lat: 42.87, lon: 74.59 },
    { name: 'Osh', country: 'Kirghizistan', lat: 40.51, lon: 72.8 },
    { name: 'Douchanbé', country: 'Tadjikistan', lat: 38.56, lon: 68.78 },
    { name: 'Khudzhand', country: 'Tadjikistan', lat: 40.28, lon: 67.63 },
    { name: 'Kourgan-Tioube', country: 'Tadjikistan', lat: 40.69, lon: 69.19 },
    { name: 'Achgabat', country: 'Turkménistan', lat: 37.95, lon: 58.38 },
    { name: 'Mary', country: 'Turkménistan', lat: 37.5, lon: 61.83 },
    { name: 'Boukhara', country: 'Ouzbékistan', lat: 39.77, lon: 64.42 },
    { name: 'Namangan', country: 'Ouzbékistan', lat: 41, lon: 67.29 },
    { name: 'Fergana', country: 'Ouzbékistan', lat: 40.38, lon: 71.78 },
    { name: 'Samarkand', country: 'Ouzbékistan', lat: 39.65, lon: 66.96 },
    { name: 'Noukous', country: 'Ouzbékistan', lat: 42.46, lon: 59.61 },
    { name: 'Andijon', country: 'Ouzbékistan', lat: 40.78, lon: 72.34 },
    { name: 'Jizzakh', country: 'Ouzbékistan', lat: 40.13, lon: 65.42 },
    { name: 'Navoi', country: 'Ouzbékistan', lat: 40.07, lon: 65.37 },
    { name: 'Hérat', country: 'Afghanistan', lat: 34.36, lon: 62.2 },
    { name: 'Mazar-i-Chérif', country: 'Afghanistan', lat: 36.71, lon: 67.11 },
    { name: 'Kandahar', country: 'Afghanistan', lat: 31.63, lon: 65.71 },
    { name: 'Jalalabad', country: 'Afghanistan', lat: 34.43, lon: 70.48 },
    { name: 'Faisalabad', country: 'Pakistan', lat: 31.46, lon: 73.08 },
    { name: 'Rawalpindi', country: 'Pakistan', lat: 33.57, lon: 73.07 },
    { name: 'Sialkot', country: 'Pakistan', lat: 32.49, lon: 74.52 },
    { name: 'Multan', country: 'Pakistan', lat: 30.15, lon: 71.53 },
    { name: 'Quetta', country: 'Pakistan', lat: 30.17, lon: 66.98 },
    { name: 'Gwadar', country: 'Pakistan', lat: 25.12, lon: 62.33 },
    { name: 'Peshawar', country: 'Pakistan', lat: 34.01, lon: 71.58 },
    { name: 'Sukkur', country: 'Pakistan', lat: 27.7, lon: 68.86 },
    { name: 'Sargodha', country: 'Pakistan', lat: 32.01, lon: 72.67 },
    { name: 'Surat', country: 'Inde', lat: 21.17, lon: 72.83 },
    { name: 'Coimbatore', country: 'Inde', lat: 11, lon: 76.96 },
    { name: 'Lucknow', country: 'Inde', lat: 26.85, lon: 80.95 },
    { name: 'Indore', country: 'Inde', lat: 22.72, lon: 75.86 },
    { name: 'Bhopal', country: 'Inde', lat: 23.26, lon: 77.41 },
    { name: 'Nagpur', country: 'Inde', lat: 21.15, lon: 79.09 },
    { name: 'Guwahati', country: 'Inde', lat: 26.14, lon: 91.74 },
    { name: 'Patna', country: 'Inde', lat: 25.59, lon: 85.14 },
    { name: 'Jaipur', country: 'Inde', lat: 26.91, lon: 75.79 },
    { name: 'Varanasi', country: 'Inde', lat: 25.32, lon: 82.99 },
    { name: 'Chandigarh', country: 'Inde', lat: 30.73, lon: 76.77 },
    { name: 'Visakhapatnam', country: 'Inde', lat: 17.69, lon: 83.22 },
    { name: 'Vijayawada', country: 'Inde', lat: 16.51, lon: 80.64 },
    { name: 'Tiruchirappalli', country: 'Inde', lat: 10.78, lon: 78.71 },
    { name: 'Madurai', country: 'Inde', lat: 9.92, lon: 78.12 },
    { name: 'Thiruvananthapuram', country: 'Inde', lat: 8.52, lon: 76.94 },
    { name: 'Kozhikode', country: 'Inde', lat: 11.26, lon: 75.78 },
    { name: 'Cochin', country: 'Inde', lat: 9.93, lon: 76.27 },
    { name: 'Mysore', country: 'Inde', lat: 12.3, lon: 76.65 },
    { name: 'Hubballi', country: 'Inde', lat: 15.38, lon: 75.11 },
    { name: 'Ranchi', country: 'Inde', lat: 23.34, lon: 85.31 },
    { name: 'Bilaspur', country: 'Inde', lat: 22.08, lon: 82.15 },
    { name: 'Jabalpur', country: 'Inde', lat: 23.17, lon: 79.97 },
    { name: 'Gwalior', country: 'Inde', lat: 26.22, lon: 78.18 },
    { name: 'Raipur', country: 'Inde', lat: 21.25, lon: 81.63 },
    { name: 'Bhubaneswar', country: 'Inde', lat: 20.3, lon: 85.82 },
    { name: 'Dhanbad', country: 'Inde', lat: 23.79, lon: 86.44 },
    { name: 'Amritsar', country: 'Inde', lat: 31.63, lon: 74.87 },
    { name: 'Dehradun', country: 'Inde', lat: 30.32, lon: 78.03 },
    { name: 'Jammu', country: 'Inde', lat: 32.73, lon: 74.86 },
    { name: 'Imphal', country: 'Inde', lat: 24.8, lon: 93.94 },
    { name: 'Agartala', country: 'Inde', lat: 24.81, lon: 91.49 },
    { name: 'Chittagong', country: 'Bangladesh', lat: 22.36, lon: 91.78 },
    { name: 'Rajshahi', country: 'Bangladesh', lat: 24.37, lon: 88.6 },
    { name: 'Khulna', country: 'Bangladesh', lat: 22.85, lon: 89.55 },
    { name: 'Sylhet', country: 'Bangladesh', lat: 24.89, lon: 91.87 },
    { name: 'Rangpur', country: 'Bangladesh', lat: 25.75, lon: 89.25 },
    { name: 'Barisal', country: 'Bangladesh', lat: 22.7, lon: 90.35 },
    { name: 'Mymensingh', country: 'Bangladesh', lat: 24.75, lon: 90.4 },
    { name: 'Comilla', country: 'Bangladesh', lat: 23.46, lon: 91.18 },
    { name: 'Jashore', country: 'Bangladesh', lat: 23.17, lon: 89.21 },
    { name: 'Bogura', country: 'Bangladesh', lat: 24.85, lon: 89.37 },
    { name: 'Tangail', country: 'Bangladesh', lat: 24.25, lon: 89.93 },
    { name: 'Kandy', country: 'Sri Lanka', lat: 7.29, lon: 80.63 },
    { name: 'Galle', country: 'Sri Lanka', lat: 6.03, lon: 80.22 },
    { name: 'Jaffna', country: 'Sri Lanka', lat: 9.66, lon: 80.05 },
    { name: 'Batticaloa', country: 'Sri Lanka', lat: 8.05, lon: 81.4 },
    { name: 'Negombo', country: 'Sri Lanka', lat: 7.2, lon: 79.83 },
    { name: 'Trincomalee', country: 'Sri Lanka', lat: 8.57, lon: 81.23 },
    { name: 'Hambantota', country: 'Sri Lanka', lat: 6.12, lon: 81.52 },
    { name: 'Pokhara', country: 'Népal', lat: 28.2, lon: 83.99 },
    { name: 'Lalitpur', country: 'Népal', lat: 27.67, lon: 85.32 },
    { name: 'Biratnagar', country: 'Népal', lat: 26.46, lon: 87.27 },
    { name: 'Bharatpur', country: 'Népal', lat: 27.51, lon: 84.92 },
    { name: 'Thimphou', country: 'Bhoutan', lat: 27.47, lon: 89.38 },
    { name: 'Paro', country: 'Bhoutan', lat: 27.47, lon: 89.39 },
    { name: 'Punakha', country: 'Bhoutan', lat: 27.47, lon: 89.62 },
    { name: 'Mandalay', country: 'Myanmar', lat: 21.97, lon: 96.08 },
    { name: 'Lashio', country: 'Myanmar', lat: 23.9, lon: 96.44 },
    { name: 'Meiktila', country: 'Myanmar', lat: 20.9, lon: 95.05 },
    { name: 'Phuket', country: 'Thaïlande', lat: 7.88, lon: 98.39 },
    { name: 'Khon Kaen', country: 'Thaïlande', lat: 16.43, lon: 102.83 },
    { name: 'Udon Thani', country: 'Thaïlande', lat: 17.41, lon: 102.78 },
    { name: 'Nakhon Ratchasima', country: 'Thaïlande', lat: 14.98, lon: 102.1 },
    { name: 'Chiang Rai', country: 'Thaïlande', lat: 19.91, lon: 99.83 },
    { name: 'Phitsanulok', country: 'Thaïlande', lat: 16.82, lon: 100.26 },
    { name: 'Vientiane', country: 'Laos', lat: 17.97, lon: 102.63 },
    { name: 'Luang Prabang', country: 'Laos', lat: 19.88, lon: 102.13 },
    { name: 'Pakse', country: 'Laos', lat: 15.12, lon: 105.79 },
    { name: 'Siem Reap', country: 'Cambodge', lat: 13.36, lon: 103.86 },
    { name: 'Battambang', country: 'Cambodge', lat: 13.1, lon: 103.2 },
    { name: 'Hai Phong', country: 'Viêt Nam', lat: 20.86, lon: 106.68 },
    { name: 'Da Lat', country: 'Viêt Nam', lat: 11.94, lon: 108.44 },
    { name: 'Can Tho', country: 'Viêt Nam', lat: 10.03, lon: 105.78 },
    { name: 'Nha Trang', country: 'Viêt Nam', lat: 12.25, lon: 109.18 },
    { name: 'Hue', country: 'Viêt Nam', lat: 16.46, lon: 107.6 },
    { name: 'Vung Tau', country: 'Viêt Nam', lat: 10.35, lon: 107.08 },
    { name: 'Davao', country: 'Philippines', lat: 7.07, lon: 125.6 },
    { name: 'Zamboanga', country: 'Philippines', lat: 6.91, lon: 122.08 },
    { name: 'Iloilo', country: 'Philippines', lat: 10.71, lon: 122.55 },
    { name: 'Baguio', country: 'Philippines', lat: 16.41, lon: 120.59 },
    { name: 'Tacloban', country: 'Philippines', lat: 11.24, lon: 125 },
    { name: 'Cotabato', country: 'Philippines', lat: 7.18, lon: 124.22 },
    { name: 'Ipoh', country: 'Malaisie', lat: 4.59, lon: 101.08 },
    { name: 'Kota Bharu', country: 'Malaisie', lat: 6.13, lon: 102.23 },
    { name: 'Kuching', country: 'Malaisie', lat: 1.55, lon: 110.35 },
    { name: 'Woodlands', country: 'Singapour', lat: 1.44, lon: 103.8 },
    { name: 'Jurong', country: 'Singapour', lat: 1.31, lon: 103.68 },
    { name: 'Palembang', country: 'Indonésie', lat: -2.99, lon: 104.76 },
    { name: 'Makassar', country: 'Indonésie', lat: -5.14, lon: 119.42 },
    { name: 'Padang', country: 'Indonésie', lat: -0.95, lon: 100.35 },
    { name: 'Semarang', country: 'Indonésie', lat: -6.97, lon: 110.42 },
    { name: 'Jember', country: 'Indonésie', lat: -8.44, lon: 112.17 },
    { name: 'Mamuju', country: 'Indonésie', lat: -2.67, lon: 118.89 },
    { name: 'Balikpapan', country: 'Indonésie', lat: -1.24, lon: 116.85 },
    { name: 'Pontianak', country: 'Indonésie', lat: -0.02, lon: 109.33 },
    { name: 'Banjarmasin', country: 'Indonésie', lat: -3.32, lon: 114.59 },
    { name: 'Nanjing', country: 'Chine', lat: 32.06, lon: 118.8 },
    { name: 'Tianjin', country: 'Chine', lat: 39.13, lon: 117.2 },
    { name: 'Xi\'an', country: 'Chine', lat: 34.34, lon: 108.94 },
    { name: 'Hangzhou', country: 'Chine', lat: 30.27, lon: 120.15 },
    { name: 'Changsha', country: 'Chine', lat: 28.23, lon: 112.94 },
    { name: 'Zhengzhou', country: 'Chine', lat: 34.75, lon: 113.62 },
    { name: 'Shenyang', country: 'Chine', lat: 41.8, lon: 123.43 },
    { name: 'Dalian', country: 'Chine', lat: 38.91, lon: 121.61 },
    { name: 'Qingdao', country: 'Chine', lat: 36.07, lon: 120.38 },
    { name: 'Jinan', country: 'Chine', lat: 36.65, lon: 117.12 },
    { name: 'Fuzhou', country: 'Chine', lat: 26.08, lon: 119.29 },
    { name: 'Nanchang', country: 'Chine', lat: 28.68, lon: 115.86 },
    { name: 'Kunming', country: 'Chine', lat: 25.04, lon: 102.71 },
    { name: 'Guiyang', country: 'Chine', lat: 26.65, lon: 106.63 },
    { name: 'Haikou', country: 'Chine', lat: 20.04, lon: 110.34 },
    { name: 'Lanzhou', country: 'Chine', lat: 36.06, lon: 103.83 },
    { name: 'Xiamen', country: 'Chine', lat: 24.48, lon: 118.09 },
    { name: 'Hefei', country: 'Chine', lat: 31.82, lon: 117.23 },
    { name: 'Nankin', country: 'Chine', lat: 32.06, lon: 118.8 },
    { name: 'Tangshan', country: 'Chine', lat: 39.63, lon: 118.18 },
    { name: 'Yantai', country: 'Chine', lat: 37.46, lon: 121.45 },
    { name: 'Fukuoka', country: 'Japon', lat: 33.59, lon: 130.4 },
    { name: 'Kobe', country: 'Japon', lat: 34.69, lon: 135.18 },
    { name: 'Nagasaki', country: 'Japon', lat: 32.75, lon: 129.87 },
    { name: 'Sendai', country: 'Japon', lat: 38.27, lon: 140.87 },
    { name: 'Kyoto', country: 'Japon', lat: 35.01, lon: 135.77 },
    { name: 'Hiroshima', country: 'Japon', lat: 34.4, lon: 132.46 },
    { name: 'Niigata', country: 'Japon', lat: 37.92, lon: 139.02 },
    { name: 'Shizuoka', country: 'Japon', lat: 34.98, lon: 138.38 },
    { name: 'Matsuyama', country: 'Japon', lat: 33.84, lon: 132.76 },
    { name: 'Naha', country: 'Japon', lat: 26.21, lon: 127.68 },
    { name: 'Takamatsu', country: 'Japon', lat: 34.34, lon: 134.05 },
    { name: 'Daegu', country: 'Corée du Sud', lat: 35.87, lon: 128.6 },
    { name: 'Incheon', country: 'Corée du Sud', lat: 37.46, lon: 126.71 },
    { name: 'Ulsan', country: 'Corée du Sud', lat: 35.54, lon: 129.34 },
    { name: 'Shymkent', country: 'Kazakhstan', lat: 42.31, lon: 69.6 },
    { name: 'Karaganda', country: 'Kazakhstan', lat: 49.8, lon: 73.09 },
    { name: 'Atyrau', country: 'Kazakhstan', lat: 47.11, lon: 51.89 },
    { name: 'Darkhan', country: 'Mongolie', lat: 46.48, lon: 104.47 },
    { name: 'Erdenet', country: 'Mongolie', lat: 48.94, lon: 102.94 },
    { name: 'Austin', country: 'États-Unis', lat: 30.27, lon: -97.74 },
    { name: 'San Diego', country: 'États-Unis', lat: 32.72, lon: -117.16 },
    { name: 'Jacksonville', country: 'États-Unis', lat: 30.33, lon: -81.66 },
    { name: 'Indianapolis', country: 'États-Unis', lat: 39.77, lon: -86.16 },
    { name: 'Columbus', country: 'États-Unis', lat: 39.96, lon: -83 },
    { name: 'Charlotte', country: 'États-Unis', lat: 35.23, lon: -80.84 },
    { name: 'San Jose', country: 'États-Unis', lat: 37.34, lon: -121.89 },
    { name: 'Fort Worth', country: 'États-Unis', lat: 32.76, lon: -97.33 },
    { name: 'Las Vegas', country: 'États-Unis', lat: 36.17, lon: -115.14 },
    { name: 'Cincinnati', country: 'États-Unis', lat: 39.1, lon: -84.51 },
    { name: 'Portland', country: 'États-Unis', lat: 45.52, lon: -122.68 },
    { name: 'Oklahoma City', country: 'États-Unis', lat: 35.47, lon: -97.52 },
    { name: 'Tampa', country: 'États-Unis', lat: 27.95, lon: -82.46 },
    { name: 'Memphis', country: 'États-Unis', lat: 35.15, lon: -90.05 },
    { name: 'Louisville', country: 'États-Unis', lat: 38.25, lon: -85.76 },
    { name: 'Milwaukee', country: 'États-Unis', lat: 43.04, lon: -87.91 },
    { name: 'Omaha', country: 'États-Unis', lat: 41.26, lon: -95.94 },
    { name: 'Colorado Springs', country: 'États-Unis', lat: 38.83, lon: -104.82 },
    { name: 'Albuquerque', country: 'États-Unis', lat: 35.08, lon: -106.65 },
    { name: 'Tucson', country: 'États-Unis', lat: 32.22, lon: -110.97 },
    { name: 'Fresno', country: 'États-Unis', lat: 36.74, lon: -119.79 },
    { name: 'Sacramento', country: 'États-Unis', lat: 38.58, lon: -121.49 },
    { name: 'Raleigh', country: 'États-Unis', lat: 35.78, lon: -78.64 },
    { name: 'New Orleans', country: 'États-Unis', lat: 29.95, lon: -90.07 },
    { name: 'Baltimore', country: 'États-Unis', lat: 39.29, lon: -76.61 },
    { name: 'St. Louis', country: 'États-Unis', lat: 38.63, lon: -90.2 },
    { name: 'Kansas City', country: 'États-Unis', lat: 39.1, lon: -94.58 },
    { name: 'Cleveland', country: 'États-Unis', lat: 41.5, lon: -81.69 },
    { name: 'Minneapolis', country: 'États-Unis', lat: 44.98, lon: -93.27 },
    { name: 'Tulsa', country: 'États-Unis', lat: 36.15, lon: -95.99 },
    { name: 'Honolulu', country: 'États-Unis', lat: 21.31, lon: -157.86 },
    { name: 'Winnipeg', country: 'Canada', lat: 49.9, lon: -97.14 },
    { name: 'Halifax', country: 'Canada', lat: 44.65, lon: -63.57 },
    { name: 'Ottawa', country: 'Canada', lat: 45.42, lon: -75.7 },
    { name: 'Hamilton', country: 'Canada', lat: 43.26, lon: -79.87 },
    { name: 'St. John\'s', country: 'Canada', lat: 47.56, lon: -52.71 },
    { name: 'Regina', country: 'Canada', lat: 50.45, lon: -104.62 },
    { name: 'Saskatoon', country: 'Canada', lat: 52.13, lon: -106.67 },
    { name: 'Victoria', country: 'Canada', lat: 48.43, lon: -123.37 },
    { name: 'Charlottetown', country: 'Canada', lat: 46.24, lon: -63.13 },
    { name: 'Tijuana', country: 'Mexique', lat: 32.51, lon: -117.04 },
    { name: 'Puebla', country: 'Mexique', lat: 19.06, lon: -98.2 },
    { name: 'Mérida', country: 'Mexique', lat: 20.97, lon: -89.62 },
    { name: 'Toluca', country: 'Mexique', lat: 19.29, lon: -99.65 },
    { name: 'Veracruz', country: 'Mexique', lat: 19.19, lon: -96.14 },
    { name: 'Querétaro', country: 'Mexique', lat: 20.59, lon: -100.39 },
    { name: 'Valparaíso', country: 'Chili', lat: -33.05, lon: -71.62 },
    { name: 'Concepción', country: 'Chili', lat: -36.82, lon: -73.05 },
    { name: 'Antofagasta', country: 'Chili', lat: -23.65, lon: -70.4 },
    { name: 'Arica', country: 'Chili', lat: -18.46, lon: -70.31 },
    { name: 'La Serena', country: 'Chili', lat: -29.88, lon: -71.23 },
    { name: 'Temuco', country: 'Chili', lat: -38.73, lon: -72.59 },
    { name: 'Mendoza', country: 'Argentine', lat: -32.89, lon: -68.83 },
    { name: 'Tucumán', country: 'Argentine', lat: -26.62, lon: -65.25 },
    { name: 'San Juan', country: 'Argentine', lat: -31.54, lon: -68.53 },
    { name: 'Salta', country: 'Argentine', lat: -24.79, lon: -65.41 },
    { name: 'Bariloche', country: 'Argentine', lat: -41.12, lon: -71.22 },
    { name: 'Manaus', country: 'Brésil', lat: -3.12, lon: -60.02 },
    { name: 'Belém', country: 'Brésil', lat: -1.46, lon: -48.5 },
    { name: 'Goiânia', country: 'Brésil', lat: -16.68, lon: -49.26 },
    { name: 'Recife', country: 'Brésil', lat: -8.05, lon: -34.88 },
    { name: 'Natal', country: 'Brésil', lat: -5.79, lon: -35.21 },
    { name: 'João Pessoa', country: 'Brésil', lat: -7.12, lon: -34.86 },
    { name: 'Maceió', country: 'Brésil', lat: -9.67, lon: -35.74 },
    { name: 'Cuiabá', country: 'Brésil', lat: -15.6, lon: -56.1 },
    { name: 'Campo Grande', country: 'Brésil', lat: -20.47, lon: -54.62 },
    { name: 'Boa Vista', country: 'Brésil', lat: 2.82, lon: -60.67 },
    { name: 'Teresina', country: 'Brésil', lat: -3.1, lon: -42.05 },
    { name: 'Vitória', country: 'Brésil', lat: -20.32, lon: -40.34 },
    { name: 'Belo Horizonte', country: 'Brésil', lat: -19.92, lon: -43.94 },
    { name: 'Barranquilla', country: 'Colombie', lat: 10.96, lon: -74.8 },
    { name: 'Cartagena', country: 'Colombie', lat: 10.39, lon: -75.51 },
    { name: 'Trujillo', country: 'Pérou', lat: -8.12, lon: -79.02 },
    { name: 'Iquitos', country: 'Pérou', lat: -3.74, lon: -73.25 },
    { name: 'Guayaquil', country: 'Équateur', lat: -2.19, lon: -79.89 },
    { name: 'Suva', country: 'Fidji', lat: -18.14, lon: 178.44 },
    { name: 'Honiara', country: 'Îles Salomon', lat: -9.43, lon: 160.31 },
    { name: 'Port-Vila', country: 'Vanuatu', lat: -17.73, lon: 168.32 },
    { name: 'Nouméa', country: 'Nouvelle-Calédonie', lat: -22.28, lon: 166.46 },
    { name: 'Papeete', country: 'Polynésie française', lat: -17.53, lon: -149.57 },
    { name: 'Apia', country: 'Samoa', lat: -13.83, lon: -171.75 },
    { name: 'Gold Coast', country: 'Australie', lat: -28.02, lon: 153.42 },
    { name: 'Bendigo', country: 'Australie', lat: -36.76, lon: 144.28 },
    { name: 'Geelong', country: 'Australie', lat: -38.15, lon: 144.36 },
    { name: 'Cairns', country: 'Australie', lat: -16.92, lon: 145.77 },
    { name: 'Townsville', country: 'Australie', lat: -19.26, lon: 146.82 },
    { name: 'Toowoomba', country: 'Australie', lat: -27.56, lon: 151.95 },
    { name: 'New Plymouth', country: 'Nouvelle-Zélande', lat: -39.08, lon: 174.09 },];
// (Nettoyage : les entrées de remplissage *-2 / noms approximatifs sont
// conservés — Open-Meteo renvoie une valeur par position dans l'ordre, donc
// aucune n'est perdue ; on garde simplement la liste plate et ordonnée.)

let weatherVisible = false;
let weatherRing = null;
let weatherData = [];
let weatherPositions = [];
let weatherCount = 0;
let weatherMode = store.get('weatherMode', 'temp');
if (!['temp', 'wind', 'rain', 'aqi'].includes(weatherMode)) weatherMode = 'temp';
const WEATHER_MODE_LABEL = { temp: 'température', wind: 'vent', rain: 'précipitations', aqi: 'qualité de l\'air' };

function weatherColor(temp) {
    if (temp <= -5) return new THREE.Color(0x1d4ed8); // bleu profond
    if (temp <= 0) return new THREE.Color(0x3b82f6);  // bleu
    if (temp <= 8) return new THREE.Color(0x22d3ee);  // cyan
    if (temp <= 16) return new THREE.Color(0x4ade80); // vert
    if (temp <= 24) return new THREE.Color(0xfacc15); // jaune
    if (temp <= 30) return new THREE.Color(0xfb923c); // orange
    return new THREE.Color(0xef4444);                 // rouge
}
function weatherModeColor(w) {
    if (weatherMode === 'wind') {
        const v = w.wind != null ? w.wind : 0;
        return new THREE.Color(v <= 10 ? 0x22d3ee : v <= 25 ? 0x4ade80 : v <= 40 ? 0xfacc15 : v <= 60 ? 0xfb923c : 0xef4444);
    }
    if (weatherMode === 'rain') {
        const v = w.rain != null ? w.rain : 0;
        return new THREE.Color(v <= 0 ? 0x475569 : v < 0.5 ? 0x22d3ee : v < 2 ? 0x3b82f6 : v < 5 ? 0x6366f1 : 0xc026d3);
    }
    if (weatherMode === 'aqi') {
        const v = w.aqi;
        if (v == null) return new THREE.Color(0x475569);
        return new THREE.Color(v <= 50 ? 0x4ade80 : v <= 100 ? 0xfacc15 : v <= 150 ? 0xfb923c : v <= 200 ? 0xef4444 : v <= 300 ? 0xa855f7 : 0x9f1239);
    }
    return weatherColor(w.temp != null ? w.temp : 15);
}

function buildWeatherMesh(cities) {
    if (weatherRing) {
        globeGroup.remove(weatherRing);
        weatherRing.geometry.dispose();
        weatherRing.material.dispose();
        weatherRing = null;
    }
    weatherData = cities;
    weatherPositions = new Array(cities.length);
    if (!cities.length) return;

    const P = [], C = [];
    const seg = (a, b, c) => { P.push(a.x, a.y, a.z, b.x, b.y, b.z); C.push(c.r, c.g, c.b, c.r, c.g, c.b); };
    const SEG = 18;
    for (let i = 0; i < cities.length; i++) {
        const w = cities[i];
        const pos = latLonToVector3(w.lat, w.lon, 1.012);
        weatherPositions[i] = pos.clone();
        const r = weatherMode === 'rain' ? 0.006 + Math.min(w.rain || 0, 10) * 0.0006 : 0.006;
        const c = weatherModeColor(w);
        const { up, north, east } = tangentFrame(w.lat, w.lon);
        for (let k = 0; k < SEG; k++) {
            const a1 = (k / SEG) * Math.PI * 2, a2 = ((k + 1) / SEG) * Math.PI * 2;
            const p1 = pos.clone().add(north.clone().multiplyScalar(Math.cos(a1) * r)).add(east.clone().multiplyScalar(Math.sin(a1) * r));
            const p2 = pos.clone().add(north.clone().multiplyScalar(Math.cos(a2) * r)).add(east.clone().multiplyScalar(Math.sin(a2) * r));
            seg(p1, p2, c);
        }
        if (weatherMode === 'wind' && w.windDir != null && w.wind != null) {
            // Flèche vers où va le vent (la direction météo indique d'où il vient)
            const ang = ((w.windDir + 180) % 360) * D2R;
            const dir = north.clone().multiplyScalar(Math.cos(ang)).add(east.clone().multiplyScalar(Math.sin(ang))).normalize();
            const side = new THREE.Vector3().crossVectors(up, dir).normalize();
            const len = 0.008 + Math.min(w.wind, 80) / 80 * 0.03;
            const tip = pos.clone().add(dir.clone().multiplyScalar(len));
            const back = tip.clone().sub(dir.clone().multiplyScalar(len * 0.3));
            seg(pos, tip, c);
            seg(tip, back.clone().add(side.clone().multiplyScalar(len * 0.18)), c);
            seg(tip, back.clone().sub(side.clone().multiplyScalar(len * 0.18)), c);
        } else {
            for (let k = 0; k < 3; k++) {
                const a = (k / 3) * Math.PI * 2;
                seg(pos, pos.clone().add(north.clone().multiplyScalar(Math.cos(a) * r)).add(east.clone().multiplyScalar(Math.sin(a) * r)), c);
            }
        }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 }));
    lines.frustumCulled = false;
    lines.visible = weatherVisible;
    weatherRing = lines;
    globeGroup.add(lines);
}

async function refreshWeather() {
    const WEATHER_CHUNK = 300; // ~5100 octets d'URL, bien sous la limite 414 (~8000)
    const valid = (v) => typeof v === 'number' && !isNaN(v);
    const val = (v) => (valid(v) ? v : null);
    const total = WEATHER_CITIES.length;
    try {
        // Découpe en paquets, en conservant l'index global pour le re-assemblage
        const chunks = [];
        for (let s = 0; s < total; s += WEATHER_CHUNK) {
            chunks.push({ start: s, slice: WEATHER_CITIES.slice(s, s + WEATHER_CHUNK) });
        }

        // Tous les paquets (météo + air) en parallèle, sans échec global
        const jobs = [];
        for (const ch of chunks) {
            const lats = ch.slice.map((c) => c.lat).join(',');
            const lons = ch.slice.map((c) => c.lon).join(',');
            const url = `${WEATHER_URL}?latitude=${lats}&longitude=${lons}&current=${WEATHER_FIELDS}&timezone=auto`;
            const airUrl = `${AIR_URL}?latitude=${lats}&longitude=${lons}&current=us_aqi,pm2_5&timezone=auto`;
            jobs.push({ start: ch.start, len: ch.slice.length, weather: fetch(url, { cache: 'no-store' }), air: fetch(airUrl, { cache: 'no-store' }) });
        }

        const settled = await Promise.allSettled(
            jobs.flatMap((j) => [j.weather, j.air])
        );
        // Re-assemblage aligné sur l'index global
        const src = new Array(total).fill(null);
        const air = new Array(total).fill(null);
        let okChunks = 0, badChunks = 0, httpErr = null;
        for (let j = 0; j < jobs.length; j++) {
            const { start, len } = jobs[j];
            const w = settled[j * 2], a = settled[j * 2 + 1];
            let got = false;
            if (w.status === 'fulfilled' && w.value.ok) {
                try {
                    const arr = await w.value.json();
                    const list = Array.isArray(arr) ? arr : [arr];
                    for (let k = 0; k < Math.min(list.length, len); k++) src[start + k] = list[k];
                    got = true;
                } catch {}
            } else if (w.status === 'fulfilled' && !w.value.ok && !httpErr) {
                httpErr = w.value.status;
            }
            if (got) okChunks++; else badChunks++;
            if (a.status === 'fulfilled' && a.value.ok) {
                try {
                    const aj = await a.value.json();
                    const list = Array.isArray(aj) ? aj : [aj];
                    for (let k = 0; k < Math.min(list.length, len); k++) air[start + k] = list[k];
                } catch {}
            }
        }

        // Au moins un paquet doit avoir réussi
        if (okChunks === 0) {
            const err = new Error('Open-Meteo injoignable' + (httpErr ? ' (HTTP ' + httpErr + ')' : ''));
            if (httpErr) err.status = httpErr;
            throw err;
        }
        if (badChunks) console.warn(`Météo: ${okChunks}/${jobs.length} paquets OK (${badChunks} en échec)`);

        const cities = [];
        for (let i = 0; i < total; i++) {
            const meta = WEATHER_CITIES[i];
            const rec = src[i];
            if (!rec) continue;
            const cur = rec.current || {};
            const ac = (air[i] && air[i].current) || {};
            const temp = val(cur.temperature_2m);
            const wind = val(cur.wind_speed_10m);
            if (temp == null && wind == null) continue;
            cities.push({
                name: meta.name, country: meta.country, lat: meta.lat, lon: meta.lon,
                temp, wind, windDir: val(cur.wind_direction_10m), rain: val(cur.precipitation),
                feels: val(cur.apparent_temperature), humidity: val(cur.relative_humidity_2m),
                cloud: val(cur.cloud_cover), pressure: val(cur.surface_pressure),
                code: valid(cur.weather_code) ? cur.weather_code : null,
                aqi: val(ac.us_aqi), pm25: val(ac.pm2_5),
                tz: rec.timezone || null, time: cur.time || null,
            });
        }
        weatherCount = cities.length;
        buildWeatherMesh(cities);
        updateWeatherStatus(false, cities);
    } catch (e) {
        console.warn('Rafraîchissement météo:', e);
        updateWeatherStatus(true, e);
    }
}

function updateWeatherStatus(err, result) {
    const el = document.getElementById('weather-status');
    if (!el) return;
    if (err) {
        const upstream = err && err.status >= 500;
        el.textContent = '🌡 erreur de flux';
        el.title = upstream
            ? 'Open-Meteo est momentanément indisponible (HTTP ' + err.status + ') — réessayez au rechargement ou à la réactivation.'
            : 'Open-Meteo n\'a pas répondu (connexion ?)';
        el.style.color = '#f87171';
    } else {
        el.textContent = `🌡 ${weatherCount.toLocaleString('fr-FR')} villes — ${WEATHER_MODE_LABEL[weatherMode]} (Open-Meteo)`;
        el.style.color = '#22d3ee';
    }
}

function toggleWeather() {
    weatherVisible = !weatherVisible;
    if (weatherRing) weatherRing.visible = weatherVisible;
    const btn = document.getElementById('toggle-weather');
    btn.classList.toggle('active', weatherVisible);
    btn.title = weatherVisible
        ? 'Masquer la météo'
        : 'Afficher la météo des grandes villes (Open-Meteo)';
    if (weatherVisible) refreshWeather();
}

// Rafraîchissement périodique (10 min) tant que la couche est visible
setInterval(() => { if (weatherVisible) refreshWeather(); }, 10 * 60 * 1000);

// ---- Affichage / masquage des noms de pays ----
function toggleLabels() {
    labelsVisible = !labelsVisible;
    for (const label of labelElements) {
        label.element.style.display = labelsVisible ? '' : 'none';
    }
    const btn = document.getElementById('toggle-labels');
    btn.classList.toggle('active', labelsVisible);
    btn.title = labelsVisible ? 'Masquer les noms de pays' : 'Afficher les noms de pays';
}

// ---- Rotation ----
let autoRotate = true;

function rotateGlobe(dx, dy) {
    globeGroup.rotation.y += dx;
    globeGroup.rotation.x += dy;
}

// Clavier
document.addEventListener('keydown', (e) => {
    const tag = ((e.target && e.target.tagName) || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
        case 'ArrowLeft':
            rotateGlobe(-ROTATION_SPEED, 0);
            break;
        case 'ArrowRight':
            rotateGlobe(ROTATION_SPEED, 0);
            break;
        case 'ArrowUp':
            rotateGlobe(0, -TILT_SPEED);
            break;
        case 'ArrowDown':
            rotateGlobe(0, TILT_SPEED);
            break;
        case ' ':
            toggleAutoRotate();
            break;
        case '+':
        case '=':
            zoomIn();
            break;
        case '-':
        case '_':
            zoomOut();
            break;
        case 'Escape':
            resetView();
            break;
    }
});

// Boutons
document.getElementById('rotate-left').addEventListener('click', () => rotateGlobe(-ROTATION_SPEED * 5, 0));
document.getElementById('rotate-right').addEventListener('click', () => rotateGlobe(ROTATION_SPEED * 5, 0));
document.getElementById('rotate-up').addEventListener('click', () => rotateGlobe(0, -TILT_SPEED * 5));
document.getElementById('rotate-down').addEventListener('click', () => rotateGlobe(0, TILT_SPEED * 5));
document.getElementById('rotate-center').addEventListener('click', () => {
    resetView();
});
document.getElementById('zoom-in').addEventListener('click', zoomIn);
document.getElementById('zoom-out').addEventListener('click', zoomOut);
document.getElementById('toggle-rotation').addEventListener('click', toggleAutoRotate);
document.getElementById('toggle-flights').addEventListener('click', toggleFlights);
document.getElementById('toggle-ships').addEventListener('click', toggleShips);
document.getElementById('toggle-satellites').addEventListener('click', toggleSatellites);
document.getElementById('toggle-quakes').addEventListener('click', toggleQuakes);
document.getElementById('toggle-eonet').addEventListener('click', toggleEonet);
document.getElementById('toggle-weather').addEventListener('click', toggleWeather);
document.getElementById('toggle-labels').addEventListener('click', toggleLabels);
document.getElementById('toggle-stats').addEventListener('click', toggleStats);
const _si = document.getElementById('stat-indicator');
if (_si) _si.addEventListener('change', () => {
    statsIndicator = _si.value;
    store.set('statsIndicator', statsIndicator);
    if (statsVisible) { rebuildStatsTexture(worldRef); refreshStats(); }
});
// Remplit le menu d'indicateurs depuis le catalogue serveur (libellé FR + unité),
// puis restaure la selection persistee (store). S'execute une fois au chargement.
if (_si) (async () => {
    try {
        const r = await fetch('/api/stats/catalogue', { cache: 'no-store' });
        const j = await r.json();
        const cats = (j && j.ok && Array.isArray(j.data)) ? j.data : (Array.isArray(j) ? j : []);
        if (!cats.length) return;
        _si.length = 0;
        let lastCat = null, grp = null;
        for (const c of cats) {
            if (c.cat && c.cat !== lastCat) {
                grp = document.createElement('optgroup');
                grp.label = c.cat;
                _si.appendChild(grp);
                lastCat = c.cat;
            }
            const opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = c.label + (c.unit ? ' (' + c.unit + ')' : '');
            if (grp) grp.appendChild(opt); else _si.appendChild(opt);
        }
        const saved = statsIndicator || store.get('statsIndicator', cats[0].id);
        _si.value = cats.some((c) => c.id === saved) ? saved : cats[0].id;
        statsIndicator = _si.value;
    } catch { /* catalogue indisponible : select vide, indication par defaut conservee */ }
})();

function toggleAutoRotate() {
    autoRotate = !autoRotate;
    const btn = document.getElementById('toggle-rotation');
    btn.textContent = autoRotate ? '⏸' : '▶';
    btn.title = autoRotate ? 'Mettre en pause la rotation' : 'Reprendre la rotation';
}

// ---- Drag souris ----
let isDragging = false;
let lastMouseX = 0;
let lastMouseY = 0;

container.addEventListener('mousedown', (e) => {
    isDragging = true;
    dragDist = 0;
    stopFollow();
    flyTarget = null;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
});

document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    dragDist += Math.abs(e.clientX - lastMouseX) + Math.abs(e.clientY - lastMouseY);
    const dx = (e.clientX - lastMouseX) * 0.005;
    const dy = (e.clientY - lastMouseY) * 0.005;
    rotateGlobe(dx, dy);
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
});

document.addEventListener('mouseup', () => {
    isDragging = false;
});

// ---- Zoom molette (non passif : on annule le scroll de la page) ----
// Progressif : le facteur suit l'amplitude réelle de la molette,
// plus un petit tour de molette = un tout petit pas de zoom.
const ZOOM_WHEEL_SENS = 0.0011;
container.addEventListener('wheel', (e) => {
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 20;     // deltaMode "lignes" -> pixels
    else if (e.deltaMode === 2) dy *= 200; // deltaMode "pages" -> pixels
    const factor = Math.exp(dy * ZOOM_WHEEL_SENS);
    if (flyTarget) flyTarget.dist = null;
    followDist = null;
    setCameraDistance(cameraDistance * Math.min(1.6, Math.max(0.625, factor)));
}, { passive: false });

// ---- Touch (mobile) ----
let touchStartX = 0;
let touchStartY = 0;
let pinchStartDist = 0;
let pinchStartCamDist = 0;

function touchDist(t) {
    const dx = t[0].clientX - t[1].clientX;
    const dy = t[0].clientY - t[1].clientY;
    return Math.hypot(dx, dy);
}

container.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        dragDist = 0;
        stopFollow();
        flyTarget = null;
    } else if (e.touches.length === 2) {
        pinchStartDist = touchDist(e.touches);
        pinchStartCamDist = cameraDistance;
    }
}, { passive: true });

container.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1) {
        dragDist += Math.abs(e.touches[0].clientX - touchStartX) + Math.abs(e.touches[0].clientY - touchStartY);
        const dx = (e.touches[0].clientX - touchStartX) * 0.005;
        const dy = (e.touches[0].clientY - touchStartY) * 0.005;
        rotateGlobe(dx, dy);
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
    } else if (e.touches.length === 2) {
        const d = touchDist(e.touches);
        if (pinchStartDist > 0 && d > 0) {
            // Écartement des doigts = zoom avant (la caméra s'éloigne en dézoomant)
            setCameraDistance(pinchStartCamDist * (pinchStartDist / d));
        }
    }
}, { passive: true });

// ---- Raycasting pour les clics pays ----
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

container.addEventListener('click', (e) => {
    if (!earthMesh || dragDist > 5) return;

    const rect = container.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObject(earthMesh);
    const ll = hits.length ? vectorToLatLon(globeGroup.worldToLocal(hits[0].point.clone())) : null;

    // Outil de mesure actif : il capte le clic
    if (ll && clickInterceptor && clickInterceptor(ll.lat, ll.lon)) return;

    // Objets au-dessus du globe, par priorité
    if (satsVisible && satsPositions.length) {
        const hit = pickSatAtPixel(e.clientX, e.clientY, rect);
        if (hit) { showSatInfo(hit.sat); return; }
    }
    if (shipsVisible && shipsPositions.length) {
        const hit = pickShipAtPixel(e.clientX, e.clientY, rect);
        if (hit) { showShipInfo(hit.ship); return; }
    }
    if (flightsVisible && flightsPositions.length) {
        const hit = pickFlightAtPixel(e.clientX, e.clientY, rect);
        if (hit) { showFlightInfo(hit.flight); return; }
    }
    if (quakesVisible && quakesPositions.length) {
        const hit = pickQuakeAtPixel(e.clientX, e.clientY, rect);
        if (hit) { showQuakeInfo(hit.quake); return; }
    }
    if (eonetVisible && eonetPositions.length) {
        const hit = pickEonetAtPixel(e.clientX, e.clientY, rect);
        if (hit) { showEonetInfo(hit.event); return; }
    }
    if (weatherVisible && weatherPositions.length) {
        const hit = pickWeatherAtPixel(e.clientX, e.clientY, rect);
        if (hit) { showWeatherInfo(hit.weather); return; }
    }

    if (!ll) return;
    // Pays : polygone exact, sinon étiquette la plus proche (micro-États absents du 110m)
    const poly = countryAt(ll.lat, ll.lon);
    let country = poly ? countryByEn.get(poly.name) : null;
    if (!poly && !country) {
        let best = null, bd = 0.06;
        const point = hits[0].point;
        for (const label of labelElements) {
            const wp = new THREE.Vector3();
            label.mesh.getWorldPosition(wp);
            const d = wp.distanceTo(point);
            if (d < bd) { bd = d; best = label; }
        }
        if (best) country = best.country;
    }
    if (country) showCountryInfo(country, poly || worldByName.get(country.en));
    else if (poly) showCountryInfo({ name: poly.name, en: poly.name, capital: '', lat: ll.lat, lon: ll.lon }, poly);
});

// ---- Coordonnées sous le curseur ----
let cursorQueued = false, lastMove = null;
container.addEventListener('mousemove', (e) => {
    lastMove = e;
    if (cursorQueued || isDragging || !earthMesh) return;
    cursorQueued = true;
    requestAnimationFrame(() => {
        cursorQueued = false;
        const rect = container.getBoundingClientRect();
        mouse.x = ((lastMove.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((lastMove.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        const h = raycaster.intersectObject(earthMesh);
        if (!h.length) { setCursor(null); return; }
        const ll = vectorToLatLon(globeGroup.worldToLocal(h[0].point.clone()));
        const c = countryAt(ll.lat, ll.lon);
        const fr = c && countryByEn.get(c.name);
        setCursor(ll.lat, ll.lon, fr ? fr.name : (c ? c.name : ''));
    });
});
container.addEventListener('mouseleave', () => setCursor(null));

// ---- Sélection d'avion au clic ----
const _pickV = new THREE.Vector3();
function pickFlightAtPixel(cx, cy, rect) {
    // Point NDC du curseur
    const ndcX = ((cx - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((cy - rect.top) / rect.height) * 2 + 1;

    const best = { dist: Infinity, flight: null };
    const camPos = camera.position;

    for (let i = 0; i < flightsPositions.length; i++) {
        const p = flightsPositions[i];
        _pickV.copy(p);
        globeGroup.localToWorld(_pickV);

        // Hémisphère avant seulement (comme les étiquettes)
        if (_pickV.dot(camPos) <= 0) continue;

        _pickV.project(camera);
        if (_pickV.z > 1) continue; // derrière la caméra

        const sx = (_pickV.x * 0.5 + 0.5) * rect.width + rect.left;
        const sy = (-_pickV.y * 0.5 + 0.5) * rect.height + rect.top;
        const d = Math.hypot(sx - cx, sy - cy);
        if (d < best.dist) {
            best.dist = d;
            best.flight = flightsData[i];
        }
    }

    // Rayon de clic toléré en pixels
    if (best.dist < 12) return best;
    return null;
}

// ---- Sélection de satellite au clic (même logique de projection) ----
const _pickSatV = new THREE.Vector3();
function pickSatAtPixel(cx, cy, rect) {
    const best = { dist: Infinity, sat: null };
    const camPos = camera.position;

    for (let i = 0; i < satsPositions.length; i++) {
        const p = satsPositions[i];
        if (!p) continue;
        _pickSatV.copy(p);
        globeGroup.localToWorld(_pickSatV);
        if (_pickSatV.dot(camPos) <= 0) continue;
        _pickSatV.project(camera);
        if (_pickSatV.z > 1) continue;
        const sx = (_pickSatV.x * 0.5 + 0.5) * rect.width + rect.left;
        const sy = (-_pickSatV.y * 0.5 + 0.5) * rect.height + rect.top;
        const d = Math.hypot(sx - cx, sy - cy);
        if (d < best.dist) {
            best.dist = d;
            best.sat = satsData[i];
        }
    }

    if (best.dist < 14) return best;
    return null;
}

// ---- Sélection de séisme au clic (même logique de projection que les avions) ----
const _pickQuakeV = new THREE.Vector3();
function pickQuakeAtPixel(cx, cy, rect) {
    const best = { dist: Infinity, quake: null };
    const camPos = camera.position;

    for (let i = 0; i < quakesPositions.length; i++) {
        const p = quakesPositions[i];
        _pickQuakeV.copy(p);
        globeGroup.localToWorld(_pickQuakeV);
        if (_pickQuakeV.dot(camPos) <= 0) continue;
        _pickQuakeV.project(camera);
        if (_pickQuakeV.z > 1) continue;
        const sx = (_pickQuakeV.x * 0.5 + 0.5) * rect.width + rect.left;
        const sy = (-_pickQuakeV.y * 0.5 + 0.5) * rect.height + rect.top;
        const d = Math.hypot(sx - cx, sy - cy);
        if (d < best.dist) {
            best.dist = d;
            best.quake = quakesData[i];
        }
    }

    if (best.dist < 14) return best;
    return null;
}

// ---- Sélection d'événement EONET au clic (même logique de projection) ----
const _pickEonetV = new THREE.Vector3();
function pickEonetAtPixel(cx, cy, rect) {
    const best = { dist: Infinity, event: null };
    const camPos = camera.position;

    for (let i = 0; i < eonetPositions.length; i++) {
        const p = eonetPositions[i];
        _pickEonetV.copy(p);
        globeGroup.localToWorld(_pickEonetV);
        if (_pickEonetV.dot(camPos) <= 0) continue;
        _pickEonetV.project(camera);
        if (_pickEonetV.z > 1) continue;
        const sx = (_pickEonetV.x * 0.5 + 0.5) * rect.width + rect.left;
        const sy = (-_pickEonetV.y * 0.5 + 0.5) * rect.height + rect.top;
        const d = Math.hypot(sx - cx, sy - cy);
        if (d < best.dist) {
            best.dist = d;
            best.event = eonetData[i];
        }
    }

    if (best.dist < 14) return best;
    return null;
}

// ---- Sélection de point météo au clic (même logique de projection) ----
const _pickWeatherV = new THREE.Vector3();
function pickWeatherAtPixel(cx, cy, rect) {
    const best = { dist: Infinity, weather: null };
    const camPos = camera.position;

    for (let i = 0; i < weatherPositions.length; i++) {
        const p = weatherPositions[i];
        _pickWeatherV.copy(p);
        globeGroup.localToWorld(_pickWeatherV);
        if (_pickWeatherV.dot(camPos) <= 0) continue;
        _pickWeatherV.project(camera);
        if (_pickWeatherV.z > 1) continue;
        const sx = (_pickWeatherV.x * 0.5 + 0.5) * rect.width + rect.left;
        const sy = (-_pickWeatherV.y * 0.5 + 0.5) * rect.height + rect.top;
        const d = Math.hypot(sx - cx, sy - cy);
        if (d < best.dist) {
            best.dist = d;
            best.weather = weatherData[i];
        }
    }

    if (best.dist < 14) return best;
    return null;
}

// ---- Sélection de navire au clic (même logique de projection que les avions) ----
const _pickShipV = new THREE.Vector3();
function pickShipAtPixel(cx, cy, rect) {
    const best = { dist: Infinity, ship: null };
    const camPos = camera.position;

    for (let i = 0; i < shipsPositions.length; i++) {
        const p = shipsPositions[i];
        _pickShipV.copy(p);
        globeGroup.localToWorld(_pickShipV);

        // Hémisphère avant seulement (comme les étiquettes)
        if (_pickShipV.dot(camPos) <= 0) continue;

        _pickShipV.project(camera);
        if (_pickShipV.z > 1) continue;

        const sx = (_pickShipV.x * 0.5 + 0.5) * rect.width + rect.left;
        const sy = (-_pickShipV.y * 0.5 + 0.5) * rect.height + rect.top;
        const d = Math.hypot(sx - cx, sy - cy);
        if (d < best.dist) {
            best.dist = d;
            best.ship = shipsData[i];
        }
    }

    // Rayon de clic toléré en pixels
    if (best.dist < 12) return best;
    return null;
}

// ---- Fiches de sélection (rendues par ui.js, valeurs échappées) ----
const num = (n, d = 0) => (typeof n === 'number' && isFinite(n)) ? n.toLocaleString('fr-FR', { maximumFractionDigits: d }) : 'n/d';
const posStr = (o) => `${o.lat.toFixed(3)}°, ${o.lon.toFixed(3)}°`;
function localTimeStr(tz) {
    try { return new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: tz }).format(new Date()); } catch { return '—'; }
}

function showCountryInfo(country, poly) {
    selectionChanged('country');
    highlightCountry(poly || worldByName.get(country.en));
    showCountryCard(country, poly && poly.name);
}
function showFlightInfo(f) {
    selectionChanged('flight');
    showCard({
        icon: '✈', title: f.callsign || 'Avion sans identifiant', subtitle: 'ICAO ' + (f.icao24 || 'n/d'),
        rows: [
            ['Pays d\'immatriculation', f.country || 'n/d'],
            ['Altitude', f.geoAlt != null ? `${num(f.geoAlt)} m (${num(f.geoAlt * 3.28084)} ft)` : 'n/d'],
            ['Vitesse', f.velocity != null ? `${num(f.velocity * 3.6)} km/h (${num(f.velocity * 1.94384)} nœuds)` : 'n/d'],
            ['Cap', f.track != null ? `${Math.round(f.track)}°` : 'n/d'],
            ['État', f.onGround ? 'au sol' : 'en vol'],
            ['Position', posStr(f)],
        ],
        lat: f.lat, lon: f.lon, zoom: 1.6, ref: { kind: 'flight', id: f.icao24 },
        link: f.icao24 ? { url: 'https://globe.adsbexchange.com/?icao=' + encodeURIComponent(f.icao24), label: 'ADS-B Exchange' } : null,
    });
}
function showShipInfo(s) {
    selectionChanged('ship');
    const st = SHIP_STYLE[s.cat] || SHIP_STYLE.unknown;
    const rows = [
        ['Type', st.l], ['MMSI', s.mmsi || 'n/d'],
        ['Vitesse (SOG)', s.sog != null ? `${num(s.sog, 1)} nœuds (${num(s.sog * 1.852)} km/h)` : 'n/d'],
        ['Cap (COG)', s.cog != null ? `${Math.round(s.cog)}°` : 'n/d'],
        ['État', s.sog > 1 ? 'sous mouvement' : 'à quai / ancré'],
    ];
    if (s.destination) rows.push(['Destination', s.destination]);
    if (s.length) rows.push(['Longueur', `${num(s.length)} m`]);
    if (s.draught) rows.push(['Tirant d\'eau', `${num(s.draught, 1)} m`]);
    if (s.imo) rows.push(['IMO', String(s.imo)]);
    rows.push(['Position', posStr(s)]);
    showCard({
        icon: '⚓', title: s.name || 'Navire sans nom', subtitle: st.l, rows,
        lat: s.lat, lon: s.lon, zoom: 1.5, ref: s.mmsi ? { kind: 'ship', id: s.mmsi } : null,
        link: s.mmsi ? { url: 'https://www.marinetraffic.com/en/ais/details/ships/mmsi:' + encodeURIComponent(s.mmsi), label: 'MarineTraffic' } : null,
    });
}
function showSatInfo(s) {
    selectionChanged('sat');
    const found = api.sats.find(s.norad);
    const rows = [
        ['NORAD', s.norad || 'n/d'],
        ['Altitude', s.altKm != null ? `${num(s.altKm)} km` : 'n/d'],
        ['Vitesse', s.velKmS != null ? `${num(s.velKmS, 2)} km/s (${num(s.velKmS * 3600)} km/h)` : 'n/d'],
    ];
    if (found && found.rec && found.rec.no > 0) {
        rows.push(['Période orbitale', `${num(2 * Math.PI / found.rec.no, 1)} min`]);
        rows.push(['Inclinaison', `${num(found.rec.inclo / D2R, 1)}°`]);
    }
    rows.push(['Position', posStr(s)]);
    const token = showCard({
        icon: '🛰', title: s.name || 'Satellite inconnu', subtitle: s.special ? 'Station / observatoire' : 'Satellite',
        rows, lat: s.lat, lon: s.lon, zoom: 2.0, ref: { kind: 'sat', id: s.norad },
        html: '<p class="hint">Trace au sol : ±45 min (violet = passé, rose = futur). Cercle jaune : zone d\'où le satellite est visible.</p>',
        link: s.norad ? { url: 'https://www.n2yo.com/satellite/?s=' + encodeURIComponent(s.norad), label: 'N2YO' } : null,
    });
    if (api.setTrackSat) api.setTrackSat(s);
    loadCrew(token, s.norad);
}
function showQuakeInfo(q) {
    selectionChanged('quake');
    const rows = [
        ['Magnitude', q.mag != null ? q.mag.toFixed(2) : 'n/d'],
        ['Profondeur', q.depthKm != null ? `${num(q.depthKm)} km` : 'n/d'],
        ['Heure (locale)', q.time ? new Date(q.time).toLocaleString('fr-FR') : 'n/d'],
    ];
    if (q.time) rows.push(['Il y a', agoStr(Date.now() - q.time)]);
    if (q.tsunami) rows.push(['Tsunami', { html: '<b style="color:#f87171">alerte potentielle</b>' }]);
    if (q.felt) rows.push(['Témoignages « ressenti »', num(q.felt)]);
    if (q.alert) rows.push(['Alerte PAGER', q.alert]);
    rows.push(['Position', posStr(q)]);
    showCard({
        icon: '🌐', title: `Séisme M ${q.mag != null ? q.mag.toFixed(1) : '?'}`, subtitle: q.place || '', rows,
        lat: q.lat, lon: q.lon, zoom: 1.5, link: q.url && /^https:\/\//.test(q.url) ? { url: q.url, label: 'Fiche USGS' } : null,
    });
}
function agoStr(ms) {
    const m = Math.round(ms / 60000);
    if (m < 1) return 'moins d\'une minute';
    if (m < 90) return `${m} min`;
    if (m < 2880) return `${Math.round(m / 60)} h`;
    return `${Math.round(m / 1440)} j`;
}
function showEonetInfo(ev) {
    selectionChanged('eonet');
    const rows = [
        ['Type', ev.label],
        ['Intensité', ev.magnitudeValue != null ? `${num(ev.magnitudeValue)} ${ev.unit || ''}`.trim() : 'n/d'],
        ['Dernière obs.', ev.date ? new Date(ev.date).toLocaleString('fr-FR') : 'n/d'],
        ['Trajectoire', `${(ev.path || []).length} point(s)`],
        ['Position', posStr(ev.current)],
    ];
    showCard({
        icon: ev.icon, title: ev.name, subtitle: 'NASA EONET', rows,
        html: ev.desc ? `<div class="card-sec"><p>${esc(ev.desc)}</p></div>` : '',
        lat: ev.current.lat, lon: ev.current.lon, zoom: 1.6,
        link: ev.link && /^https:\/\//.test(ev.link) ? { url: ev.link, label: 'Détails NASA' } : null,
    });
}
function showWeatherInfo(w) {
    selectionChanged('city');
    const [em, txt] = wmo(w.code);
    const rows = [['Conditions', `${em} ${txt}`]];
    if (w.tz) rows.push(['Heure locale', { html: `<span class="localtime" data-tz="${esc(w.tz)}">${esc(localTimeStr(w.tz))}</span>` }]);
    rows.push(
        ['Température', w.temp != null ? `${num(w.temp, 1)} °C${w.feels != null ? ` (ressenti ${num(w.feels)} °C)` : ''}` : 'n/d'],
        ['Vent', w.wind != null ? `${num(w.wind)} km/h${w.windDir != null ? ' (' + Math.round(w.windDir) + '°)' : ''}` : 'n/d'],
        ['Pluie (dernière h)', w.rain != null ? `${num(w.rain, 1)} mm` : 'aucune'],
        ['Humidité', w.humidity != null ? `${Math.round(w.humidity)} %` : 'n/d'],
        ['Nébulosité', w.cloud != null ? `${Math.round(w.cloud)} %` : 'n/d'],
        ['Pression', w.pressure != null ? `${num(w.pressure)} hPa` : 'n/d'],
    );
    if (w.aqi != null) rows.push(['Qualité de l\'air', `AQI ${num(w.aqi)} — ${aqiLabel(w.aqi)}`]);
    if (w.pm25 != null) rows.push(['PM2,5', `${num(w.pm25, 1)} µg/m³`]);
    rows.push(['Position', posStr(w)]);
    showCard({ icon: em, title: w.name, subtitle: w.country || '', rows, lat: w.lat, lon: w.lon, zoom: 1.6 });
}

// ---- Accès générique à un objet par référence (recherche, suivi, statistiques) ----
function findByRef(ref) {
    if (!ref) return null;
    switch (ref.kind) {
        case 'flight': return flightsData.find((x) => x.icao24 === ref.id) || null;
        case 'ship': return shipsData.find((x) => x.mmsi === ref.id) || null;
        case 'sat': return satsData.find((x) => x.norad === ref.id) || null;
        case 'quake': return quakesData.find((x) => x.id === ref.id) || null;
        case 'city': return weatherData.find((x) => x.name === ref.id) || WEATHER_CITIES.find((x) => x.name === ref.id) || null;
        default: return null;
    }
}
function locate(ref) {
    const o = findByRef(ref);
    return o && typeof o.lat === 'number' ? { lat: o.lat, lon: o.lon } : null;
}
function openRef(ref) {
    const o = findByRef(ref);
    if (!o) return;
    if (ref.kind === 'flight') showFlightInfo(o);
    else if (ref.kind === 'ship') showShipInfo(o);
    else if (ref.kind === 'sat') showSatInfo(o);
    else if (ref.kind === 'quake') showQuakeInfo(o);
    else if (ref.kind === 'city') { if (o.code !== undefined || o.temp !== undefined) showWeatherInfo(o); else showCityCard(o); }
    const z = { flight: 1.6, ship: 1.5, sat: 2.0, quake: 1.5, city: 1.6 }[ref.kind];
    flyTo(o.lat, o.lon, z);
}
function screenshot() {
    renderer.render(scene, camera);
    renderer.domElement.toBlob((blob) => {
        if (!blob) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'mappemonde-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.png';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    });
}

// ---- Mise à jour des étiquettes (projection 3D -> 2D) ----
const tempVector = new THREE.Vector3();

function updateLabels() {
    if (!labelsVisible) return;
    const width = container.clientWidth;
    const height = container.clientHeight;

    for (const label of labelElements) {
        tempVector.copy(label.position);
        globeGroup.localToWorld(tempVector);

        // Visible uniquement si face à la caméra (hémisphère avant)
        const facing = tempVector.dot(camera.position);
        if (facing <= 0) {
            label.element.style.display = 'none';
            continue;
        }

        tempVector.project(camera);

        const x = (tempVector.x * 0.5 + 0.5) * width;
        const y = (-tempVector.y * 0.5 + 0.5) * height;

        label.element.style.display = 'block';
        label.element.style.left = `${x}px`;
        label.element.style.top = `${y}px`;
        label.element.style.transform = 'translate(-50%, -130%)';
    }
}

// ---- Boucle d'animation ----
function animate() {
    requestAnimationFrame(animate);

    if (followRef) {
        const loc = locate(followRef);
        if (loc) {
            const t = targetAngles(loc.lat, loc.lon);
            flyTarget = { a: t.a, b: t.b, dist: followDist };
        }
    }
    if (flyTarget) {
        const dy = wrapPi(flyTarget.a - globeGroup.rotation.y);
        const dx = wrapPi(flyTarget.b - globeGroup.rotation.x);
        globeGroup.rotation.y += dy * 0.12;
        globeGroup.rotation.x += dx * 0.12;
        let distOk = true;
        if (flyTarget.dist) {
            setCameraDistance(cameraDistance + (flyTarget.dist - cameraDistance) * 0.1);
            distOk = Math.abs(flyTarget.dist - cameraDistance) < 0.01;
        }
        if (!followRef && Math.abs(dy) < 0.002 && Math.abs(dx) < 0.002 && distOk) flyTarget = null;
    } else if (autoRotate) {
        globeGroup.rotation.y += AUTO_ROTATE_SPEED;
    }

    updateLabels();
    renderer.render(scene, camera);
}

// ---- Responsive ----
function onWindowResize() {
    const width = container.clientWidth;
    const height = container.clientHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
}

window.addEventListener('resize', onWindowResize);

// ---- Câblage des contrôles de la nouvelle interface ----
function wireControls() {
    $('btn-follow').addEventListener('click', stopFollow);
    $('btn-iss').addEventListener('click', () => goToSat('25544'));
    $('btn-css').addEventListener('click', () => goToSat('48274'));

    const sg = $('sat-group');
    sg.value = satsGroup;
    if (sg.value !== satsGroup) { satsGroup = 'active'; sg.value = 'active'; }
    sg.addEventListener('change', () => {
        satsGroup = sg.value;
        store.set('satGroup', satsGroup);
        resetSats();
        if (satsVisible) refreshSatellites();
    });

    const qw = $('quake-window');
    qw.value = quakeWindow;
    qw.addEventListener('change', () => {
        quakeWindow = qw.value;
        store.set('quakeWindow', quakeWindow);
        if (quakesVisible) refreshQuakes();
    });
    setInterval(() => { if (quakesVisible) refreshQuakes(); }, 5 * 60 * 1000);

    const wm = $('weather-mode');
    wm.value = weatherMode;
    wm.addEventListener('change', () => {
        weatherMode = wm.value;
        store.set('weatherMode', weatherMode);
        if (weatherData.length) { buildWeatherMesh(weatherData); updateWeatherStatus(false); }
    });

    const hex = (n) => '#' + n.toString(16).padStart(6, '0');
    const box = $('eonet-chips');
    for (const [id, c] of Object.entries(EONET_CATS)) {
        const el = document.createElement('span');
        el.className = 'chip' + (eonetOff.has(id) ? '' : ' on');
        el.style.setProperty('--c', hex(c.color));
        el.innerHTML = `<i></i>${esc(c.icon + ' ' + c.label)}`;
        el.addEventListener('click', () => {
            if (eonetOff.has(id)) eonetOff.delete(id); else eonetOff.add(id);
            store.set('eonetOff', [...eonetOff]);
            el.classList.toggle('on', !eonetOff.has(id));
            applyEonetFilter();
        });
        box.appendChild(el);
    }
    const legend = $('ship-legend');
    for (const k of ['cargo', 'tanker', 'passenger', 'fishing', 'tug', 'pleasure', 'highspeed', 'military', 'other']) {
        const st = SHIP_STYLE[k];
        const el = document.createElement('span');
        el.className = 'chip static on';
        el.style.setProperty('--c', hex(st.c));
        el.innerHTML = `<i></i>${esc(st.l)}`;
        legend.appendChild(el);
    }
}

// ---- Initialisation (chargement des coordonnées vectorielles + coordonnées des capitales) ----
async function init() {
    let world = [];
    let countries = [];
    try {
        const [resWorld, resCountries] = await Promise.all([
            fetch(DATA_URL),
            fetch(COUNTRIES_URL),
        ]);
        if (!resWorld.ok) throw new Error('HTTP ' + resWorld.status + ' sur ' + DATA_URL);
        if (!resCountries.ok) throw new Error('HTTP ' + resCountries.status + ' sur ' + COUNTRIES_URL);
        world = decodeTopology(await resWorld.json());
        countries = await resCountries.json();
        console.info(`Natural Earth : ${world.length} pays vectoriels chargés (${world.reduce((n, c) => n + c.rings.length, 0)} anneaux)`);
        console.info(`Étiquettes pays : ${countries.length} capitales`);
    } catch (err) {
        console.error("Impossible de charger les données :", err);
        diag('Impossible de charger la carte (' + (err && err.message || err) + '). Fermez l\'ancien serveur (fermer-mappemonde.bat), relancez lancer-mappemonde.bat et rechargez la page.');
    }

    const earthTexture = createEarthTexture(world);
    earthMesh = new THREE.Mesh(
        new THREE.SphereGeometry(1, 64, 64),
        new THREE.MeshStandardMaterial({
            map: earthTexture,
            roughness: 0.8,
            metalness: 0.1,
        })
    );
    globeGroup.add(earthMesh);

    // Atmosphère (halo bleu)
    const atmosphereGeometry = new THREE.SphereGeometry(1.03, 64, 64);
    const atmosphereMaterial = new THREE.MeshBasicMaterial({
        color: 0x3388ff,
        transparent: true,
        opacity: 0.18,
        side: THREE.BackSide,
    });
    atmosphereMesh = new THREE.Mesh(atmosphereGeometry, atmosphereMaterial);
    globeGroup.add(atmosphereMesh);

    // Frontières + côtes + grille vectorielles 3D (nettes à tout zoom)
    buildVectorLines(world);

    buildLabels(countries, world);
    buildWorldIndex(world);
    worldRef = world;
    for (const l of labelElements) countryByEn.set(l.country.en, l.country);

    Object.assign(api, {
        THREE, scene, camera, renderer, globeGroup, container, earthMesh, atmosphereMesh,
        latLonToVector3, tangentFrame,
        countries: labelElements.map((l) => l.country),
        stats: {
            visible: () => statsVisible,
            indicator: () => statsIndicator,
            data: () => ({ values: statsValues, year: statsYear, unit: statsUnit, nameToCode: statsNameToCode }),
            fmt: fmtStatValue,
            setTexture: () => {
                if (!statsTexture) return;
                if (earthMesh && earthMesh.material.uniforms && earthMesh.material.uniforms.dayMap) earthMesh.material.uniforms.dayMap.value = statsTexture;
                else if (earthMesh) earthMesh.material.map = statsTexture;
            },
        },
        cities: WEATHER_CITIES,
        data: {
            flights: () => flightsData, ships: () => shipsData, sats: () => satsData,
            quakes: () => quakesData, eonet: () => eonetData, weather: () => weatherData,
        },
        sats: {
            find: (norad) => {
                const i = satsData.findIndex((x) => x.norad === norad);
                return i < 0 ? null : { sat: satsData[i], rec: satsRecs[i] };
            },
        },
        open: {
            country: (c) => { showCountryInfo(c, worldByName.get(c.en)); flyTo(c.lat, c.lon, 2.4); },
            city: (c) => { selectionChanged('city'); showCityCard(c); flyTo(c.lat, c.lon, 1.6); },
        },
        openRef, flyTo, follow, stopFollow, locate, screenshot,
        setClickInterceptor: (fn) => { clickInterceptor = fn; },
        setTrackSat: () => {},
    });
    wireControls();
    try { initExtras(api); } catch (e) { console.error('Extras :', e); }
    // Restauration : couche "Chiffres des pays" memorisee
    if (store.get('statsVisible', false)) { try { activateStats(); } catch (e) { console.error('Stats :', e); } }
    try { initUI(api); } catch (e) { console.error('Interface :', e); }
    setZoomInfo(cameraDistance);
    animate();
}

init();

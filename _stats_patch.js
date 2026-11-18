const fs = require('fs');

function apply(file, pairs) {
    let s = fs.readFileSync(file, 'utf8');
    pairs.forEach(([from, to], i) => {
        if (!from) throw new Error('from vide #' + i);
        if (to === undefined) throw new Error('to manquant #' + i);
        const n = s.split(from).length - 1;
        if (n !== 1) throw new Error(file + ' ancres ' + n + ' (attendu 1) #' + i + ': ' + JSON.stringify(from.slice(0, 60)));
        s = s.replace(from, to);
    });
    fs.writeFileSync(file, s, 'utf8');
    console.log('OK ' + file);
}

const V = 'v=20261118b';
const VOLD = 'v=20261118a';

// ==================== 1. server.js ====================
apply('D:\\mappemonde\\server.js', [
    [
        `}, 7 * 24 * 3600 * 1000, 365 * 24 * 3600 * 1000);`,
`}, 7 * 24 * 3600 * 1000, 365 * 24 * 3600 * 1000);

// ---- Statistiques par pays (Banque mondiale, v2, sans cle) ----
// Catalogue = source unique de verite (libelle FR, unite, id WB).
const STAT_CATALOG = [
    { id: 'SP.POP.TOTL.IN',  label: 'Population',               unit: 'hab.' },
    { id: 'SP.DNST.TOTL',    label: 'Densite de population',    unit: 'hab./km2' },
    { id: 'NY.GDP.MKTP.CD',  label: 'PIB',                      unit: 'USD' },
    { id: 'NY.GDP.PCAP.CD',  label: 'PIB par habitant',         unit: 'USD' },
    { id: 'SP.DYN.LE00.IN',  label: 'Esperance de vie',         unit: 'ans' },
    { id: 'SP.DYN.IMRT.IN',  label: 'Mortalite infantile',      unit: 'permille nes vivants' },
    { id: 'SL.UEM.TOTL.ZS',  label: 'Taux de chomage',          unit: '%' },
    { id: 'SP.URB.TOTL.IN.ZS', label: 'Population urbaine',     unit: '%' },
    { id: 'SP.POP.1564.SP',  label: 'Age median',               unit: 'ans' },
    { id: 'SE.ACT.TOTL.ZS',  label: 'Alphabetisation adultes',  unit: '%' },
    { id: 'SE.PRM.ENRR',     label: 'Scolarisation primaire',   unit: '%' },
    { id: 'IT.NET.USER.ZS',  label: 'Utilisateurs Internet',    unit: '%' },
    { id: 'IT.CEL.MOBP.P5',  label: 'Abonnements mobiles',      unit: '/100 hab.' },
    { id: 'EG.ELEC.ACES.ZS', label: "Acces a l'electricite",    unit: '%' },
    { id: 'EN.ATM.CO2E.PC',  label: 'CO2 par habitant',         unit: 't' },
    { id: 'EN.ATM.CO2E.KT.CE', label: 'Emissions de CO2',       unit: 'kt' },
    { id: 'SI.POV.GINI',     label: 'Coefficient de Gini',      unit: 'indice' },
    { id: 'EG.GEX.IKSD.CD',  label: 'Exports',                  unit: 'M USD' },
    { id: 'GC.XPK.TOTL.GD.ZS', label: 'Depenses publiques',     unit: '% du PIB' },
    { id: 'LE.XPD.SOC.GD.ZS', label: 'Depenses sociales',       unit: '% du PIB' },
    { id: 'GC.DOD.TOTL.GD.ZS', label: 'Depenses militaires',    unit: '% du PIB' },
    { id: 'SH.STA.BEDS',     label: "Lits d'hopital",           unit: '/1000 hab.' },
];
const WB_BASE = 'https://api.worldbank.org/v2/country/all/indicator/';

async function wbLatestYear(id) {
    // Annee la plus recente disponible : 2025, sinon repli 2025:2022 (premiere annee non vide)
    for (const date of ['2025', '2025:2022']) {
        try {
            const j = await getJson(WB_BASE + id + '?date=' + date + '&format=json&per_page=600', 30000);
            const arr = Array.isArray(j) ? j[1] : (j && j.data) || [];
            if (!arr.length) continue;
            let year = null, count = 0;
            const values = {};
            for (const r of arr) {
                if (!r || !r.id || r.value == null) continue;
                const v = typeof r.value === 'number' && isFinite(r.value) ? r.value : parseFloat(r.value);
                if (!isFinite(v)) continue;
                values[r.id] = v;
                year = parseInt(String(r.year), 10);
                count++;
            }
            if (count >= 5 && year) return { year, values };
        } catch { /* annee vide ou API indisponible : on essaie le repli */ }
    }
    throw new Error('API Banque mondiale indisponible');
}
const getStatsCatalog = makeFeed(async () => STAT_CATALOG.map(({ id, label, unit }) => ({ id, label, unit })), 24 * 3600 * 1000, 24 * 3600 * 1000);
// Un cache par indicateur (faible cout : ~23 indicateurs max)
const statsFeeds = new Map();
function getStats(indicator) {
    if (!statsFeeds.has(indicator)) {
        statsFeeds.set(indicator, makeFeed(async () => {
            const cat = (STAT_CATALOG.find((c) => c.id === indicator) || {});
            const { year, values } = await wbLatestYear(indicator);
            return { indicator, label: cat.label || '', unit: cat.unit || '', year, values };
        }, 7 * 24 * 3600 * 1000, 365 * 24 * 3600 * 1000));
    }
    return statsFeeds.get(indicator);
}`,
    ],
    [
        `    if (pathname === '/api/crew') { feedJson(res, getCrew); return; }`,
`    if (pathname === '/api/crew') { feedJson(res, getCrew); return; }
    if (pathname === '/api/stats/catalogue') { feedJson(res, getStatsCatalog); return; }
    if (pathname === '/api/stats') {
        const indicator = q.get('indicator') || '';
        if (!STAT_CATALOG.some((c) => c.id === indicator)) {
            sendJson(res, 400, { ok: false, error: 'indicateur inconnu' });
            return;
        }
        feedJson(res, getStats(indicator));
        return;
    }`,
    ],
]);

// ==================== 2. globe.js ====================
apply('D:\\mappemonde\\globe.js', [
    [
        `    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}`,
`    const texture = new THREE.CanvasTexture(canvas);
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
        const code = statsNameToCode.get(rec.name) || statsNameToCode.get(rec.en);
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
    const tex = createEarthTexture(world, (name) => {
        const code = statsNameToCode.get(name);
        return (code && colorBy[code] ? colorBy[code] : statColor(null, min, max)).css;
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
        if (st) {
            const n = statsValues ? Object.keys(statsValues).length : 0;
            st.textContent = 'OK ' + n + ' pays' + (statsYear ? ' (' + statsYear + ')' : '') + (j.stale ? ' - cache' : '');
            st.style.color = '#4ade80';
        }
        applyStats();
    } catch (e) {
        if (st) { st.textContent = 'erreur : ' + (e && e.message || e); st.style.color = '#f87171'; }
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
    // Correspondance nom (Natural Earth / labels) -> code ISO3 via REST Countries
    const finish = () => { rebuildStatsTexture(worldRef); refreshStats(); };
    if (statsNameToCode.size) finish();
    else {
        fetch('/api/countries', { cache: 'no-store' }).then((r) => r.json()).then((j) => {
            if (!j.ok || !Array.isArray(j.data)) throw new Error(j.error || 'HTTP ' + r.status);
            const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
            for (const rec of j.data) {
                for (const n of [rec.common, rec.official, ...(rec.fra || [])]) {
                    if (n && !statsNameToCode.has(n)) statsNameToCode.set(n, rec.cca3);
                    if (n) { const nk = norm(n); if (nk && !statsNameToCode.has(nk)) statsNameToCode.set(nk, rec.cca3); }
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
}`,
    ],
    [
        `function createEarthTexture(world) {`,
        `function createEarthTexture(world, colorFor) {`,
    ],
    [
        `            ctx.fillStyle = hashColor(country.name);`,
        `            ctx.fillStyle = colorFor ? colorFor(country.name) : hashColor(country.name);`,
    ],
    [
        `        label.textContent = country.name;`,
        `        label.innerHTML = '<span class="l-name">' + country.name + '</span><span class="l-val"></span>';`,
    ],
    [
        `document.getElementById('toggle-labels').addEventListener('click', toggleLabels);`,
`document.getElementById('toggle-labels').addEventListener('click', toggleLabels);
document.getElementById('toggle-stats').addEventListener('click', toggleStats);
const _si = document.getElementById('stat-indicator');
if (_si) _si.addEventListener('change', () => {
    statsIndicator = _si.value;
    store.set('statsIndicator', statsIndicator);
    if (statsVisible) { rebuildStatsTexture(worldRef); refreshStats(); }
});`,
    ],
    [
        `        countries: labelElements.map((l) => l.country),`,
`        countries: labelElements.map((l) => l.country),
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
        },`,
    ],
    [
        `    buildWorldIndex(world);`,
`    buildWorldIndex(world);
    worldRef = world;`,
    ],
    [
        `    try { initExtras(api); } catch (e) { console.error('Extras :', e); }`,
`    try { initExtras(api); } catch (e) { console.error('Extras :', e); }
    // Restauration : couche "Chiffres des pays" memorisee
    if (store.get('statsVisible', false)) { try { activateStats(); } catch (e) { console.error('Stats :', e); } }`,
    ],
    [`?${VOLD}`, `?${V}`],
    [`style.css?${VOLD}`, `style.css?${V}`],
]);

// ==================== 3. extras.js ====================
apply('D:\\mappemonde\\extras.js', [
    [
        `    $('basemap').addEventListener('change', () => { bm.mode = $('basemap').value; applyBasemap(); });`,
`    $('basemap').addEventListener('change', () => {
        bm.mode = $('basemap').value;
        // La choroplethe "Chiffres des pays" repose sur la carte politique
        if (bm.mode !== 'political' && ctx.stats && ctx.stats.visible()) {
            const btn = $('toggle-stats');
            if (btn) btn.click();
            setStatus('"Chiffres des pays" desactive (la choroplethe necessite la carte politique)', '#fbbf24');
        }
        applyBasemap();
        if (bm.mode === 'political' && ctx.stats && ctx.stats.visible()) ctx.stats.setTexture();
    });`,
    ],
]);

// ==================== 4. ui.js ====================
apply('D:\\mappemonde\\ui.js', [
    [
        `export function showCountryCard(country, polyName) {`,
`function apiStatsValue(country) {
    if (!API || !API.stats || !API.stats.visible()) return null;
    const d = API.stats.data();
    if (!d || !d.values) return null;
    const code = d.nameToCode.get(country.name) || d.nameToCode.get(country.en);
    if (!code) return null;
    const v = d.values[code];
    return { v, unit: d.unit || '', year: d.year || null, fmt: API.stats.fmt };
}

export function showCountryCard(country, polyName) {`,
    ],
    [
        `        box.innerHTML = \`<h4>Chiffres clés</h4><dl class="kv">\${rows.map(([k, v]) => \`<dt>\${esc(k)}</dt><dd>\${esc(v)}</dd>\`).join('')}</dl>\`;
    });`,
`        box.innerHTML = \`<h4>Chiffres clés</h4><dl class="kv">\${rows.map(([k, v]) => \`<dt>\${esc(k)}</dt><dd>\${esc(v)}</dd>\`).join('')}</dl>\`;
    });
    const sv = apiStatsValue(country);
    if (sv && sv.v != null && isFinite(sv.v)) {
        cardExtra(token, \`<div class="card-sec"><h4>Indicateur courant</h4><dl class="kv"><dt>Valeur</dt><dd>\${esc(sv.fmt(sv.v)) + (sv.unit ? ' ' + esc(sv.unit) : '') + (sv.year ? ' (' + esc(sv.year) + ')' : '')}</dd></dl></div>\`);
    }`,
    ],
    [
        `const LAYER_ORDER = ['toggle-flights', 'toggle-ships', 'toggle-satellites', 'toggle-quakes', 'toggle-eonet', 'toggle-weather', 'toggle-aurora', 'toggle-daynight', 'toggle-labels'];`,
        `const LAYER_ORDER = ['toggle-flights', 'toggle-ships', 'toggle-satellites', 'toggle-quakes', 'toggle-eonet', 'toggle-weather', 'toggle-aurora', 'toggle-daynight', 'toggle-labels', 'toggle-stats'];`,
    ],
]);

// ==================== 5. index.html ====================
apply('D:\\mappemonde\\index.html', [
    [
        `<div class="chips" id="eonet-chips"></div>
                    </div>
                </div>
            </section>`,
`<div class="chips" id="eonet-chips"></div>
                    </div>
                </div>
            </section>

            <section class="group">
                <h3>Chiffres des pays</h3>
                <div class="layer">
                    <button id="toggle-stats" class="switch" style="--c:#a78bfa" title="Choroplethe + valeurs par pays (Banque mondiale). Necessite la carte politique."><span class="dot"></span><span class="lbl">Chiffres des pays</span><i class="tgl"></i></button>
                    <div class="status" id="stat-status"></div>
                    <div class="sub">
                        <label class="field">Indicateur
                            <select id="stat-indicator"></select>
                        </label>
                        <div id="stat-legend" class="stat-legend" style="display:none"></div>
                    </div>
                </div>
            </section>`,
    ],
    [`?${VOLD}`, `?${V}`],
]);

// ==================== 6. style.css ====================
apply('D:\\mappemonde\\style.css', [
    [
        `    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5); letter-spacing: 0.02em;
}`,
`    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5); letter-spacing: 0.02em;
}
.country-label .l-val { display: block; font-size: 0.58rem; font-weight: 700; color: inherit; }
.country-label.has-val { border-color: rgba(255, 255, 255, 0.35); }

/* ---------- Choroplethe : legende ---------- */
.stat-legend { margin: 6px 4px 2px; }
.stat-grad { height: 8px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.18); }
.stat-ends { display: flex; justify-content: space-between; font-size: 0.66rem; color: var(--muted); margin-top: 3px; }
.stat-meta { font-size: 0.62rem; color: var(--muted); opacity: 0.8; margin-top: 2px; }`,
    ],
]);

console.log('TOUT OK');

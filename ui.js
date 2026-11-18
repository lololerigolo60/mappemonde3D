// ---- Interface : panneaux, recherche, fiches de sélection, statistiques en direct ----
// Ce module ne dépend pas de globe.js : globe.js lui passe l'objet `api` via initUI(api).

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (id) => document.getElementById(id);
const fmt = (n, d = 0) => (typeof n === 'number' && isFinite(n)) ? n.toLocaleString('fr-FR', { maximumFractionDigits: d }) : 'n/d';

// ---- Préférences persistantes (localStorage, tolérant aux erreurs) ----
const STORE_KEY = 'mappemonde.v2';
let storeCache = null;
function readStore() {
    if (storeCache) return storeCache;
    try { storeCache = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch { storeCache = {}; }
    return storeCache;
}
export const store = {
    get(k, def) { const v = readStore()[k]; return v === undefined ? def : v; },
    set(k, v) { readStore()[k] = v; try { localStorage.setItem(STORE_KEY, JSON.stringify(storeCache)); } catch {} },
};

// ---- Codes météo WMO ----
export function wmo(code) {
    const t = {
        0: ['☀️', 'Ciel dégagé'], 1: ['🌤', 'Plutôt dégagé'], 2: ['⛅', 'Partiellement nuageux'], 3: ['☁️', 'Couvert'],
        45: ['🌫', 'Brouillard'], 48: ['🌫', 'Brouillard givrant'], 51: ['🌦', 'Bruine légère'], 53: ['🌦', 'Bruine'], 55: ['🌦', 'Bruine dense'],
        56: ['🌧', 'Bruine verglaçante'], 57: ['🌧', 'Bruine verglaçante'], 61: ['🌧', 'Pluie faible'], 63: ['🌧', 'Pluie'], 65: ['🌧', 'Pluie forte'],
        66: ['🌧', 'Pluie verglaçante'], 67: ['🌧', 'Pluie verglaçante'], 71: ['🌨', 'Neige faible'], 73: ['🌨', 'Neige'], 75: ['❄️', 'Neige forte'],
        77: ['🌨', 'Grains de neige'], 80: ['🌦', 'Averses'], 81: ['🌧', 'Averses'], 82: ['⛈', 'Averses violentes'], 85: ['🌨', 'Averses de neige'],
        86: ['🌨', 'Averses de neige'], 95: ['⛈', 'Orage'], 96: ['⛈', 'Orage et grêle'], 99: ['⛈', 'Orage violent et grêle'],
    };
    return t[code] || ['🌡', 'Conditions inconnues'];
}
export function aqiLabel(v) {
    if (v == null) return 'n/d';
    if (v <= 50) return 'Bon'; if (v <= 100) return 'Modéré'; if (v <= 150) return 'Mauvais (sensibles)';
    if (v <= 200) return 'Mauvais'; if (v <= 300) return 'Très mauvais'; return 'Dangereux';
}

let API = null;

// ---- Bandeau de diagnostic (erreurs de chargement / de rendu) ----
let diagCount = 0;
export function diag(msg) {
    const box = $('diag');
    if (!box || diagCount >= 6) return;
    diagCount++;
    box.hidden = false;
    const p = document.createElement('div');
    p.textContent = msg;
    box.querySelector('.diag-body').appendChild(p);
    box.querySelector('button').onclick = () => { box.hidden = true; };
}

// ---- Barre d'état ----
export function setCursor(lat, lon, name) {
    const el = $('cursor-info');
    if (!el) return;
    if (lat == null) { el.textContent = 'Curseur : —'; return; }
    el.textContent = `Curseur : ${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'O'}${name ? ' — ' + name : ''}`;
}
export function setZoomInfo(dist) {
    const el = $('zoom-info');
    if (el) el.textContent = `Altitude caméra ≈ ${fmt((dist - 1) * 6371)} km`;
}

// ================= Fiches de sélection =================
let cardToken = 0;
let currentCard = null;
export const isCurrent = (t) => t === cardToken;

function openRightPanel() {
    document.body.classList.remove('hide-right');
    setTab('info');
}

export function showCard(spec) {
    const token = ++cardToken;
    currentCard = spec;
    const panel = $('info-panel');
    const kv = (spec.rows || []).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v && v.html != null ? v.html : esc(v)}</dd>`).join('');
    const actions = [];
    if (spec.lat != null) actions.push('<button class="mini" data-act="center">🎯 Centrer</button>');
    if (spec.ref) actions.push('<button class="mini" data-act="follow">👁 Suivre</button>');
    if (spec.lat != null) actions.push('<button class="mini" data-act="copy">📋 Coordonnées</button>');
    if (spec.link) actions.push(`<a class="mini" href="${esc(spec.link.url)}" target="_blank" rel="noopener">${esc(spec.link.label)} ↗</a>`);
    panel.innerHTML = `
        <div class="card-head">
            ${spec.flag ? `<img class="flag" id="card-flag" src="${esc(spec.flag)}" alt="">` : `<span class="ic" id="card-ic">${esc(spec.icon || '')}</span>`}
            <div><div class="country-name">${esc(spec.title)}</div>${spec.subtitle ? `<div class="card-sub">${esc(spec.subtitle)}</div>` : ''}</div>
        </div>
        ${kv ? `<dl class="kv">${kv}</dl>` : ''}
        ${spec.html || ''}
        <div class="card-actions">${actions.join('')}</div>
        <div id="card-extra"></div>`;
    openRightPanel();
    return token;
}

function cardExtra(token, html, append = true) {
    if (!isCurrent(token)) return null;
    const ex = $('card-extra');
    if (!ex) return null;
    const div = document.createElement('div');
    div.innerHTML = html;
    const node = div.firstElementChild;
    if (node) ex.appendChild(node);
    return node;
}

$('info-panel').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || !currentCard || !API) return;
    const c = currentCard;
    if (b.dataset.act === 'center') API.flyTo(c.lat, c.lon, c.zoom);
    else if (b.dataset.act === 'follow') { API.flyTo(c.lat, c.lon, c.zoom || 2.0); API.follow(c.ref); }
    else if (b.dataset.act === 'copy') {
        const txt = `${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`;
        navigator.clipboard && navigator.clipboard.writeText(txt).then(() => { b.textContent = '✓ Copié'; }).catch(() => {});
    }
});

// ---- Données externes (fiches pays / villes) ----
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
let countriesPromise = null;
let countriesIdx = null;
function loadCountriesDB() {
    if (!countriesPromise) {
        countriesPromise = fetch('/api/countries').then((r) => r.json()).then((j) => {
            if (!j.ok) throw new Error(j.error);
            const idx = new Map();
            for (const rec of j.data) {
                for (const n of [rec.common, rec.official, ...(rec.fra || [])]) if (n) idx.set(norm(n), rec);
            }
            countriesIdx = { list: j.data, idx };
            return countriesIdx;
        }).catch(() => { countriesPromise = null; return null; });
    }
    return countriesPromise;
}
function matchCountry(db, c) {
    let r = db.idx.get(norm(c.en)) || db.idx.get(norm(c.name));
    if (r) return r;
    let best = null, bd = 1.5;
    for (const rec of db.list) {
        const ll = rec.capitalLatLng;
        if (!ll) continue;
        const d = Math.hypot(ll[0] - c.lat, (ll[1] - c.lon) * Math.cos(c.lat * Math.PI / 180));
        if (d < bd) { bd = d; best = rec; }
    }
    return best;
}

async function fetchJson(url, ms = 12000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
        const r = await fetch(url, { signal: ctl.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
    } finally { clearTimeout(t); }
}

async function loadPlaceWeather(token, lat, lon, label) {
    const node = cardExtra(token, `<div class="card-sec"><h4>Météo — ${esc(label)}</h4><div class="loading">chargement…</div></div>`);
    if (!node) return;
    try {
        const [w, a] = await Promise.allSettled([
            fetchJson(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,is_day&timezone=auto`),
            fetchJson(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=us_aqi,pm2_5&timezone=auto`),
        ]);
        if (!isCurrent(token)) return;
        if (w.status !== 'fulfilled') throw new Error('météo indisponible');
        const cur = w.value.current || {};
        const [em, txt] = wmo(cur.weather_code);
        const tz = w.value.timezone;
        const rows = [
            ['Conditions', `${em} ${txt}`],
            ['Température', cur.temperature_2m != null ? `${fmt(cur.temperature_2m, 1)} °C (ressenti ${fmt(cur.apparent_temperature, 0)} °C)` : 'n/d'],
            ['Humidité', cur.relative_humidity_2m != null ? `${cur.relative_humidity_2m} %` : 'n/d'],
            ['Vent', cur.wind_speed_10m != null ? `${fmt(cur.wind_speed_10m, 0)} km/h` : 'n/d'],
        ];
        if (a.status === 'fulfilled' && a.value.current && a.value.current.us_aqi != null) {
            rows.push(['Qualité de l\'air', `${fmt(a.value.current.us_aqi)} — ${aqiLabel(a.value.current.us_aqi)}`]);
        }
        if (tz) rows.unshift(['Heure locale', { html: `<span class="localtime" data-tz="${esc(tz)}">${localTime(tz)}</span> <span class="card-sub">${esc(tz)}</span>` }]);
        node.innerHTML = `<h4>Météo — ${esc(label)}</h4><dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v && v.html != null ? v.html : esc(v)}</dd>`).join('')}</dl>`;
    } catch {
        node.innerHTML = `<h4>Météo — ${esc(label)}</h4><div class="loading">indisponible</div>`;
    }
}

async function loadWiki(token, title) {
    try {
        const j = await fetchJson('https://fr.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title.replace(/ /g, '_')));
        if (!isCurrent(token) || !j.extract || j.type === 'disambiguation') return;
        let ex = j.extract;
        if (ex.length > 520) ex = ex.slice(0, 520).replace(/\s+\S*$/, '') + '…';
        const url = j.content_urls && j.content_urls.desktop && j.content_urls.desktop.page;
        cardExtra(token, `<div class="card-sec"><h4>Aperçu</h4><p>${esc(ex)}</p>${url ? `<p><a href="${esc(url)}" target="_blank" rel="noopener">Wikipédia ↗</a></p>` : ''}</div>`);
    } catch {}
}

function apiStatsValue(country) {
    if (!API || !API.stats || !API.stats.visible()) return null;
    const d = API.stats.data();
    if (!d || !d.values) return null;
    const code = d.nameToCode.get(country.name) || d.nameToCode.get(country.en);
    if (!code) return null;
    const v = d.values[code];
    return { v, unit: d.unit || '', year: d.year || null, fmt: API.stats.fmt };
}

export function showCountryCard(country, polyName) {
    const token = showCard({
        icon: '🌍', title: country.name, subtitle: country.capital ? `Capitale : ${country.capital}` : (polyName || ''),
        rows: [['Position (capitale)', `${country.lat.toFixed(1)}°, ${country.lon.toFixed(1)}°`]],
        lat: country.lat, lon: country.lon, zoom: 2.0,
    });
    cardExtra(token, '<div class="card-sec" id="country-facts"><h4>Chiffres clés</h4><div class="loading">chargement…</div></div>');
    loadCountriesDB().then((db) => {
        if (!isCurrent(token)) return;
        const box = $('country-facts');
        if (!box) return;
        const rec = db && matchCountry(db, country);
        if (!rec) { box.innerHTML = '<h4>Chiffres clés</h4><div class="loading">non disponibles pour ce territoire</div>'; return; }
        const flag = $('card-flag');
        if (!flag) {
            const ic = $('card-ic');
            if (ic) { const img = document.createElement('img'); img.className = 'flag'; img.id = 'card-flag'; img.alt = ''; img.src = rec.flag; ic.replaceWith(img); }
        }
        const dens = rec.population && rec.area ? rec.population / rec.area : null;
        const rows = [
            ['Population', fmt(rec.population)], ['Superficie', rec.area ? fmt(rec.area) + ' km²' : 'n/d'], ['Densité', dens != null ? fmt(dens, 1) + ' hab./km²' : 'n/d'],
            ['Région', [rec.subregion || rec.region].filter(Boolean).join('') || 'n/d'],
            ['Langues', rec.languages.slice(0, 4).join(', ') || 'n/d'], ['Monnaie', rec.currencies.slice(0, 2).join(', ') || 'n/d'],
            ['Indicatif', rec.idd || 'n/d'], ['Domaine Internet', rec.tld || 'n/d'], ['Conduite', rec.drives === 'left' ? 'à gauche' : rec.drives === 'right' ? 'à droite' : 'n/d'],
            ['Pays frontaliers', rec.borders.length ? String(rec.borders.length) : 'aucun'],
        ];
        box.innerHTML = `<h4>Chiffres clés</h4><dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
    });
    const sv = apiStatsValue(country);
    if (sv && sv.v != null && isFinite(sv.v)) {
        cardExtra(token, `<div class="card-sec"><h4>Indicateur courant</h4><dl class="kv"><dt>Valeur</dt><dd>${esc(sv.fmt(sv.v)) + (sv.unit ? ' ' + esc(sv.unit) : '') + (sv.year ? ' (' + esc(sv.year) + ')' : '')}</dd></dl></div>`);
    }
    if (country.capital) loadPlaceWeather(token, country.lat, country.lon, country.capital);
    loadWiki(token, country.name);
}

export function showCityCard(city) {
    const token = showCard({
        icon: '🏙', title: city.name, subtitle: city.country || '',
        rows: [['Position', `${city.lat.toFixed(3)}°, ${city.lon.toFixed(3)}°`]],
        lat: city.lat, lon: city.lon, zoom: 1.6, ref: null,
    });
    loadPlaceWeather(token, city.lat, city.lon, city.name);
    loadWiki(token, city.name);
}

// ---- Équipage ISS / Tiangong ----
export async function loadCrew(token, noradId) {
    if (noradId !== '25544' && noradId !== '48274') return;
    const node = cardExtra(token, '<div class="card-sec"><h4>Équipage en orbite</h4><div class="loading">chargement…</div></div>');
    try {
        const j = await fetchJson('/api/crew');
        if (!isCurrent(token) || !node) return;
        if (!j.ok) throw new Error();
        const craft = noradId === '25544' ? 'ISS' : 'Tiangong';
        const crew = (j.data.people || []).filter((p) => p.craft === craft);
        node.innerHTML = `<h4>Équipage en orbite (${crew.length})</h4>` + (crew.length ? `<p>${crew.map((p) => esc(p.name)).join(' · ')}</p>` : '<p>Aucun équipage listé.</p>');
    } catch { if (node) node.innerHTML = '<h4>Équipage en orbite</h4><div class="loading">indisponible</div>'; }
}
export { cardExtra };

// ================= Horloge / heures locales =================
function localTime(tz) {
    try { return new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: tz }).format(new Date()); } catch { return '—'; }
}
function tickClock() {
    const d = new Date();
    const el = $('clock');
    if (el) el.textContent = 'UTC ' + d.toISOString().slice(11, 19);
    document.querySelectorAll('.localtime').forEach((n) => { n.textContent = localTime(n.dataset.tz); });
}

// ================= Recherche =================
let srItems = [];
let srSel = -1;
function srRender(items) {
    const box = $('search-results');
    srItems = items; srSel = -1;
    if (!items.length) { box.innerHTML = '<div class="sr-empty">Aucun résultat</div>'; box.hidden = false; return; }
    box.innerHTML = items.map((it, i) => `<div class="sr-item" data-i="${i}"><span class="ic">${it.icon}</span><span class="t">${esc(it.title)}</span><span class="s">${esc(it.sub || '')}</span></div>`).join('');
    box.hidden = false;
}
function srSearch(q) {
    const nq = norm(q);
    if (nq.length < 2) { $('search-results').hidden = true; return; }
    const out = [];
    const score = (hay) => { const h = norm(hay); if (!h) return 0; if (h === nq) return 3; if (h.startsWith(nq)) return 2; if (h.includes(nq)) return 1; return 0; };
    const add = (arr, f, max, mk) => {
        arr.map((x) => ({ x, s: f(x) })).filter((o) => o.s > 0).sort((a, b) => b.s - a.s).slice(0, max)
            .forEach((o) => out.push({ ...mk(o.x), score: o.s }));
    };
    const d = API.data;
    add(API.countries, (c) => Math.max(score(c.name), score(c.en), score(c.capital || '') * 0.9), 5,
        (c) => ({ icon: '🌍', title: c.name, sub: c.capital ? 'Pays · ' + c.capital : 'Pays', go: () => API.open.country(c) }));
    add(API.cities, (c) => score(c.name), 5,
        (c) => ({ icon: '🏙', title: c.name, sub: c.country, go: () => API.open.city(c) }));
    add(d.flights(), (f) => Math.max(score(f.callsign || ''), score(f.icao24 || '') * 0.9), 4,
        (f) => ({ icon: '✈', title: f.callsign || f.icao24, sub: 'Vol · ' + (f.country || ''), go: () => API.openRef({ kind: 'flight', id: f.icao24 }) }));
    add(d.sats(), (s) => Math.max(score(s.name || ''), score(s.norad || '') * 0.9), 4,
        (s) => ({ icon: '🛰', title: s.name, sub: 'Satellite · NORAD ' + s.norad, go: () => API.openRef({ kind: 'sat', id: s.norad }) }));
    add(d.ships(), (s) => Math.max(score(s.name || ''), score(s.mmsi || '') * 0.9), 3,
        (s) => ({ icon: '⚓', title: s.name || s.mmsi, sub: 'Navire · MMSI ' + s.mmsi, go: () => API.openRef({ kind: 'ship', id: s.mmsi }) }));
    // Tri global stable : correspondances exactes / débutantes d'abord, quel que soit le type
    const ranked = out.map((o, i) => ({ o, i })).sort((a, b) => b.o.score - a.o.score || a.i - b.i).map((x) => x.o).slice(0, 12);
    srRender(ranked);
}
function srChoose(i) {
    const it = srItems[i];
    if (!it) return;
    $('search-results').hidden = true;
    $('search').blur();
    it.go();
}

// ================= Direct : statistiques =================
function bars(entries, color) {
    const max = Math.max(1, ...entries.map((e) => e[1]));
    return entries.map(([k, v]) => `<div class="bar-row"><span>${esc(k)}</span><span class="b"><i style="width:${(v / max * 100).toFixed(0)}%;${color ? 'background:' + color : ''}"></i></span><span class="n">${fmt(v)}</span></div>`).join('');
}
const topN = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
function link(ref, text) { return `<a data-open="${esc(ref.kind)}:${esc(ref.id)}">${esc(text)}</a>`; }

const SHIP_CATS = { cargo: 'Cargos', tanker: 'Pétroliers', passenger: 'Passagers', fishing: 'Pêche', tug: 'Remorqueurs', service: 'Service', pleasure: 'Plaisance', highspeed: 'Rapides', military: 'Militaires', other: 'Autres', unknown: 'Non renseigné' };

function renderLive() {
    const d = API.data;
    const parts = [];
    const fl = d.flights();
    if (fl.length) {
        const byC = {};
        let fast = fl[0], high = fl[0];
        for (const f of fl) {
            byC[f.country || '?'] = (byC[f.country || '?'] || 0) + 1;
            if ((f.velocity || 0) > (fast.velocity || 0)) fast = f;
            if ((f.geoAlt || 0) > (high.geoAlt || 0)) high = f;
        }
        parts.push(`<div class="stat-block"><h4>✈ Avions en vol</h4><div class="big">${fmt(fl.length)}</div>
            <div class="rec"><span>Plus rapide</span>${link({ kind: 'flight', id: fast.icao24 }, `${fast.callsign || fast.icao24} · ${fmt((fast.velocity || 0) * 3.6)} km/h`)}</div>
            <div class="rec"><span>Plus haut</span>${link({ kind: 'flight', id: high.icao24 }, `${high.callsign || high.icao24} · ${fmt(high.geoAlt)} m`)}</div>
            <h4 style="margin-top:8px">Pays d'immatriculation</h4>${bars(topN(byC, 6), '#7dd3fc')}</div>`);
    }
    const sh = d.ships();
    if (sh.length) {
        const cats = {}; let moving = 0, fast = sh[0];
        for (const s of sh) {
            cats[SHIP_CATS[s.cat] || SHIP_CATS.unknown] = (cats[SHIP_CATS[s.cat] || SHIP_CATS.unknown] || 0) + 1;
            if (s.sog > 1) moving++;
            if ((s.sog || 0) > (fast.sog || 0)) fast = s;
        }
        parts.push(`<div class="stat-block"><h4>⚓ Navires</h4><div class="big">${fmt(sh.length)}</div>
            <div class="rec"><span>En mouvement</span><span>${fmt(moving)}</span></div>
            <div class="rec"><span>Plus rapide</span>${link({ kind: 'ship', id: fast.mmsi }, `${fast.name || fast.mmsi} · ${fmt(fast.sog, 1)} nœuds`)}</div>
            ${bars(topN(cats, 6), '#fbbf24')}</div>`);
    }
    const sa = d.sats();
    if (sa.length) {
        let leo = 0, meo = 0, geo = 0;
        for (const s of sa) { if (s.altKm < 2000) leo++; else if (s.altKm < 35000) meo++; else geo++; }
        const iss = sa.find((s) => s.norad === '25544');
        parts.push(`<div class="stat-block"><h4>🛰 Satellites suivis</h4><div class="big">${fmt(sa.length)}</div>
            ${bars([['Orbite basse', leo], ['Orbite moyenne', meo], ['Géostationnaire+', geo]], '#e879f9')}
            ${iss ? `<div class="rec"><span>ISS</span>${link({ kind: 'sat', id: '25544' }, `${fmt(iss.altKm)} km · ${fmt(iss.velKmS * 3600)} km/h`)}</div>` : ''}</div>`);
    }
    const qk = d.quakes();
    if (qk.length) {
        const mx = qk.reduce((a, b) => ((b.mag || 0) > (a.mag || 0) ? b : a), qk[0]);
        const strong = qk.filter((q) => (q.mag || 0) >= 4.5).length;
        parts.push(`<div class="stat-block"><h4>🌐 Séismes</h4><div class="big">${fmt(qk.length)}</div>
            <div class="rec"><span>Plus fort</span>${link({ kind: 'quake', id: mx.id }, `M ${(mx.mag || 0).toFixed(1)} · ${(mx.place || '').slice(0, 26)}`)}</div>
            <div class="rec"><span>M ≥ 4,5</span><span>${fmt(strong)}</span></div></div>`);
    }
    const ev = d.eonet();
    if (ev.length) {
        const c = {};
        for (const e of ev) c[e.label] = (c[e.label] || 0) + 1;
        parts.push(`<div class="stat-block"><h4>🔥 Événements naturels</h4><div class="big">${fmt(ev.length)}</div>${bars(topN(c, 8), '#fb923c')}</div>`);
    }
    const we = d.weather();
    if (we.length) {
        const t = we.filter((w) => w.temp != null);
        if (t.length) {
            const hot = t.reduce((a, b) => (b.temp > a.temp ? b : a)), cold = t.reduce((a, b) => (b.temp < a.temp ? b : a));
            const windy = we.filter((w) => w.wind != null).reduce((a, b) => (b.wind > (a ? a.wind : -1) ? b : a), null);
            const aq = we.filter((w) => w.aqi != null);
            const worst = aq.length ? aq.reduce((a, b) => (b.aqi > a.aqi ? b : a)) : null;
            parts.push(`<div class="stat-block"><h4>🌡 Records parmi ${fmt(we.length)} villes</h4>
                <div class="rec"><span>Plus chaude</span>${link({ kind: 'city', id: hot.name }, `${hot.name} · ${fmt(hot.temp, 1)} °C`)}</div>
                <div class="rec"><span>Plus froide</span>${link({ kind: 'city', id: cold.name }, `${cold.name} · ${fmt(cold.temp, 1)} °C`)}</div>
                ${windy ? `<div class="rec"><span>Plus ventée</span>${link({ kind: 'city', id: windy.name }, `${windy.name} · ${fmt(windy.wind)} km/h`)}</div>` : ''}
                ${worst ? `<div class="rec"><span>Air le plus pollué</span>${link({ kind: 'city', id: worst.name }, `${worst.name} · AQI ${fmt(worst.aqi)}`)}</div>` : ''}</div>`);
        }
    }
    const kp = API.space && API.space.kp;
    if (kp && kp.latest) {
        const v = kp.latest.kp;
        const g = v >= 9 ? 'G5' : v >= 8 ? 'G4' : v >= 7 ? 'G3' : v >= 6 ? 'G2' : v >= 5 ? 'G1' : 'calme';
        parts.push(`<div class="stat-block"><h4>🌌 Activité géomagnétique</h4><div class="big">Kp ${v.toFixed(1)}</div><div class="rec"><span>Niveau de tempête</span><span>${g}</span></div>
            ${bars(kp.history.slice(-8).map((h) => [h.time.slice(11, 16) || h.time, h.kp]), '#4ade80')}</div>`);
    }
    $('live-panel').innerHTML = parts.length ? parts.join('') : '<p class="hint">Activez des couches (avions, navires, satellites, séismes…) pour voir apparaître ici les statistiques et records en direct.</p>';
}

$('live-panel').addEventListener('click', (e) => {
    const a = e.target.closest('[data-open]');
    if (!a || !API) return;
    const [kind, ...rest] = a.dataset.open.split(':');
    API.openRef({ kind, id: rest.join(':') });
});

function setTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
    if (name === 'live') renderLive();
}

// ================= Initialisation =================
const LAYER_ORDER = ['toggle-flights', 'toggle-ships', 'toggle-satellites', 'toggle-quakes', 'toggle-eonet', 'toggle-weather', 'toggle-aurora', 'toggle-daynight', 'toggle-labels', 'toggle-stats'];

export function initUI(api) {
    API = api;
    const mobile = window.innerWidth <= 860;
    if (mobile) document.body.classList.add('hide-left');
    else if (store.get('leftHidden', false)) document.body.classList.add('hide-left');

    const setLeft = (hide) => { document.body.classList.toggle('hide-left', hide); store.set('leftHidden', hide); };
    $('close-left').onclick = () => setLeft(true);
    $('open-left').onclick = () => setLeft(false);
    $('btn-layers').onclick = () => setLeft(!document.body.classList.contains('hide-left'));
    $('close-right').onclick = () => document.body.classList.add('hide-right');
    $('open-right').onclick = () => document.body.classList.remove('hide-right');
    $('btn-side').onclick = () => document.body.classList.toggle('hide-right');
    document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => setTab(t.dataset.tab); });
    setInterval(() => {
        if (!document.body.classList.contains('hide-right') && $('live-panel').classList.contains('active')) renderLive();
    }, 2500);

    // Recherche
    const input = $('search');
    input.addEventListener('input', () => srSearch(input.value));
    input.addEventListener('focus', () => srSearch(input.value));
    input.addEventListener('keydown', (e) => {
        const items = document.querySelectorAll('.sr-item');
        if (e.key === 'ArrowDown') { e.preventDefault(); srSel = Math.min(items.length - 1, srSel + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); srSel = Math.max(0, srSel - 1); }
        else if (e.key === 'Enter') { e.preventDefault(); srChoose(srSel >= 0 ? srSel : 0); return; }
        else if (e.key === 'Escape') { $('search-results').hidden = true; input.blur(); return; }
        else return;
        items.forEach((n, i) => n.classList.toggle('sel', i === srSel));
    });
    $('search-results').addEventListener('mousedown', (e) => {
        const it = e.target.closest('.sr-item');
        if (it) { e.preventDefault(); srChoose(+it.dataset.i); }
    });
    document.addEventListener('mousedown', (e) => { if (!e.target.closest('.search')) $('search-results').hidden = true; });

    // Boutons haut
    $('btn-help').onclick = () => { $('help').hidden = false; };
    $('help-close').onclick = () => { $('help').hidden = true; };
    $('help').addEventListener('click', (e) => { if (e.target.id === 'help') $('help').hidden = true; });
    $('btn-fullscreen').onclick = toggleFullscreen;
    $('btn-screenshot').onclick = () => api.screenshot();

    // Réglages : clés API (navires / avions)
    initSettings();

    // Raccourcis clavier (ignorés pendant la saisie)
    document.addEventListener('keydown', (e) => {
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === '/') { e.preventDefault(); input.focus(); input.select(); }
        else if (/^[1-9]$/.test(e.key)) { const b = $(LAYER_ORDER[+e.key - 1]); if (b) b.click(); }
        else if (e.key === '?') { $('help').hidden = !$('help').hidden; }
        else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
        else if (e.key === 'p' || e.key === 'P') api.screenshot();
        else if (e.key === 'l' || e.key === 'L') setLeft(!document.body.classList.contains('hide-left'));
        else if (e.key === 'm' || e.key === 'M') $('btn-measure').click();
        else if (e.key === 'k' || e.key === 'K') $('btn-settings').click();
        else if (e.key === 'Escape') { $('help').hidden = true; $('settings').hidden = true; }
    });

    tickClock();
    setInterval(tickClock, 1000);

    // Restauration des couches actives (après l'initialisation des modules)
    const saved = store.get('layers', null);
    const defaults = { 'toggle-daynight': true, 'toggle-labels': true };
    for (const id of LAYER_ORDER) {
        const btn = $(id);
        if (!btn) continue;
        const want = saved ? !!saved[id] : !!defaults[id];
        if (want !== btn.classList.contains('active')) btn.click();
    }
    // Sauvegarde à chaque changement de classe « active »
    const persist = () => {
        const o = {};
        for (const id of LAYER_ORDER) { const b = $(id); if (b) o[id] = b.classList.contains('active'); }
        store.set('layers', o);
    };
    const mo = new MutationObserver(persist);
    for (const id of LAYER_ORDER) { const b = $(id); if (b) mo.observe(b, { attributes: true, attributeFilter: ['class'] }); }
}

function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {});
}

// ================= Réglages : clés API (navires / avions) =================
// Chargement et envoi des clés vers le serveur local (GET/POST /api/keys).
// Les champs masqués ne sont jamais pré-remplis avec la valeur réelle : seul
// l'état « configuré » est affiché, la clé est envoyée à la sauvegarde.
async function fetchKeysState() {
    try {
        const r = await fetch('/api/keys', { cache: 'no-store' });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || 'HTTP ' + r.status);
        return j;
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

function renderKeysState(j) {
    const aisState = $('set-ais-state');
    const oscState = $('set-osc-state');
    if (!j.ok) {
        if (aisState) aisState.innerHTML = '<span class="bad">⚠ serveur injoignable — réessayez après avoir lancé lancer-mappemonde.bat</span>';
        if (oscState) oscState.innerHTML = '<span class="bad">⚠ serveur injoignable — réessayez après avoir lancé lancer-mappemonde.bat</span>';
        return;
    }
    if (aisState) {
        aisState.innerHTML = j.ais.configured
            ? `<span class="ok">✓ Clé configurée</span> <span class="key-src">${esc(j.ais.masked)}</span>`
            : '<span class="warn">⚠ Aucune clé saisie — le flux navires restera vide</span>';
    }
    if (oscState) {
        oscState.innerHTML = j.opensky.configured
            ? `<span class="ok">✓ Identifiants configurés</span> <span class="key-src">ID ${esc(j.opensky.clientIdMasked)}</span>`
            : '<span class="warn">⚠ Aucun identifiant OpenSky — quota anonyme (400 crédits/jour)</span>';
    }
}

function setMsg(ok, text) {
    const el = $('set-msg');
    if (!el) return;
    el.className = 'key-msg ' + (ok ? 'ok' : 'bad');
    el.textContent = text;
}

function initSettings() {
    const modal = $('settings');
    if (!modal) return;
    $('btn-settings').onclick = async () => {
        modal.hidden = false;
        setMsg(true, '');
        const j = await fetchKeysState();
        renderKeysState(j);
        $('set-ais-key').focus();
    };
    $('settings-close').onclick = () => { modal.hidden = true; };
    modal.addEventListener('click', (e) => { if (e.target.id === 'settings') modal.hidden = true; });

    $('set-clear-ais').onclick = () => { $('set-ais-key').value = ''; $('set-ais-key').focus(); };
    $('set-clear-osc').onclick = () => { $('set-osc-id').value = ''; $('set-osc-secret').value = ''; $('set-osc-id').focus(); };

    const submit = async (e) => {
        e && e.preventDefault();
        const btn = $('set-save');
        btn.disabled = true;
        setMsg(true, 'Enregistrement…');
        const ais = $('set-ais-key').value.trim();
        const oscId = $('set-osc-id').value.trim();
        const oscSec = $('set-osc-secret').value.trim();
        // Règle : un champ saisi est envoyé ; un champ vidé après un clic sur
        // « Retirer… » est envoyé vide (pour supprimer la clé) ; un champ jamais
        // touché n'est pas envoyé (on ne veut pas écraser une clé existante).
        const payload = {};
        if (ais || $('set-ais-key').dataset.cleared) payload.aisKey = ais;
        if (oscId || oscSec || $('set-osc-id').dataset.cleared || $('set-osc-secret').dataset.cleared) {
            payload.openSkyClientId = oscId;
            payload.openSkyClientSecret = oscSec;
        }
        delete $('set-ais-key').dataset.cleared;
        delete $('set-osc-id').dataset.cleared;
        delete $('set-osc-secret').dataset.cleared;

        try {
            const r = await fetch('/api/keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const out = await r.json();
            if (!r.ok || !out.ok) throw new Error(out.error || 'HTTP ' + r.status);
            $('set-ais-key').value = '';
            $('set-osc-id').value = '';
            $('set-osc-secret').value = '';
            const st = await fetchKeysState();
            renderKeysState(st);
            setMsg(true, out.changed ? '✓ Clés enregistrées et appliquées (le flux se met à jour automatiquement).' : 'Aucun changement (rien de neuf à enregistrer).');
        } catch (err) {
            setMsg(false, 'Erreur : ' + (err.message || err));
        } finally {
            btn.disabled = false;
        }
    };

    $('set-save').onclick = submit;
    // Marquer un champ « retiré » pour que la sauvegarde envoie explicitement
    // le vide (et supprime la clé), même sans saisie.
    $('set-clear-ais').addEventListener('click', () => { $('set-ais-key').value = ''; $('set-ais-key').dataset.cleared = '1'; });
    $('set-clear-osc').addEventListener('click', () => { $('set-osc-id').value = ''; $('set-osc-secret').value = ''; $('set-osc-id').dataset.cleared = '1'; $('set-osc-secret').dataset.cleared = '1'; });
}

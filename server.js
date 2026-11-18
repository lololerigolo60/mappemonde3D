// ---- Serveur local Mappemonde 3D ----
// Serve les fichiers statiques du dossier et fait office de proxy OpenSky
// (le navigateur ne peut pas fetcher OpenSky directement : CORS bloqué,
//  côté serveur pas de CORS).
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3456;
const ROOT = __dirname;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
};

function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

// Seuls ces fichiers sont servis : jamais .aisstream_key, .opensky_credentials.json,
// server.js, les .bat ni le dossier cache/.
const PUBLIC_FILES = new Set([
    '/index.html', '/globe.js', '/extras.js', '/ui.js', '/style.css', '/countries-data.json',
]);
function isPublic(file) {
    return PUBLIC_FILES.has(file) || /^\/data\/[\w.-]+\.json$/.test(file);
}

function serveFile(req, res, pathname) {
    let file;
    try { file = decodeURIComponent(pathname); } catch { file = ''; }
    if (file === '/' || file === '') file = '/index.html';
    if (!isPublic(file)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404');
        return;
    }
    const full = path.resolve(ROOT, '.' + file);
    if (!full.startsWith(ROOT + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('403');
        return;
    }
    fs.readFile(full, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('404 — introuvable : ' + file);
            return;
        }
        const ext = path.extname(full).toLowerCase();
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Pragma': 'no-cache',
        });
        res.end(data);
    });
}

// ---- Pont WebSocket AIS (stream.aisstream.io) ----
// Le navigateur ne peut pas ouvrir le WebSocket aisstream.io directement
// (CORS / origine refusée) : le serveur maintient la connexion persistante,
// s'abonne au flux PositionReport et expose la liste des navires via
// GET /api/ships. Aucune dépendance externe : WebSocket natif de Node.
const AIS_WS_URL = 'wss://stream.aisstream.io/v0/stream';

// ---- Clés API (modifiables à chaud via POST /api/keys) ----
// La clé AIS est re-lue à chaque connexion au flux : la changer en cours de
// session suffit (pas besoin de redémarrer le serveur). Les identifiants
// OpenSky sont gardés en mémoire et écrasent le fichier .opensky_credentials.json
// pour les prochaines sessions. Les clés sont persistées dans .api_keys.json
// (chmod 600) afin qu'elles survivent au redémarrage sans toucher les fichiers
// d'origine (.aisstream_key, .opensky_credentials.json).
function loadAisKey() {
    if (process.env.AISSTREAM_API_KEY) return process.env.AISSTREAM_API_KEY.trim();
    try {
        const f = fs.readFileSync(path.join(__dirname, '.aisstream_key'), 'utf8');
        return f.trim();
    } catch {
        return '';
    }
}

let aisKey = loadAisKey();   // mutable : POST /api/keys peut la changer à chaud
const AIS_STALE_MS = 120000; // navire sans position depuis 2 min -> retiré
const ships = new Map();     // clé MMSI (ou nom) -> dernier objet PositionReport
const shipStatic = new Map(); // MMSI -> { type, cat, destination, imo, callSign, length, draught, seen }
const AIS_STATIC_KEEP_MS = 60 * 60 * 1000;

// Code de type AIS (0-99) -> catégorie simple utilisée pour la couleur côté navigateur
function aisCategory(t) {
    if (typeof t !== 'number') return 'unknown';
    if (t === 30) return 'fishing';
    if (t >= 31 && t <= 32) return 'tug';
    if (t === 33 || t === 34) return 'service';
    if (t === 35) return 'military';
    if (t === 36 || t === 37) return 'pleasure';
    if (t >= 40 && t <= 49) return 'highspeed';
    if (t === 50 || t === 52 || t === 53) return 'tug';
    if (t === 51 || t === 54 || t === 55 || t === 58) return 'service';
    if (t >= 60 && t <= 69) return 'passenger';
    if (t >= 70 && t <= 79) return 'cargo';
    if (t >= 80 && t <= 89) return 'tanker';
    return 'other';
}

function handleAisStatic(msg) {
    const md = msg.MetaData || {};
    const sd = ((msg.Message || {}).ShipStaticData) || {};
    const mmsi = md.MMSI != null ? md.MMSI : (sd.UserID != null ? sd.UserID : null);
    if (mmsi == null) return;
    const dim = sd.Dimension || {};
    const length = (typeof dim.A === 'number' && typeof dim.B === 'number') ? dim.A + dim.B : null;
    shipStatic.set(String(mmsi), {
        type: typeof sd.Type === 'number' ? sd.Type : null,
        cat: aisCategory(sd.Type),
        destination: (sd.Destination || '').trim(),
        imo: sd.ImoNumber || null,
        callSign: (sd.CallSign || '').trim(),
        length,
        draught: typeof sd.MaximumStaticDraught === 'number' ? sd.MaximumStaticDraught : null,
        seen: Date.now(),
    });
}

function handleAisMessage(text) {
    let msg;
    try {
        msg = JSON.parse(text);
    } catch {
        return;
    }
    if (msg && msg.MessageType === 'ShipStaticData') {
        handleAisStatic(msg);
        return;
    }
    if (msg && msg.MessageType === 'PositionReport') {
        const md = msg.MetaData || {};
        // MetaData : latitude/longitude en minuscules (pas Latitude/Longitude)
        const lat = typeof md.latitude === 'number' ? md.latitude : md.Latitude;
        const lon = typeof md.longitude === 'number' ? md.longitude : md.Longitude;
        if (typeof lat !== 'number' || typeof lon !== 'number') return;
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return;
        const pr = ((msg.Message || {}).PositionReport) || {};
        const mmsi = md.MMSI != null ? md.MMSI : (pr.UserID != null ? pr.UserID : null);
        const key = String(mmsi != null ? mmsi : (md.ShipName || lat + ',' + lon));
        ships.set(key, {
            mmsi: mmsi != null ? String(mmsi) : null,
            name: (md.ShipName || '').trim(),
            lat,
            lon,
            sog: typeof pr.Sog === 'number' ? pr.Sog : null,
            cog: typeof pr.Cog === 'number' ? pr.Cog : null,
            lastSeen: Date.now(),
        });
    }
}

// Traite un texte AIS déjà converti en string : KeepAlive -> Ping, sinon PositionReport.
function onAisText(ws, text) {
    try {
        const m = JSON.parse(text);
        if (m.MessageType === 'KeepAlive') {
            aisPinging = false;
            try { ws.send(JSON.stringify({ MessageType: 'Ping' })); aisPinging = true; } catch {}
            return;
        }
    } catch {}
    handleAisMessage(text);
}

// Data du WebSocket : parfois une string, parfois un Blob (Node natif). Normalise en string (ou Promise<string>).
function wsDataToString(data) {
    if (typeof data === 'string') return data;
    if (data && typeof data.text === 'function') return data.text(); // Blob -> Promise<string>
    if (data && ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    try { return JSON.stringify(data); } catch { return ''; }
}

let aisSocket = null;          // WebSocket actuel (null = déconnecté)
let aisReconnectMs = 1000;     // délai avant la prochaine reconnexion (backoff)
let aisPinging = false;        // garde-fou anti double ping
let aisReconnecting = false;   // une seule reconnexion en cours

function sendAisPing(ws) {
    if (ws && ws.readyState === 1 && !aisPinging) {
        try { ws.send(JSON.stringify({ MessageType: 'Ping' })); aisPinging = true; } catch {}
    }
}

function connectAis() {
    if (!aisKey) return; // sans clé : on ne tente pas de se connecter
    if (aisReconnecting) return;
    if (aisSocket && (aisSocket.readyState === 0 || aisSocket.readyState === 1)) return;
    aisReconnecting = true;

    const ws = new WebSocket(AIS_WS_URL);
    aisSocket = ws;

    // Si le socket n'est pas ouvert dans les 10 s, on l'abandonne (onDead relance).
    const openTimeout = setTimeout(() => {
        if (ws.readyState === 0) { try { ws.close(); } catch {} }
    }, 10000);

    ws.addEventListener('open', () => {
        clearTimeout(openTimeout);
        aisReconnectMs = 1000; // connexion réussie -> on repart sur le backoff min
        console.log('AIS : flux stream.aisstream.io connecté');
        // Abonnement envoyé dès l'ouverture (satisfait la contrainte < 3 s)
        try {
            ws.send(JSON.stringify({
                APIKey: aisKey,
                BoundingBoxes: [[[-90, -180], [90, 180]]],
                FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
            }));
        } catch (e) {
            console.warn('AIS : échec envoi de l\'abonnement', e);
        }
    });

    ws.addEventListener('message', (ev) => {
        const maybeText = wsDataToString(ev.data);
        if (typeof maybeText === 'string') {
            onAisText(ws, maybeText);
        } else if (maybeText && typeof maybeText.then === 'function') {
            maybeText.then((t) => onAisText(ws, t)).catch(() => {});
        }
    });

    const onDead = () => {
        clearTimeout(openTimeout);
        if (ws !== aisSocket) return; // socket déjà remplacé par une nouvelle connexion
        aisSocket = null;
        aisReconnecting = false;
        const delay = aisReconnectMs;
        console.log(`AIS : flux perdu, nouvelle tentative dans ${Math.round(delay / 1000)} s`);
        aisReconnectMs = Math.min(aisReconnectMs * 2, 30000);
        setTimeout(connectAis, delay);
    };
    ws.addEventListener('close', onDead);
    ws.addEventListener('error', onDead);
}

// Keep-alive : un seul intervalle global, il ping le socket courant s'il est ouvert.
// aisstream.io coupe les connexions inactives ; un ping périodique la maintient.
setInterval(() => sendAisPing(aisSocket), 300000);

// Nettoyage périodique : on oublie les navires sans nouvelle position depuis 2 min
setInterval(() => {
    const cutoff = Date.now() - AIS_STALE_MS;
    let removed = 0;
    for (const [k, s] of ships) {
        if (s.lastSeen < cutoff) { ships.delete(k); removed++; }
    }
    if (removed) console.log(`AIS : ${removed} navire(s) expiré(s), ${ships.size} restant(s)`);
    const staticCutoff = Date.now() - AIS_STATIC_KEEP_MS;
    for (const [k, v] of shipStatic) if (v.seen < staticCutoff) shipStatic.delete(k);
}, 30000);

// ---- OpenSky OAuth2 (client_credentials) ----
// OpenSky est passé à un système de crédits (compte standard : 4 000 crédits/jour)
// et exige un token Bearer obtenu via l'endpoint Keycloak ci-dessous
// (pas opensky-network.org/api/oauth2/token, qui renvoie 403).
// Le token est chargé au démarrage, mis en cache et rafraîchi automatiquement
// avant expiration ; il est joint à chaque appel amont /api/states/all.
const OAUTH_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const OAUTH_REFRESH_MARGIN_MS = 120000; // rafraîchir 2 min avant l'expiration

function loadOpenSkyCredentials() {
    const candidats = [
        path.join(__dirname, '.opensky_credentials.json'),
        'I:\\download\\credentials.json',
    ];
    for (const f of candidats) {
        try {
            const j = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (j.clientId && j.clientSecret) return { clientId: j.clientId, clientSecret: j.clientSecret };
        } catch {}
    }
    return null;
}

let OPENSKY_CREDS = loadOpenSkyCredentials(); // mutable : POST /api/keys peut les changer à chaud
let openSkyToken = null;              // { accessToken, expiresAt }
let openSkyTokenInflight = null;      // un seul échange de token à la fois

async function getOpenSkyToken() {
    if (openSkyToken && Date.now() < openSkyToken.expiresAt - OAUTH_REFRESH_MARGIN_MS) {
        return openSkyToken.accessToken;
    }
    if (openSkyTokenInflight) return openSkyTokenInflight;
    const p = (async () => {
        const body = 'grant_type=client_credentials' +
            '&client_id=' + encodeURIComponent(OPENSKY_CREDS.clientId) +
            '&client_secret=' + encodeURIComponent(OPENSKY_CREDS.clientSecret);
        const r = await fetch(OAUTH_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'mappemonde-3d/1.0' },
            body,
        });
        if (!r.ok) {
            const err = new Error('OpenSky token HTTP ' + r.status);
            err.httpStatus = r.status;
            throw err;
        }
        const j = await r.json();
        openSkyToken = {
            accessToken: j.access_token,
            expiresAt: Date.now() + (j.expires_in || 1800) * 1000,
        };
        console.log('OpenSky : token OAuth2 obtenu, expire dans ' + (j.expires_in || 1800) + ' s');
        return openSkyToken.accessToken;
    })().finally(() => { openSkyTokenInflight = null; });
    openSkyTokenInflight = p;
    return p;
}

// ---- Proxy OpenSky ----
// Renvoie la liste des avions en vol, transformée en objets simples.
// Avec le token OAuth2 le quota passe de 400 à 4 000 crédits/jour ; on met
// quand même en cache le dernier bon résultat et on le sert "stale" en cas
// d'erreur/429, plutôt que de renvoyer une erreur au navigateur.
let flightsCache = null; // { fetchedAt, flights }
const FLIGHTS_STALE_OK_MS = 10 * 60 * 1000; // un cache de < 10 min est encore utile
// Après un 429, on cesse de taper OpenSky pendant ce délai (on "laisse reposer"
// le quota) et on renvoie l'erreur/cached sans requête amont.
let flightsCooldownUntil = 0;
const FLIGHTS_COOLDOWN_MS = 5 * 60 * 1000;

function flightsPayload(j) {
    const states = (j && j.states) || [];
    const flights = states
        .map((s) => ({
            icao24: s[0],
            callsign: (s[1] || '').trim(),
            country: s[2] || '',
            lon: s[5],
            lat: s[6],
            onGround: !!s[8],
            velocity: s[9] ?? null,
            track: s[10] ?? null,
            geoAlt: s[13] ?? s[7] ?? null, // altitude (m)
            timePosition: s[3] || null,
            lastContact: s[4] || null,
        }))
        // Ne garder que les avions en vol avec une position valide
        .filter((f) =>
            typeof f.lat === 'number' &&
            typeof f.lon === 'number' &&
            !isNaN(f.lat) && !isNaN(f.lon) &&
            f.lat >= -90 && f.lat <= 90 &&
            !f.onGround
        );
    return flights;
}

let flightsInflight = null;

// Une seule requête OpenSky à la fois : les appels simultanés (plusieurs onglets)
// partagent le même fetch in-flight, pour préserver le quota rate-limité.
async function fetchFlightsUpstream() {
    if (flightsInflight) return flightsInflight;
    const upstream =
        'https://opensky-network.org/api/states/all' +
        '?lamin=-90&lomin=-180&lamax=90&lomax=180';
    const p = (async () => {
        const headers = { 'Accept': 'application/json', 'User-Agent': 'mappemonde-3d/1.0' };
        if (OPENSKY_CREDS) {
            try {
                headers['Authorization'] = 'Bearer ' + (await getOpenSkyToken());
            } catch (e) {
                console.warn('OpenSky : token indisponible (' + (e.message || e) + ') — essai sans auth');
            }
        }
        const r = await fetch(upstream, { headers });
        if (!r.ok) {
            if (r.status === 429) flightsCooldownUntil = Date.now() + FLIGHTS_COOLDOWN_MS;
            const err = new Error('OpenSky HTTP ' + r.status);
            err.httpStatus = r.status;
            throw err;
        }
        const j = await r.json();
        flightsCache = { fetchedAt: Date.now(), flights: flightsPayload(j) };
        return flightsCache;
    })().finally(() => { flightsInflight = null; });
    flightsInflight = p;
    return p;
}

async function handleFlights(res) {
    const now = Date.now();
    const cacheUsable = () =>
        flightsCache && now - flightsCache.fetchedAt < FLIGHTS_STALE_OK_MS;

    // Refroidissement : on ne retente pas OpenSky pendant le délai suivant un 429,
    // pour ne pas briser le quota encore plus vite. On sert le cache s'il existe.
    if (now < flightsCooldownUntil) {
        if (cacheUsable()) {
            sendJson(res, 200, {
                ok: true,
                stale: true,
                source: 'opensky-network.org (cache, en refroidissement ' +
                    Math.ceil((flightsCooldownUntil - now) / 60000) + ' min)',
                count: flightsCache.flights.length,
                fetchedAt: new Date(flightsCache.fetchedAt).toISOString(),
                flights: flightsCache.flights,
            });
        } else {
            sendJson(res, 429, {
                ok: false,
                rateLimited: true,
                retryInSec: Math.ceil((flightsCooldownUntil - now) / 1000),
                error: 'OpenSky en refroidissement après saturation (429). Réessayez dans ' +
                    Math.ceil((flightsCooldownUntil - now) / 60000) + ' min.',
            });
        }
        return;
    }

    try {
        const cache = await fetchFlightsUpstream();
        sendJson(res, 200, {
            ok: true,
            source: 'opensky-network.org',
            count: cache.flights.length,
            fetchedAt: new Date(cache.fetchedAt).toISOString(),
            flights: cache.flights,
        });
    } catch (e) {
        const httpStatus = e && e.httpStatus;
        const rateLimited = httpStatus === 429;
        // Amont en erreur (429 rate-limit, 5xx) ou réseau coupé :
        // servir le cache s'il est récent, sinon une erreur propre et lisible.
        if (cacheUsable()) {
            sendJson(res, 200, {
                ok: true,
                stale: true,
                source: 'opensky-network.org (cache, amont ' + (httpStatus || 'erreur réseau') + ')',
                count: flightsCache.flights.length,
                fetchedAt: new Date(flightsCache.fetchedAt).toISOString(),
                flights: flightsCache.flights,
            });
        } else {
            sendJson(res, rateLimited ? 429 : 502, {
                ok: false,
                rateLimited,
                error: rateLimited
                    ? 'OpenSky a saturé le débit (HTTP 429). Réessayez dans quelques minutes.'
                    : String(e && e.message || e),
            });
        }
    }
}

// ---- Proxy CelesTrak TLE (satellites) ----
// Les positions satellites sont calculées côté navigateur (SGP4 via satellite.js)
// à partir des éphémérides TLE ; le serveur ne fait que récupérer le catalogue
// (CORS) et le met en cache 1 h — les TLE sont mises à jour quotidiennement
// par CelesTrak, un cache plus vieux reste utilisable (stale).
const SAT_GROUPS = new Set(['active','stations','visual','weather','gps-ops','galileo','glo-ops','beidou','starlink','oneweb','geo','science']);
const tleUrl = (g) => 'https://celestrak.org/NORAD/elements/gp.php?GROUP=' + g + '&FORMAT=tle';
const TLE_FRESH_MS = 60 * 60 * 1000;   // 1 h : au-delà, on retente amont
const TLE_STALE_OK_MS = 12 * 60 * 60 * 1000; // un cache de < 12 h est encore utile
const tleCaches = new Map();   // groupe -> { fetchedAt, text }
const tleInflights = new Map();

async function fetchTleUpstream(group) {
    if (tleInflights.has(group)) return tleInflights.get(group);
    const p = (async () => {
        const r = await fetchTimeout(tleUrl(group), { headers: { 'Accept': 'text/plain' } }, 20000);
        if (!r.ok) {
            const err = new Error('CelesTrak HTTP ' + r.status);
            err.httpStatus = r.status;
            throw err;
        }
        const text = await r.text();
        if (!text || text.length < 100) throw new Error('réponse CelesTrak inattendue');
        const c = { fetchedAt: Date.now(), text };
        tleCaches.set(group, c);
        console.log(`TLE : groupe ${group} téléchargé (${text.split('\n').length} lignes)`);
        return c;
    })().finally(() => { tleInflights.delete(group); });
    tleInflights.set(group, p);
    return p;
}

async function handleSatellites(res, group) {
    if (!SAT_GROUPS.has(group)) group = 'active';
    const now = Date.now();
    const cached = tleCaches.get(group);
    const out = (c, stale) => sendJson(res, 200, {
        ok: true, stale: !!stale, group,
        source: 'celestrak.org' + (stale ? ' (cache)' : ''),
        fetchedAt: new Date(c.fetchedAt).toISOString(), tle: c.text,
    });
    if (cached && now - cached.fetchedAt < TLE_FRESH_MS) return out(cached, false);
    try {
        out(await fetchTleUpstream(group), false);
    } catch (e) {
        if (cached && now - cached.fetchedAt < TLE_STALE_OK_MS) out(cached, true);
        else sendJson(res, 502, { ok: false, error: String(e && e.message || e) });
    }
}

// ---- Utilitaires proxys ----
function fetchTimeout(url, opts = {}, ms = 20000) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    return fetch(url, {
        ...opts,
        signal: c.signal,
        headers: { 'User-Agent': 'mappemonde-3d/2.0', ...(opts.headers || {}) },
    }).finally(() => clearTimeout(t));
}

const CACHE_DIR = path.join(ROOT, 'cache');
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}

// Flux JSON mis en cache : ttl = fraîcheur, staleMs = durée pendant laquelle un vieux cache reste servi si l'amont tombe
function makeFeed(fetcher, ttlMs, staleMs) {
    let cache = null, inflight = null;
    return function get() {
        const now = Date.now();
        if (cache && now - cache.at < ttlMs) return Promise.resolve({ at: cache.at, data: cache.data, stale: false });
        if (inflight) return inflight;
        inflight = fetcher().then((data) => {
            cache = { at: Date.now(), data };
            return { at: cache.at, data, stale: false };
        }).catch((e) => {
            if (cache && Date.now() - cache.at < staleMs) return { at: cache.at, data: cache.data, stale: true };
            throw e;
        }).finally(() => { inflight = null; });
        return inflight;
    };
}

// code = code HTTP renvoye en cas d'echec (502 par defaut, 503 si l'amont est
// simplement indisponible — ex. API Banque mondiale hors ligne).
async function feedJson(res, getter, extra, code) {
    const errCode = code || 502;
    try {
        const r = await getter();
        sendJson(res, 200, { ok: true, stale: r.stale, fetchedAt: new Date(r.at).toISOString(), ...(extra || {}), data: r.data });
    } catch (e) {
        sendJson(res, errCode, { ok: false, error: String(e && e.message || e) });
    }
}

async function getJson(url, ms) {
    const r = await fetchTimeout(url, { headers: { 'Accept': 'application/json' } }, ms || 20000);
    if (!r.ok) throw new Error('HTTP ' + r.status + ' (' + new URL(url).host + ')');
    return r.json();
}

// ---- Météo spatiale NOAA SWPC : aurores (OVATION) + indice Kp ----
const getSpaceWeather = makeFeed(async () => {
    const [ra, rk] = await Promise.allSettled([
        getJson('https://services.swpc.noaa.gov/json/ovation_aurora_latest.json', 30000),
        getJson('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json', 20000),
    ]);
    const out = {};
    if (ra.status === 'fulfilled') {
        const j = ra.value || {};
        const coords = Array.isArray(j.coordinates) ? j.coordinates : [];
        const pts = [];
        for (const c of coords) {
            if (Array.isArray(c) && c.length >= 3 && c[2] >= 3) pts.push([c[0], c[1], c[2]]);
        }
        out.aurora = { observation: j['Observation Time'] || null, forecast: j['Forecast Time'] || null, points: pts };
    }
    if (rk.status === 'fulfilled' && Array.isArray(rk.value)) {
        const rows = rk.value;
        const data = [];
        for (const r of rows) {
            if (Array.isArray(r)) {
                const kp = parseFloat(r[1]);
                if (isFinite(kp) && r[0] !== 'time_tag') data.push({ time: r[0], kp });
            } else if (r && typeof r === 'object') {
                const kp = parseFloat(r.Kp ?? r.kp_index ?? r.estimated_kp);
                if (isFinite(kp)) data.push({ time: r.time_tag, kp });
            }
        }
        out.kp = { latest: data[data.length - 1] || null, history: data.slice(-24) };
    }
    if (!out.aurora && !out.kp) throw new Error('NOAA SWPC indisponible');
    return out;
}, 5 * 60 * 1000, 3 * 3600 * 1000);

// ---- REST Countries (2 requêtes car « fields » est limité à 10 champs) ----
const getCountries = makeFeed(async () => {
    const base = 'https://restcountries.com/v3.1/all?fields=';
    const [a, b] = await Promise.all([
        getJson(base + 'cca3,cca2,name,translations,capital,capitalInfo,population,area,flags,borders', 30000),
        getJson(base + 'cca3,languages,currencies,region,subregion,timezones,tld,idd,car,continents', 30000),
    ]);
    const extra = new Map(b.map((x) => [x.cca3, x]));
    const list = a.map((x) => {
        const e = extra.get(x.cca3) || {};
        return {
            cca2: x.cca2, cca3: x.cca3,
            common: x.name && x.name.common, official: x.name && x.name.official,
            fra: x.translations && x.translations.fra ? [x.translations.fra.common, x.translations.fra.official] : [],
            capital: (x.capital || [])[0] || '',
            capitalLatLng: x.capitalInfo && x.capitalInfo.latlng || null,
            population: x.population, area: x.area,
            flag: x.flags && (x.flags.svg || x.flags.png) || '',
            borders: x.borders || [],
            languages: e.languages ? Object.values(e.languages) : [],
            currencies: e.currencies ? Object.values(e.currencies).map((c) => (c.name || '') + (c.symbol ? ' (' + c.symbol + ')' : '')) : [],
            region: e.region || '', subregion: e.subregion || '',
            timezones: e.timezones || [], tld: (e.tld || [])[0] || '',
            idd: e.idd && e.idd.root ? e.idd.root + ((e.idd.suffixes || []).length === 1 ? e.idd.suffixes[0] : '') : '',
            drives: e.car && e.car.side || '',
        };
    });
    if (list.length < 100) throw new Error('REST Countries : réponse incomplète');
    try { fs.writeFileSync(path.join(CACHE_DIR, 'countries.json'), JSON.stringify(list)); } catch {}
    return list;
}, 7 * 24 * 3600 * 1000, 365 * 24 * 3600 * 1000);

// ---- Statistiques par pays (Banque mondiale, v2, sans cle) ----
// Catalogue = source unique de verite (libelle FR, unite, id WB).
const STAT_CATALOG = [
    { cat: "1. Économie, croissance, production", id: "NY.GDP.MKTP.CD", label: "PIB", unit: "G$ USD" },
    { cat: "1. Économie, croissance, production", id: "NY.GDP.MKTP.KD", label: "PIB (US$ constants 2015)", unit: "G$ USD" },
    { cat: "1. Économie, croissance, production", id: "NY.GDP.MKTP.PP.CD", label: "PIB PPA (intl $ courants)", unit: "G$ intl" },
    { cat: "1. Économie, croissance, production", id: "NY.GDP.MKTP.KD.ZG", label: "Croissance du PIB (annuelle)", unit: "%" },
    { cat: "1. Économie, croissance, production", id: "NY.GDP.PCAP.CD", label: "PIB par habitant", unit: "USD" },
    { cat: "1. Économie, croissance, production", id: "NY.GDP.PCAP.KD", label: "PIB par habitant (US$ constants 2015)", unit: "USD" },
    { cat: "1. Économie, croissance, production", id: "NY.GDP.PCAP.PP.CD", label: "PIB par habitant PPA (intl $)", unit: "intl $" },
    { cat: "1. Économie, croissance, production", id: "NY.GDP.PCAP.KD.ZG", label: "Croissance PIB/hab. (annuelle)", unit: "%" },
    { cat: "1. Économie, croissance, production", id: "NY.GNP.PCAP.CD", label: "RNB par habitant (méthode Atlas)", unit: "USD" },
    { cat: "1. Économie, croissance, production", id: "NV.AGR.TOTL.ZS", label: "Valeur ajoutée agriculture", unit: "% PIB" },
    { cat: "1. Économie, croissance, production", id: "NV.IND.TOTL.ZS", label: "Valeur ajoutée industrie", unit: "% PIB" },
    { cat: "1. Économie, croissance, production", id: "NV.IND.MANF.ZS", label: "Valeur ajoutée manufacturière", unit: "% PIB" },
    { cat: "1. Économie, croissance, production", id: "NV.SRV.TOTL.ZS", label: "Valeur ajoutée services", unit: "% PIB" },
    { cat: "1. Économie, croissance, production", id: "NE.GDI.FTOT.ZS", label: "Formation brute de capital fixe", unit: "% PIB" },
    { cat: "1. Économie, croissance, production", id: "NY.GDS.TOTL.ZS", label: "Épargne intérieure brute", unit: "% PIB" },
    { cat: "2. Finances, monnaie, prix", id: "FP.CPI.TOTL.ZG", label: "Inflation (IPC, annuelle)", unit: "%" },
    { cat: "2. Finances, monnaie, prix", id: "NY.GDP.DEFL.KD.ZG", label: "Inflation (déflateur du PIB)", unit: "%" },
    { cat: "2. Finances, monnaie, prix", id: "GC.DOD.TOTL.GD.ZS", label: "Dette publique centrale", unit: "% PIB" },
    { cat: "2. Finances, monnaie, prix", id: "GC.TAX.TOTL.GD.ZS", label: "Recettes fiscales", unit: "% PIB" },
    { cat: "2. Finances, monnaie, prix", id: "GC.XPN.TOTL.GD.ZS", label: "Dépenses publiques", unit: "% PIB" },
    { cat: "2. Finances, monnaie, prix", id: "GC.NLD.TOTL.GD.ZS", label: "Solde budgétaire (prêt net)", unit: "% PIB" },
    { cat: "2. Finances, monnaie, prix", id: "MS.MIL.XPND.GD.ZS", label: "Dépenses militaires", unit: "% PIB" },
    { cat: "2. Finances, monnaie, prix", id: "FR.INR.RINR", label: "Taux d'intérêt réel", unit: "%" },
    { cat: "2. Finances, monnaie, prix", id: "FR.INR.LEND", label: "Taux d'intérêt débiteur", unit: "%" },
    { cat: "2. Finances, monnaie, prix", id: "FS.AST.PRVT.GD.ZS", label: "Crédit secteur privé (intérieur)", unit: "% PIB" },
    { cat: "2. Finances, monnaie, prix", id: "CM.MKT.LCAP.GD.ZS", label: "Capitalisation boursière", unit: "% PIB" },
    { cat: "2. Finances, monnaie, prix", id: "PA.NUS.FCRF", label: "Taux de change officiel (LCU/$ US)", unit: "LCU/$" },
    { cat: "3. Commerce, dette, flux financiers", id: "NE.EXP.GNFS.ZS", label: "Exportations de biens et services", unit: "% PIB" },
    { cat: "3. Commerce, dette, flux financiers", id: "NE.IMP.GNFS.ZS", label: "Importations de biens et services", unit: "% PIB" },
    { cat: "3. Commerce, dette, flux financiers", id: "NE.TRD.GNFS.ZS", label: "Ouverture commerciale (commerce)", unit: "% PIB" },
    { cat: "3. Commerce, dette, flux financiers", id: "BN.CAB.XOKA.GD.ZS", label: "Solde du compte courant", unit: "% PIB" },
    { cat: "3. Commerce, dette, flux financiers", id: "BX.KLT.DINV.WD.GD.ZS", label: "IDE entrées nettes", unit: "% PIB" },
    { cat: "3. Commerce, dette, flux financiers", id: "BX.KLT.DINV.CD.WD", label: "IDE entrées nettes (en $ US)", unit: "M$ USD" },
    { cat: "3. Commerce, dette, flux financiers", id: "BX.TRF.PWKR.DT.GD.ZS", label: "Envois de fonds des migrants", unit: "% PIB" },
    { cat: "3. Commerce, dette, flux financiers", id: "FI.RES.TOTL.CD", label: "Réserves internationales totales", unit: "M$ USD" },
    { cat: "3. Commerce, dette, flux financiers", id: "FI.RES.TOTL.MO", label: "Réserves (mois d'importations)", unit: "mois" },
    { cat: "3. Commerce, dette, flux financiers", id: "DT.DOD.DECT.GN.ZS", label: "Dette extérieure (encours)", unit: "% RNB" },
    { cat: "3. Commerce, dette, flux financiers", id: "DT.TDS.DECT.EX.ZS", label: "Service de la dette extérieure", unit: "% exports" },
    { cat: "3. Commerce, dette, flux financiers", id: "DT.ODA.ODAT.GN.ZS", label: "APD nette reçue", unit: "% RNB" },
    { cat: "3. Commerce, dette, flux financiers", id: "LP.LPI.OVRL.XQ", label: "Indice de performance logistique", unit: "/5" },
    { cat: "4. Démographie, urbanisation", id: "SP.POP.TOTL", label: "Population totale", unit: "hab." },
    { cat: "4. Démographie, urbanisation", id: "SP.POP.GROW", label: "Croissance démographique", unit: "%" },
    { cat: "4. Démographie, urbanisation", id: "EN.POP.DNST", label: "Densité de population", unit: "hab./km²" },
    { cat: "4. Démographie, urbanisation", id: "SP.POP.0014.TO.ZS", label: "Population 0-14 ans", unit: "%" },
    { cat: "4. Démographie, urbanisation", id: "SP.POP.1564.TO.ZS", label: "Population 15-64 ans", unit: "%" },
    { cat: "4. Démographie, urbanisation", id: "SP.POP.65UP.TO.ZS", label: "Population 65 ans et plus", unit: "%" },
    { cat: "4. Démographie, urbanisation", id: "SP.POP.DPND", label: "Ratio de dépendance démographique", unit: "% actifs" },
    { cat: "4. Démographie, urbanisation", id: "SP.URB.TOTL.IN.ZS", label: "Population urbaine", unit: "%" },
    { cat: "4. Démographie, urbanisation", id: "SP.URB.GROW", label: "Croissance population urbaine", unit: "%" },
    { cat: "4. Démographie, urbanisation", id: "SM.POP.NETM", label: "Migration nette", unit: "hab." },
    { cat: "5. Emploi, pauvreté, inégalités", id: "SL.UEM.TOTL.ZS", label: "Taux de chômage", unit: "%" },
    { cat: "5. Emploi, pauvreté, inégalités", id: "SL.UEM.1524.ZS", label: "Chômage jeunes (15-24 ans)", unit: "%" },
    { cat: "5. Emploi, pauvreté, inégalités", id: "SL.TLF.CACT.ZS", label: "Taux d'activité totale", unit: "%" },
    { cat: "5. Emploi, pauvreté, inégalités", id: "SL.TLF.CACT.FE.ZS", label: "Taux d'activité des femmes", unit: "%" },
    { cat: "5. Emploi, pauvreté, inégalités", id: "SL.TLF.TOTL.IN", label: "Population active totale", unit: "hab." },
    { cat: "5. Emploi, pauvreté, inégalités", id: "SL.AGR.EMPL.ZS", label: "Emploi dans l'agriculture", unit: "% emploi" },
    { cat: "5. Emploi, pauvreté, inégalités", id: "SL.IND.EMPL.ZS", label: "Emploi dans l'industrie", unit: "% emploi" },
    { cat: "5. Emploi, pauvreté, inégalités", id: "SL.SRV.EMPL.ZS", label: "Emploi dans les services", unit: "% emploi" },
    { cat: "5. Emploi, pauvreté, inégalités", id: "SI.POV.GINI", label: "Indice de Gini", unit: "indice" },
    { cat: "5. Emploi, pauvreté, inégalités", id: "SI.POV.DDAY", label: "Pauvreté à 2,15 $/j (PPA 2017)", unit: "%" },
    { cat: "5. Emploi, pauvreté, inégalités", id: "SI.POV.NAHC", label: "Pauvreté au seuil national", unit: "%" },
    { cat: "5. Emploi, pauvreté, inégalités", id: "SI.DST.10TH.10", label: "Revenus détenus par les 10% les plus riches", unit: "%" },
    { cat: "6. Santé, nutrition", id: "SP.DYN.LE00.IN", label: "Espérance de vie à la naissance", unit: "ans" },
    { cat: "6. Santé, nutrition", id: "SP.DYN.TFRT.IN", label: "Indice de fécondité", unit: "/femme" },
    { cat: "6. Santé, nutrition", id: "SP.DYN.IMRT.IN", label: "Mortalité infantile", unit: "/1000 nv" },
    { cat: "6. Santé, nutrition", id: "SH.DYN.MORT", label: "Mortalité des moins de 5 ans", unit: "/1000 nv" },
    { cat: "6. Santé, nutrition", id: "SH.STA.MMRT", label: "Ratio de mortalité maternelle", unit: "/100000 nv" },
    { cat: "6. Santé, nutrition", id: "SH.XPD.CHEX.GD.ZS", label: "Dépenses courantes de santé", unit: "% PIB" },
    { cat: "6. Santé, nutrition", id: "SH.XPD.CHEX.PC.CD", label: "Dépenses de santé par habitant", unit: "USD" },
    { cat: "6. Santé, nutrition", id: "SH.MED.BEDS.ZS", label: "Lits d'hôpital", unit: "/1000 hab." },
    { cat: "6. Santé, nutrition", id: "SH.MED.PHYS.ZS", label: "Médecins", unit: "/1000 hab." },
    { cat: "6. Santé, nutrition", id: "SN.ITK.DEFC.ZS", label: "Sous-alimentation", unit: "%" },
    { cat: "7. Éducation, genre, innovation", id: "SE.ADT.LITR.ZS", label: "Alphabétisation des adultes", unit: "%" },
    { cat: "7. Éducation, genre, innovation", id: "SE.PRM.ENRR", label: "Scolarisation primaire (brute)", unit: "%" },
    { cat: "7. Éducation, genre, innovation", id: "SE.SEC.ENRR", label: "Scolarisation secondaire (brute)", unit: "%" },
    { cat: "7. Éducation, genre, innovation", id: "SE.TER.ENRR", label: "Scolarisation supérieure (brute)", unit: "%" },
    { cat: "7. Éducation, genre, innovation", id: "SE.PRM.CMPT.ZS", label: "Taux d'achèvement du primaire", unit: "%" },
    { cat: "7. Éducation, genre, innovation", id: "SE.XPD.TOTL.GD.ZS", label: "Dépenses publiques d'éducation", unit: "% PIB" },
    { cat: "7. Éducation, genre, innovation", id: "SG.GEN.PARL.ZS", label: "Femmes au parlement", unit: "%" },
    { cat: "7. Éducation, genre, innovation", id: "GB.XPD.RSDV.GD.ZS", label: "Dépenses R&D", unit: "% PIB" },
    { cat: "7. Éducation, genre, innovation", id: "SP.POP.SCIE.RD.P6", label: "Chercheurs en R&D", unit: "/M hab." },
    { cat: "7. Éducation, genre, innovation", id: "IP.PAT.RESD", label: "Demandes de brevets (résidents)", unit: "brevets" },
    { cat: "8. Climat, énergie, environnement", id: "EG.ELC.ACCS.ZS", label: "Accès à l'électricité", unit: "%" },
    { cat: "8. Climat, énergie, environnement", id: "EG.FEC.RNEW.ZS", label: "Énergie renouvelable", unit: "%" },
    { cat: "8. Climat, énergie, environnement", id: "EG.USE.PCAP.KG.OE", label: "Consommation d'énergie par habitant", unit: "kg eq. pétrole" },
    { cat: "8. Climat, énergie, environnement", id: "EG.IMP.CONS.ZS", label: "Importations nettes d'énergie", unit: "%" },
    { cat: "8. Climat, énergie, environnement", id: "EN.GHG.ALL.MT.CE.AR5", label: "Émissions de gaz à effet de serre", unit: "Mt CO2eq" },
    { cat: "8. Climat, énergie, environnement", id: "EN.ATM.CO2E.PC", label: "Émissions de CO2 par habitant", unit: "t" },
    { cat: "8. Climat, énergie, environnement", id: "EN.ATM.PM25.MC.M3", label: "Exposition annuelle PM2.5", unit: "µg/m³" },
    { cat: "8. Climat, énergie, environnement", id: "AG.LND.FRST.ZS", label: "Superficie forestière", unit: "%" },
    { cat: "8. Climat, énergie, environnement", id: "AG.LND.ARBL.ZS", label: "Terres arables", unit: "%" },
    { cat: "8. Climat, énergie, environnement", id: "SH.H2O.SMDW.ZS", label: "Eau potable gérée en toute sécurité", unit: "%" },
    { cat: "9. Numérique, gouvernance", id: "IT.NET.USER.ZS", label: "Utilisateurs Internet", unit: "%" },
    { cat: "9. Numérique, gouvernance", id: "IT.CEL.SETS.P2", label: "Abonnements téléphonie mobile", unit: "/100 hab." },
    { cat: "9. Numérique, gouvernance", id: "IT.NET.BBND.P2", label: "Abonnements haut débit fixe", unit: "/100 hab." },
    { cat: "9. Numérique, gouvernance", id: "TX.VAL.TECH.MF.ZS", label: "Exportations de haute technologie", unit: "% exports manuf." },
    { cat: "9. Numérique, gouvernance", id: "CC.EST", label: "Contrôle de la corruption (WGI)", unit: "score WGI" },
    { cat: "9. Numérique, gouvernance", id: "GE.EST", label: "Efficacité des pouvoirs publics (WGI)", unit: "score WGI" },
    { cat: "9. Numérique, gouvernance", id: "RL.EST", label: "État de droit (WGI)", unit: "score WGI" },
    { cat: "9. Numérique, gouvernance", id: "PV.EST", label: "Stabilité politique (WGI)", unit: "score WGI" },
];
const WB_BASE = 'https://api.worldbank.org/v2/country/all/indicator/';

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function wbFetchJson(id, date) {
    // Un fetch avec Accept-JSON, renvoie le tableau de donnees (j[1]) ou null si
    // reponse d'erreur WB (ex. code 120 "Invalid value" = pas de donnee pour cette annee).
    const j = await getJson(WB_BASE + id + '?date=' + date + '&format=json&per_page=600', 30000);
    if (Array.isArray(j) && j[0] && j[0].message) return null; // erreur WB en JSON (HTTP 200)
    if (Array.isArray(j) && Array.isArray(j[1])) return j[1];
    if (Array.isArray(j && j.data)) return j.data;
    return null;
}

async function wbLatestYear(id) {
    // L'API WB derriere CDN est intermittente : on relance chaque annee (retry/backoff)
    // avant de passer au repli. Ordre : 2025 (3 tentatives), puis plage 2025:2022 (3 tentatives).
    // Reponse WB v2 : [ {meta}, [ { countryiso3code, date, value, ... } ] ] ; value en string -> parseFloat.
    const years = ['2025', '2025:2020'];
    for (const date of years) {
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const arr = await wbFetchJson(id, date);
                if (!arr || !arr.length) continue; // annee vide (erreur 120) ou reponse inattendue
                const values = {};
                const names = {}; // iso3 -> nom pays (WB country.value)
                let year = null, count = 0;
                for (const r of arr) {
                    if (!r) continue;
                    const iso3 = r.countryiso3code;
                    if (!iso3) continue;
                    const raw = r.value;
                    if (raw == null || raw === '') continue;
                    const v = typeof raw === 'number' ? raw : parseFloat(raw);
                    if (!isFinite(v)) continue;
                    values[iso3] = v;
                    count++;
                    const cname = r.country && r.country.value;
                    if (cname && !names[iso3]) names[iso3] = cname;
                    const y = parseInt(String(r.date), 10);
                    if (isFinite(y) && (year == null || y > year)) year = y;
                }
                if (count >= 5 && year) return { year, values, names };
            } catch { /* network/HTTP/timeout : on retente (backoff) */ }
            if (attempt < 3) await sleep(1000 * attempt); // 1s puis 2s
        }
    }
    throw new Error('API Banque mondiale indisponible');
}
const getStatsCatalog = makeFeed(async () => STAT_CATALOG.map(({ id, label, unit, cat }) => ({ id, label, unit, cat })), 24 * 3600 * 1000, 24 * 3600 * 1000);
// Liste officielle des pays WB (id = code ISO3, name = nom officiel EN) — source de
// correspondance nom->ISO3 independante de REST Countries (deprecie).
const getStatsCountries = makeFeed(async () => {
    const j = await getJson('https://api.worldbank.org/v2/country?format=json&per_page=300', 30000);
    const list = Array.isArray(j) && Array.isArray(j[1]) ? j[1] : [];
    const out = [];
    for (const c of list) if (c && c.id && c.name) out.push({ iso3: c.id, name: c.name });
    if (out.length < 150) throw new Error('Banque mondiale : liste de pays incomplete');
    return out;
}, 24 * 3600 * 1000, 365 * 24 * 3600 * 1000);
// Un cache par indicateur (faible cout : ~100 indicateurs max)
const statsFeeds = new Map();
function getStats(indicator) {
    if (!statsFeeds.has(indicator)) {
        statsFeeds.set(indicator, makeFeed(async () => {
            const cat = (STAT_CATALOG.find((c) => c.id === indicator) || {});
            const { year, values, names } = await wbLatestYear(indicator);
            return { indicator, label: cat.label || '', unit: cat.unit || '', year, values, names };
        }, 7 * 24 * 3600 * 1000, 365 * 24 * 3600 * 1000));
    }
    return statsFeeds.get(indicator);
}

// ---- Équipage ISS / Tiangong (Open Notify) ----
const getCrew = makeFeed(async () => {
    const j = await getJson('http://api.open-notify.org/astros.json', 10000);
    return { number: j.number || 0, people: j.people || [] };
}, 3600 * 1000, 7 * 24 * 3600 * 1000);

// ---- Imagerie NASA GIBS (WMS EPSG:4326, planisphère entier) ----
// Les images sont mises en cache sur disque (dossier cache/) : une seule requête par couche/date/taille.
const GIBS_LAYERS = {
    BlueMarble_ShadedRelief_Bathymetry: { fmt: 'jpeg', time: false },
    MODIS_Terra_CorrectedReflectance_TrueColor: { fmt: 'jpeg', time: 'day' },
    VIIRS_SNPP_CorrectedReflectance_TrueColor: { fmt: 'jpeg', time: 'day' },
    VIIRS_Black_Marble: { fmt: 'jpeg', time: false },
    IMERG_Precipitation_Rate: { fmt: 'png', time: 'dt' },
    MODIS_Terra_Cloud_Optical_Thickness: { fmt: 'png', time: 'day' },
    VIIRS_SNPP_Cloud_Optical_Thickness: { fmt: 'png', time: 'day' },
    GHRSST_L4_MUR_Sea_Surface_Temperature: { fmt: 'png', time: 'day' },
    MODIS_Terra_Aerosol: { fmt: 'png', time: 'day' },
    MODIS_Terra_NDSI_Snow_Cover: { fmt: 'png', time: 'day' },
};
const gibsInflight = new Map();

async function handleGibs(res, q) {
    const layer = q.get('layer') || '';
    const def = GIBS_LAYERS[layer];
    if (!def) return sendJson(res, 400, { ok: false, error: 'couche GIBS inconnue' });
    const w = [1024, 2048, 4096].includes(+q.get('w')) ? +q.get('w') : 2048;
    const h = w / 2;
    let time = q.get('time') || '';
    if (def.time === 'day' && !/^\d{4}-\d{2}-\d{2}$/.test(time)) return sendJson(res, 400, { ok: false, error: 'date invalide' });
    if (def.time === 'dt' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/.test(time)) return sendJson(res, 400, { ok: false, error: 'date/heure invalide' });
    if (!def.time) time = '';
    const key = `gibs-${layer}-${time.replace(/[^\w]/g, '')}-${w}.${def.fmt === 'png' ? 'png' : 'jpg'}`;
    const file = path.join(CACHE_DIR, key);
    const mime = def.fmt === 'png' ? 'image/png' : 'image/jpeg';
    const send = (buf) => {
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' });
        res.end(buf);
    };
    try {
        const st = fs.statSync(file);
        const maxAge = def.time ? 6 * 3600 * 1000 : 365 * 24 * 3600 * 1000;
        if (Date.now() - st.mtimeMs < maxAge) return send(fs.readFileSync(file));
    } catch {}
    try {
        let p = gibsInflight.get(key);
        if (!p) {
            const url = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0' +
                '&LAYERS=' + layer + '&STYLES=&CRS=EPSG:4326&BBOX=-90,-180,90,180&WIDTH=' + w + '&HEIGHT=' + h +
                '&FORMAT=image/' + def.fmt + '&TRANSPARENT=' + (def.fmt === 'png' ? 'TRUE' : 'FALSE') +
                (time ? '&TIME=' + encodeURIComponent(time) : '');
            p = (async () => {
                const r = await fetchTimeout(url, {}, 60000);
                const type = r.headers.get('content-type') || '';
                if (!r.ok || !type.startsWith('image/')) throw new Error('GIBS : pas d\'image (HTTP ' + r.status + ')');
                const buf = Buffer.from(await r.arrayBuffer());
                if (buf.length < 2000) throw new Error('GIBS : image vide');
                const tmp = file + '.tmp';
                fs.writeFileSync(tmp, buf);
                fs.renameSync(tmp, file);
                return buf;
            })().finally(() => gibsInflight.delete(key));
            gibsInflight.set(key, p);
        }
        send(await p);
    } catch (e) {
        sendJson(res, 502, { ok: false, error: String(e && e.message || e) });
    }
}

// ---- Clés API : configuration en cours de session (modale Réglages) ----
// GET  /api/keys : renvoie l'état des clés (configurées ou non, masquées).
// POST /api/keys : met à jour les clés en mémoire, les persiste dans
//                  .api_keys.json et ré-applique les connexions (AIS / OpenSky).
// Les fichiers d'origine (.aisstream_key, .opensky_credentials.json) ne sont
// JAMAIS modifiés : la persistance passe par un fichier dédié .api_keys.json
// qui est chargé au démarrage en priorité (puis surchargé par l'environnement).
const API_KEYS_FILE = path.join(__dirname, '.api_keys.json');

function readApiKeysFile() {
    try {
        const j = JSON.parse(fs.readFileSync(API_KEYS_FILE, 'utf8'));
        return {
            aisKey: typeof j.aisKey === 'string' ? j.aisKey.trim() : '',
            openSkyClientId: typeof j.openSkyClientId === 'string' ? j.openSkyClientId.trim() : '',
            openSkyClientSecret: typeof j.openSkyClientSecret === 'string' ? j.openSkyClientSecret.trim() : '',
        };
    } catch {
        return { aisKey: '', openSkyClientId: '', openSkyClientSecret: '' };
    }
}

function writeApiKeysFile(o) {
    try {
        const tmp = API_KEYS_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(o, null, 2));
        fs.renameSync(tmp, API_KEYS_FILE);
        try { fs.chmodSync(API_KEYS_FILE, 0o600); } catch {}
    } catch (e) {
        console.warn('Clés API : échec de persistance (' + (e.message || e) + ')');
    }
}

// État courant des clés (mémoire). Priorité : environnement > .api_keys.json
// > fichiers d'origine déjà chargés (loadAisKey / loadOpenSkyCredentials).
let apiKeys = (() => {
    const file = readApiKeysFile();
    const envAis = (process.env.AISSTREAM_API_KEY || '').trim();
    const envOsc = (process.env.OPENSKY_CLIENT_ID || '').trim();
    const envOcs = (process.env.OPENSKY_CLIENT_SECRET || '').trim();
    const origOs = (OPENSKY_CREDS && OPENSKY_CREDS.clientId) ? OPENSKY_CREDS : {};
    return {
        aisKey: envAis || file.aisKey || (loadAisKey() || ''),
        openSkyClientId: envOsc || file.openSkyClientId || origOs.clientId || '',
        openSkyClientSecret: envOcs || file.openSkyClientSecret || origOs.clientSecret || '',
    };
})();

// Applique l'état courant aux modules AIS / OpenSky (sans redémarrage).
function applyAisKey(key) {
    if (key === aisKey) return;
    aisKey = key;
    if (aisKey) {
        // On abandonne tout socket courant (qu'il soit ouvert ou en cours) et on
        // repart d'un état propre : une reconnexion précédente échouée (ex. WS
        // non ouvert) laisse parfois aisReconnecting à true, ce qui bloquerait
        // la nouvelle connexion.
        if (aisSocket) { try { aisSocket.close(); } catch {} }
        aisSocket = null;
        aisReconnecting = false;
        aisReconnectMs = 1000;
        connectAis();
    } else {
        if (aisSocket) { try { aisSocket.close(); } catch {} }
        aisSocket = null;
        aisReconnecting = false;
        ships.clear();
        shipStatic.clear();
    }
    console.log('AIS : clé ' + (aisKey ? 'mà jour' : 'retirée'));
}

function applyOpenSkyCreds(clientId, clientSecret) {
    if (clientId && clientSecret) {
        OPENSKY_CREDS = { clientId, clientSecret };
    } else {
        OPENSKY_CREDS = null;
    }
    openSkyToken = null;              // on force la (re)obtention du token
    openSkyTokenInflight = null;
    if (OPENSKY_CREDS) {
        getOpenSkyToken().catch((e) => console.warn('OpenSky : token échec (' + (e.message || e) + ') — essai sans auth'));
    }
    console.log('OpenSky : identifiants ' + (OPENSKY_CREDS ? 'mà jour' : 'retirés (anonyme)'));
}

// Charge l'état initial des clés dans les modules (une seule fois au démarrage).
// applyAisKey court-circuite si la clé ne change pas : on force la 1re connexion ici.
aisKey = apiKeys.aisKey;
if (aisKey) {
    connectAis();
} else {
    console.log('AIS : clé API absente — /api/ships restera vide. Renseignez-la dans ⚙ Réglages (nav).');
}
if (apiKeys.openSkyClientId && apiKeys.openSkyClientSecret) {
    OPENSKY_CREDS = { clientId: apiKeys.openSkyClientId, clientSecret: apiKeys.openSkyClientSecret };
    getOpenSkyToken().catch((e) => console.warn('OpenSky : token échec au démarrage (' + (e.message || e) + ')'));
} else {
    console.log('OpenSky : identifiants OAuth2 absents — quota anonyme (400 crédits/jour). Renseignez-les dans ⚙ Réglages (nav).');
}

function maskSecret(s) {
    if (!s) return '';
    s = String(s);
    if (s.length <= 6) return '••••';
    return s.slice(0, 3) + '…' + s.slice(-3) + ` (${s.length} car.)`;
}

function readJsonBody(req, cb) {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 65536) req.destroy(); });
    req.on('end', () => {
        try { cb(null, data ? JSON.parse(data) : {}); }
        catch (e) { cb(e); }
    });
    req.on('error', (e) => cb(e));
}

function handleKeysGet(res) {
    sendJson(res, 200, {
        ok: true,
        ais: {
            configured: !!apiKeys.aisKey,
            masked: maskSecret(apiKeys.aisKey),
        },
        opensky: {
            configured: !!(apiKeys.openSkyClientId && apiKeys.openSkyClientSecret),
            clientIdMasked: maskSecret(apiKeys.openSkyClientId),
            hasSecret: !!apiKeys.openSkyClientSecret,
        },
    });
}

function handleKeysPost(req, res) {
    readJsonBody(req, (err, body) => {
        if (err) return sendJson(res, 400, { ok: false, error: 'JSON invalide' });
        const patch = {};
        let changed = false;
        const apply = (name) => {
            if (body[name] === undefined) return;
            const v = typeof body[name] === 'string' ? body[name].trim() : '';
            if (apiKeys[name] !== v) { apiKeys[name] = v; changed = true; }
        };
        apply('aisKey'); apply('openSkyClientId'); apply('openSkyClientSecret');
        if (!changed) return sendJson(res, 200, { ok: true, changed: false });

        writeApiKeysFile({
            aisKey: apiKeys.aisKey,
            openSkyClientId: apiKeys.openSkyClientId,
            openSkyClientSecret: apiKeys.openSkyClientSecret,
        });
        applyAisKey(apiKeys.aisKey);
        applyOpenSkyCreds(apiKeys.openSkyClientId, apiKeys.openSkyClientSecret);
        sendJson(res, 200, {
            ok: true, changed: true,
            aisConfigured: !!apiKeys.aisKey,
            openskyConfigured: !!(apiKeys.openSkyClientId && apiKeys.openSkyClientSecret),
        });
    });
}

const HOST = process.env.MAPPEMONDE_HOST || '127.0.0.1';
const server = http.createServer((req, res) => {
    // Anti DNS-rebinding : en liaison locale on n'accepte que localhost / 127.0.0.1
    if (HOST === '127.0.0.1' && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) {
        res.writeHead(403); res.end('403'); return;
    }
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;
    const q = new URLSearchParams(parsed.search || '');
    if (pathname === '/api/flights') {
        handleFlights(res);
        return;
    }
    if (pathname === '/api/ships') {
        let list = [];
        const cutoff = Date.now() - AIS_STALE_MS;
        for (const s of ships.values()) {
            if (s.lastSeen >= cutoff) list.push(s);
        }
        list.sort((a, b) => b.lastSeen - a.lastSeen);
        list = list.map((s) => {
            const st = shipStatic.get(s.mmsi);
            return st ? { ...s, cat: st.cat, shipType: st.type, destination: st.destination, imo: st.imo, callSign: st.callSign, length: st.length, draught: st.draught } : s;
        });
        sendJson(res, 200, {
            ok: true,
            source: 'stream.aisstream.io',
            keyConfigured: !!aisKey,
            count: list.length,
            fetchedAt: new Date().toISOString(),
            ships: list,
        });
        return;
    }
    if (pathname === '/api/satellites') {
        handleSatellites(res, q.get('group') || 'active');
        return;
    }
    if (pathname === '/api/space-weather') { feedJson(res, getSpaceWeather); return; }
    if (pathname === '/api/countries') { feedJson(res, getCountries); return; }
    if (pathname === '/api/crew') { feedJson(res, getCrew); return; }
    if (pathname === '/api/stats/catalogue') { feedJson(res, getStatsCatalog); return; }
    if (pathname === '/api/stats/countries') { feedJson(res, getStatsCountries); return; }
    if (pathname === '/api/stats') {
        const indicator = q.get('indicator') || '';
        if (!STAT_CATALOG.some((c) => c.id === indicator)) {
            sendJson(res, 400, { ok: false, error: 'indicateur inconnu' });
            return;
        }
        feedJson(res, getStats(indicator), null, 503);
        return;
    }
    if (pathname === '/api/gibs') { handleGibs(res, q); return; }
    if (pathname === '/api/health') {
        sendJson(res, 200, { ok: true, service: 'mappemonde-3d' });
        return;
    }
    if (pathname === '/api/keys') {
        if (req.method === 'POST') handleKeysPost(req, res);
        else handleKeysGet(res);
        return;
    }
    serveFile(req, res, pathname);
});

server.listen(PORT, HOST, () => {
    console.log(`Mappemonde 3D : http://127.0.0.1:${PORT}  (liaison ${HOST})`);
    console.log(`Proxy vols    : http://localhost:${PORT}/api/flights  (OpenSky${OPENSKY_CREDS ? ', OAuth2' : ', anonyme'})`);
    console.log(`Proxy TLE     : http://localhost:${PORT}/api/satellites  (CelesTrak)`);
});

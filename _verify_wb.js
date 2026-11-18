const CATALOG = ['SP.POP.TOTL.IN','SP.DNST.TOTL','NY.GDP.MKTP.CD','NY.GDP.PCAP.CD','SP.DYN.LE00.IN','SP.DYN.IMRT.IN','SL.UEM.TOTL.ZS','SP.URB.TOTL.IN.ZS','SP.POP.1564.SP','SE.ACT.TOTL.ZS','SE.PRM.ENRR','IT.NET.USER.ZS','IT.CEL.MOBP.P5','EG.ELEC.ACES.ZS','EN.ATM.CO2E.PC','EN.ATM.CO2E.KT.CE','SI.POV.GINI','EG.GEX.IKSD.CD','GC.XPK.TOTL.GD.ZS','LE.XPD.SOC.GD.ZS','GC.DOD.TOTL.GD.ZS','SH.STA.BEDS'];
const j = async (u) => {
    const r = await fetch(u, { headers: { Accept: 'application/json' } });
    const x = await r.json();
    if (Array.isArray(x) && x[0] && x[0].message) throw new Error(String(x[0].message[0] && x[0].message[0].value || x[0].message));
    return x;
};
(async () => {
    for (const id of CATALOG) {
        let line = id.padEnd(20);
        const tryDate = async (date) => {
            const x = await j(`https://api.worldbank.org/v2/country/all/indicator/${id}?date=${date}&format=json&per_page=600`);
            const arr = Array.isArray(x) && Array.isArray(x[1]) ? x[1] : [];
            const n = arr.filter(r => r && r.value != null && isFinite(parseFloat(r.value))).length;
            const last = arr.length ? arr[arr.length - 1].date : '?';
            return { n, last };
        };
        try {
            const a = await tryDate('2025');
            if (a.n >= 5) { line += `  2025: ${a.n} pays (derniere ligne ${a.last})`; console.log(line); continue; }
            const b = await tryDate('2025:2022');
            line += `  2025: ${a.n} | 2025:2022: ${b.n} pays (derniere ${b.last})` + (b.n >= 5 ? '' : '  <-- ECHEC');
            console.log(line);
        } catch (e) { console.log(line + '  ERREUR ' + e.message); }
    }
})();

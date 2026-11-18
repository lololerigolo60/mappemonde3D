// Verification definitive : chaque ID du catalogue + candidats de remplacement
const j = async (u) => {
    const r = await fetch(u, { headers: { Accept: 'application/json' } });
    const x = await r.json();
    if (Array.isArray(x) && x[0] && x[0].message) return { err: x[0].message[0].key };
    if (Array.isArray(x) && Array.isArray(x[1])) return { n: x[1].filter(r => r && r.value != null).length };
    return { err: 'format' };
};

const rows = [
    // [ID catalogue, candidats de remplacement]
    ['SP.POP.TOTL.IN',      ['SP.POP.TOTL']],
    ['SP.DNST.TOTL',        ['SP.DNST.TOTL.ZS']],
    ['SP.POP.1564.SP',      ['SP.POP.1564.TO']],
    ['SE.ACT.TOTL.ZS',      ['SE.ACT.TOTL.ZS', 'SE.ALT.TOTL.ZS']],
    ['IT.CEL.MOBP.P5',      ['IT.CEL.MOBP.P5', 'IT.CEL.SUBM.P6']],
    ['EG.ELEC.ACES.ZS',     ['EG.ELEC.ACES.ZS', 'EG.ELEC.ACES.GF.ZS']],
    ['EN.ATM.CO2E.PC',      ['EN.ATM.CO2E.PC', 'EN.GHG.CO2.PC.AR5.GN']],
    ['EN.ATM.CO2E.KT.CE',   ['EN.ATM.CO2E.KT', 'EN.ATM.CO2E.KT.ZG']],
    ['EG.GEX.IKSD.CD',      ['EG.GEX.IKSD.CD', 'NE.EXP.GNFS.CD', 'NE.TRD.GNFS.CD']],
    ['GC.XPK.TOTL.GD.ZS',   ['GC.XPK.TOTL.GD.ZS', 'GC.DOD.XPND.GD.ZS']],
    ['LE.XPD.SOC.GD.ZS',    ['LE.XPD.SOC.GD.ZS', 'SH.XPD.CHEX.GD.ZS']],
    ['SH.STA.BEDS',         ['SH.STA.BEDS', 'SH.STA.BEDS.ZS']],
    // OK deja
    ['NY.GDP.MKTP.CD',      []],
    ['NY.GDP.PCAP.CD',      []],
    ['SP.DYN.LE00.IN',      []],
    ['SP.DYN.IMRT.IN',      []],
    ['SL.UEM.TOTL.ZS',      []],
    ['SP.URB.TOTL.IN.ZS',   []],
    ['SE.PRM.ENRR',         []],
    ['IT.NET.USER.ZS',      []],
    ['SI.POV.GINI',         []],
    ['GC.DOD.TOTL.GD.ZS',   []],
];

for (const [id, cands] of rows) {
    let line = id.padEnd(20);
    for (const y of ['2025', '2024', '2023']) {
        const r = await j(`https://api.worldbank.org/v2/country/all/indicator/${id}?date=${y}&format=json&per_page=600`);
        line += `  ${y}:${r.n !== undefined ? r.n : 'x'}`;
        if (r.n >= 5) break;
    }
    if (cands.length) {
        for (const c of cands) {
            const r = await j(`https://api.worldbank.org/v2/country/all/indicator/${c}?date=2024&format=json&per_page=600`);
            line += `   [${c} 2024:${r.n !== undefined ? r.n : 'x'}]`;
        }
    }
    console.log(line);
    await new Promise(s => setTimeout(s, 300));
}

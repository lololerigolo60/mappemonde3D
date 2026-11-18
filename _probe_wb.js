const t = async (u, label) => {
    try {
        const r = await fetch(u, { headers: { Accept: 'application/json' } });
        const x = await r.text();
        const brief = x.slice(0, 130).replace(/\n/g, ' ');
        console.log(label.padEnd(28), '->', r.status, '|', brief);
    } catch (e) { console.log(label.padEnd(28), 'ERR', e.message); }
    await new Promise(res => setTimeout(res, 1200));
};
(async () => {
    // 1) indicateur qui MARCHE vs qui ECHOUE, meme forme d'URL
    await t('https://api.worldbank.org/v2/indicator/NY.GDP.MKTP.CD', 'OK ? NY.GDP.MKTP.CD');
    await t('https://api.worldbank.org/v2/indicator/SP.POP.TOTL.IN', 'KO ? SP.POP.TOTL.IN');
    await t('https://api.worldbank.org/v2/country/FRA/indicator/SP.POP.TOTL.IN?format=json&per_page=1', 'KO ? FRA SP.POP.TOTL.IN');
    // 2) meme indicateur KO, sans Accept json
    await t('https://api.worldbank.org/v2/indicator/SP.POP.TOTL.IN?format=xml', 'KO ? format xml');
    // 3) liste des indicateurs existants (pour voir si SP.POP.TOTL.IN y figure)
    const r = await fetch('https://api.worldbank.org/v2/indicator?format=json&per_page=30000', { headers: { Accept: 'application/json' } });
    const j = await r.json();
    const arr = j[1] || [];
    console.log('\nTotal indicateurs annonces par l\'API :', (j[0] || {}).total);
    const found = arr.filter(x => ['SP.POP.TOTL.IN','SE.ACT.TOTL.ZS','EG.ELEC.ACES.ZS','IT.CEL.MOBP.P5','EN.ATM.CO2E.PC'].includes(x.id));
    console.log('Présents dans la liste ?', found.map(x => x.id + ' -> ' + x.value).join(' | ') || 'AUCUN');
})();

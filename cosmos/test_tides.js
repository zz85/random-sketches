// Validate tides.js against official NOAA CO-OPS predictions.
//   node test_tides.js [stationId ...]
// Compares 6-minute heights and high/low times for a 30 day window.
const Tides = require('./tides.js');

const STATIONS = process.argv.slice(2).length ? process.argv.slice(2)
    : ['9447130', '9414290', '8443970', '9455920', '1612340', '8518750', '8724580', '9410230'];

const fmt = (x, n = 3) => (x >= 0 ? ' ' : '') + x.toFixed(n);

async function checkSpeeds() {
    // constituent speeds vs. NOAA published speeds (all NOAA stations share the same list)
    const { harcon } = await Tides.NOAA.fetchStation('9455920');
    let bad = 0;
    for (const c of harcon.HarmonicConstituents) {
        const d = Tides.resolve(c.name);
        if (!d) { console.log('  unknown constituent', c.name, c.speed, c.description); bad++; continue; }
        const sp = Tides.speedOf(c.name);
        if (Math.abs(sp - c.speed) > 1e-3) { console.log('  SPEED MISMATCH', c.name, sp.toFixed(6), 'vs', c.speed); bad++; }
    }
    console.log(`speed table: ${harcon.HarmonicConstituents.length} constituents, ${bad} problems`);
    return bad;
}

async function checkStation(id) {
    const { station, harcon, datums } = await Tides.NOAA.fetchStation(id);
    const m = Tides.NOAA.toModel(station, harcon, datums, 'MLLW');
    const start = new Date(Date.UTC(2026, 8, 20)), end = new Date(Date.UTC(2026, 9, 20));

    const noaa = await Tides.NOAA.fetchPredictions(id, start, end, { interval: 6 });
    let se = 0, maxErr = 0;
    for (const p of noaa) {
        const e = Tides.height(m, p.time) - p.height;
        se += e * e; if (Math.abs(e) > Math.abs(maxErr)) maxErr = e;
    }
    const rmse = Math.sqrt(se / noaa.length);

    const noaaHL = await Tides.NOAA.fetchPredictions(id, start, end, { interval: 'hilo' });
    const ours = Tides.extremes(m, start, end);
    let matched = 0, dtSum = 0, dhSum = 0, dtMax = 0;
    for (const n of noaaHL) {
        const type = n.type === 'H' ? 'H' : 'L';
        let best = null;
        for (const o of ours) {
            if (o.type !== type) continue;
            const dt = Math.abs(o.time - n.time) / 60000;
            if (dt < 180 && (!best || dt < best.dt)) best = { dt, dh: o.height - n.height };
        }
        if (best) { matched++; dtSum += best.dt; dhSum += Math.abs(best.dh); dtMax = Math.max(dtMax, best.dt); }
    }
    const st = Tides.stats(m);
    console.log(`${id} ${station.name.padEnd(16)} ${st.type.padEnd(26)} n=${m.constituents.length}` +
        ` unknown=${m.unknown.length} range~${(2 * ((st.bySpecies.semidiurnal || 0) + (st.bySpecies.diurnal || 0))).toFixed(1)}ft` +
        ` | heights rmse=${fmt(rmse)}ft max=${fmt(maxErr)}ft` +
        ` | hi/lo ${matched}/${noaaHL.length} (ours ${ours.length}) mean|dt|=${(dtSum / matched).toFixed(1)}min max|dt|=${dtMax.toFixed(0)}min mean|dh|=${(dhSum / matched).toFixed(3)}ft`);
    if (m.unknown.length) console.log('   unknown:', m.unknown.map(u => u.name + (u.reason ? '(' + u.reason + ')' : '')).join(' '));
    const range = 2 * ((st.bySpecies.semidiurnal || 0) + (st.bySpecies.diurnal || 0));
    return { rmse, range, dt: dtSum / matched, matched, total: noaaHL.length, ours: ours.length };
}

(async () => {
    const badSpeeds = await checkSpeeds();
    const results = [];
    for (const id of STATIONS) {
        try { results.push(await checkStation(id)); } catch (e) { console.log(id, 'FAILED', e.message); results.push(null); }
    }
    // pass: rmse under 0.5% of tidal range (or 0.05 ft), hi/lo mean timing error under 3 min, every NOAA hi/lo matched
    const ok = results.every(r => r && r.rmse < Math.max(0.05, 0.005 * r.range) && r.dt < 3 && r.matched === r.total && r.ours === r.total);
    console.log(ok && badSpeeds === 0 ? 'PASS' : 'FAIL');
    process.exit(ok && badSpeeds === 0 ? 0 : 1);
})();

const plotSun = plotSun2

function plotSun2(date, lat, lon) {
    date.setSeconds(0);
    date.setMinutes(0);

    var ctx = createCanvas(800, 400)
    var viz = document.getElementById('viz')
    viz.replaceChildren(ctx.dom);

    var points = [];
    const MINS_A_DAY = 60 * 24;
    const base = 200;
    const hour_w = MINS_A_DAY / 24 / 2;

    

    const nowPos = SunCalc.getPosition(date, lat, lon);
    date.setHours(0);
    const now = new Date();
    const nowHour = (now.getTime() - date.getTime()) / 60 / 1000 / 60
    console.log(nowHour);
    ctx.fillText(`☀️`, (nowHour + 1) * hour_w, 40);

    for (let h = 0; h < 24; h += 1) {
        date.setHours(h);
        const pos = SunCalc.getPosition(date, lat, lon);

        const alt = getAngle(pos.altitude);

        ctx.fillStyle = 'orange'
        ctx.beginPath();
        ctx.arc((h + 1) * hour_w, base - alt * 2, 5, 0, Math.PI * 2)
        ctx.fill();

        ctx.fillStyle = '#333';
        ctx.fillText(`${h}h`, (h + 1) * hour_w, 50);
        // ctx.fillText(`${alt.toFixed()}°`, (h + 0) * hour_w, base - alt * 2 + 30);

        points.push(alt)
    }

    ctx.fillStyle = '#333';
    for (let y = -90; y <= 90; y+= 15) {
        ctx.fillText(`${y.toFixed()}°`, 0, base - y * 2);
    }

    date.setHours(0);

    ctx.translate(hour_w,  0);
    ctx.strokeStyle = '#999';
    ctx.beginPath();
    ctx.moveTo(0, base);
    ctx.lineTo(24 * hour_w, base);
    ctx.stroke();

    // year long solar path
    for (let min = 0; min < MINS_A_DAY * 365; min += 2) { // 3, 15, 30 could still work
        const mod_min = min % MINS_A_DAY;
        const day = min / MINS_A_DAY | 0;

        // if (mod_min != 0) continue;

        const condition_for_plotting =
            mod_min % 60  == 0 ||
            day % 30 == 0;

        if (!condition_for_plotting) continue; // 60 mins mark

        const pos = SunCalc.getPosition(new Date(date.getTime() + min * ONE_MIN), lat, lon);
        const alt = getAngle(pos.altitude);

        const x = mod_min / 2, y = base - alt * 2;

        const density = 100 + day / 365 / 2 * 255;
        ctx.fillStyle = `rgb(${density}, ${density}, ${density})`

        ctx.beginPath();
        ctx.arc(x, y, 0.5, 0, Math.PI * 2)
        ctx.fill();
    }
}

function plotSun1(date, lat, lon) {
    date.setSeconds(0);
    date.setMinutes(0);

    var ctx = createCanvas(1600, 800)
    var viz = document.getElementById('viz')
    viz.replaceChildren(ctx.dom);

    var points = [];
    const MINS_A_DAY = 60 * 24;
    const base = 200;
    const hour_w = MINS_A_DAY / 24 / 2;

    ctx.beginPath();
    ctx.moveTo(0, base);
    ctx.lineTo(25 * hour_w, base);
    ctx.stroke();

    for (let h = 0; h < 24; h += 1) {
        date.setHours(h);
        const pos = SunCalc.getPosition(date, lat, lon);

        const alt = getAngle(pos.altitude);

        // getAngle()
        ctx.fillText(`${h}`, (h + 0) * hour_w, 50);

        ctx.beginPath();
        ctx.arc((h + 0) * hour_w, base - alt * 2, 5, 0, Math.PI * 2)
        ctx.stroke();
        ctx.fillText(`${alt.toFixed()}°`, (h + 0) * hour_w, base - alt * 2 - 30);

        points.push(alt)
    }

    // ctx.beginPath();
    // points.forEach((alt, h) => {
    //     ctx.lineTo((h + 0) * hour_w, base - alt * 2)
    // })
    // ctx.stroke();

    date.setHours(0);
    ctx.lineWidth = 0.05;
    ctx.beginPath();

    for (let min = 0; min < MINS_A_DAY * 400; min += 1) { // 3, 15, 30 could still work
        const pos = SunCalc.getPosition(new Date(date.getTime() + min * ONE_MIN), lat, lon);
        const alt = getAngle(pos.altitude);

        const mod_min = min % MINS_A_DAY;
        ctx.lineTo(mod_min / 2, base - alt * 2)

        // if (mod_min == 0) {
        if (mod_min == MINS_A_DAY - 1) {
            ctx.stroke();
            ctx.beginPath();
            const day = min / MINS_A_DAY | 0;
            const density = day / 400 * 255;
            ctx.strokeStyle = `rgb(${density}, ${density}, ${density})`
        }

    }
}


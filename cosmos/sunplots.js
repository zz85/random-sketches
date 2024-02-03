const plotSun = plotSun2
const plotSunCompass = plotSunCompass3;

/* Time helpers */

function pad(str) {
    const fmt = `00${str}`
    return fmt.slice(fmt.length - 2)
}

function getLocal(date) {
    return `${getLocalDate(date)} ${getLocalTime(date)}`
}

function getLocalTime(date) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`
    //  + `:${pad(date.getSeconds())}`
}

function getLocalDate(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}



function plotSunCompass3(date, lat, lon, shortest, longest) {
    const nowPos = SunCalc.getPosition(date, lat, lon);
    date.setSeconds(0);
    date.setMinutes(0);

    var ctx = createCanvas(400, 400)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle'

    ctx.fillText('Sun Direction', 200, 30);

    const square = 200;
    const radius = 150;
    ctx.translate(square, square);

    ctx.strokeStyle = '#999'
    ctx.beginPath();
    ctx.moveTo(-radius, 0);
    ctx.lineTo(radius, 0);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0, -radius);
    ctx.lineTo(0, radius);
    ctx.stroke();

    ctx.save();
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = '#ddd'
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2)
    ctx.stroke();
    ctx.restore();

    function loc(pos) {
        // const r = Math.cos(pos.altitude) * radius;
        const r = (1 - (pos.altitude/ Math.PI * 180) / 90) * radius;
        const bearing = pos.azimuth + Math.PI / 2;
        const x = Math.cos(bearing) * r;
        const y = Math.sin(bearing) * r;
        return [x, y]
    }

    let [x, y] = loc(nowPos);
    ctx.fillText(`☀️`, x, y);

    ctx.save();
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = '#ddd'
    ctx.fillStyle = '#333'
    ctx.font = '4px sans-serif'
    for (let angle = 0; angle <= 90; angle += 10)  {
        const r = (1 - angle / 90) * radius;
        ctx.beginPath()
        ctx.arc(0, 0, r,  0, Math.PI * 2);
        ctx.stroke();

        ctx.fillText(`${angle}°`, r, -5);
    }
    ctx.restore();

    ctx.save();
    for (let h = 0; h < 24; h += 1) {
        date.setHours(h);
        const pos = SunCalc.getPosition(date, lat, lon);
        let [x, y] = loc(pos);

        if (pos.altitude < 0) {
            ctx.globalAlpha =  0.2
            continue;
        } else {
            ctx.globalAlpha =  1
        }
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = 'orange'
        ctx.fill();

        ctx.font = '8px sans-serif'
        ctx.fillStyle = 'black'
        // ctx.fillText(`${h}`, x, y - 5);
        ctx.fillText(`${(pos.altitude/ Math.PI * 180).toFixed(0)}`, x, y - 5);

        ctx.lineWidth = 0.5
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(x, y);
        ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.font = '6px sans-serif';
    [shortest.dt, longest.dt].forEach((dt, i) => {
        let label = false;
        const syn = ['_', '^']
        for (let h = 0; h < 24; h += 1) {
            dt.setHours(h);
            const pos = SunCalc.getPosition(dt, lat, lon);
            let [x, y] = loc(pos);

            if (pos.altitude < 0) continue;
            if (!label) {
                ctx.fillText(getLocalDate(dt), x, y + (i == 0 ? 50 : -50));
                label = true;
            }

            ctx.fillText(`${h}`, x, y + (i == 0 ? 15 : -15));
            ctx.fillText(`${syn[i]}`, x, y);
        }
    })
    ctx.restore();

    const bearing = 40;
    ctx.fillText('N', 0, -bearing);
    ctx.fillText('S', 0, bearing);
    ctx.fillText('E', bearing, 0);
    ctx.fillText('W', -bearing, 0);

    return ctx.dom;
}

function plotSunCompass2(date, lat, lon, shortest, longest) {
    const nowPos = SunCalc.getPosition(date, lat, lon);
    date.setSeconds(0);
    date.setMinutes(0);

    var ctx = createCanvas(400, 400)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle'

    ctx.fillText('Sun Direction', 200, 30);

    const square = 200;
    const radius = 150;
    ctx.translate(square, square);

    ctx.strokeStyle = '#999'
    ctx.beginPath();
    ctx.moveTo(-radius, 0);
    ctx.lineTo(radius, 0);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0, -radius);
    ctx.lineTo(0, radius);
    ctx.stroke();

    ctx.save();
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = '#ddd'
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2)
    ctx.stroke();
    ctx.restore();

    function loc(pos) {
        const r = Math.cos(pos.altitude) * radius;
        const bearing = pos.azimuth + Math.PI / 2;
        const x = Math.cos(bearing) * r;
        const y = Math.sin(bearing) * r;
        return [x, y]
    }

    let [x, y] = loc(nowPos);
    ctx.fillText(`☀️`, x, y);

    ctx.save();
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = '#ddd'
    ctx.fillStyle = '#333'
    ctx.font = '4px sans-serif'
    for (let angle = 0; angle <= 90; angle += 10)  {
        const r = Math.cos(angle * Math.PI / 180) * radius
        ctx.beginPath()
        ctx.arc(0, 0, r,  0, Math.PI * 2);
        ctx.stroke();

        ctx.fillText(`${angle}°`, r, -5);
    }
    ctx.restore();

    ctx.save();
    for (let h = 0; h < 24; h += 1) {
        date.setHours(h);
        const pos = SunCalc.getPosition(date, lat, lon);
        let [x, y] = loc(pos);

        if (pos.altitude < 0) {
            ctx.globalAlpha =  0.2
            // continue;
        } else {
            ctx.globalAlpha =  1
        }
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = 'orange'
        ctx.fill();

        ctx.font = '8px sans-serif'
        ctx.fillStyle = 'black'
        ctx.fillText(`${h}`, x, y - 5);

        ctx.lineWidth = 0.5
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(x, y);
        ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.font = '6px sans-serif';
    [shortest.dt, longest.dt].forEach((dt, i) => {
        let label = false;
        const syn = ['_', '^']
        for (let h = 0; h < 24; h += 1) {
            dt.setHours(h);
            const pos = SunCalc.getPosition(dt, lat, lon);
            let [x, y] = loc(pos);

            if (pos.altitude < 0) continue;
            if (!label) {
                ctx.fillText(getLocalDate(dt), x, y + (i == 0 ? 50 : -50));
                label = true;
            }

            ctx.fillText(`${h}`, x, y + (i == 0 ? 15 : -15));
            ctx.fillText(`${syn[i]}`, x, y);
        }
    })
    ctx.restore();

    const bearing = 40;
    ctx.fillText('N', 0, -bearing);
    ctx.fillText('S', 0, bearing);
    ctx.fillText('E', bearing, 0);
    ctx.fillText('W', -bearing, 0);

    return ctx.dom;
}

function plotSunCompass1(date, lat, lon, shortest, longest) {
    const nowPos = SunCalc.getPosition(date, lat, lon);
    date.setSeconds(0);
    date.setMinutes(0);

    var ctx = createCanvas(400, 400)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle'

    ctx.fillText('Sun Direction', 200, 30);

    const square = 200;
    const radius = 150;
    ctx.translate(square, square);

    ctx.strokeStyle = '#999'
    ctx.beginPath();
    ctx.moveTo(-radius, 0);
    ctx.lineTo(radius, 0);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0, -radius);
    ctx.lineTo(0, radius);
    ctx.stroke();

    ctx.save();
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = '#ddd'
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2)
    ctx.stroke();
    ctx.restore();

    function loc(pos) {
        const r = Math.cos(pos.altitude) * radius;
        const bearing = pos.azimuth + Math.PI / 2;
        const x = Math.cos(bearing) * r;
        const y = Math.sin(bearing) * r;
        return [x, y]
    }

    let [x, y] = loc(nowPos);
    ctx.fillText(`☀️`, x, y);

    ctx.save();
    for (let h = 0; h < 24; h += 1) {
        date.setHours(h);
        const pos = SunCalc.getPosition(date, lat, lon);
        let [x, y] = loc(pos);

        if (pos.altitude < 0) continue;
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = 'orange'
        ctx.fill();

        ctx.font = '8px sans-serif'
        ctx.fillStyle = 'black'
        ctx.fillText(`${h}`, x, y - 5);

        ctx.lineWidth = 0.5
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(x, y);
        ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.font = '6px sans-serif';
    [shortest.dt, longest.dt].forEach((dt, i) => {
        let label = false;
        const syn = ['_', '^']
        for (let h = 0; h < 24; h += 1) {
            dt.setHours(h);
            const pos = SunCalc.getPosition(dt, lat, lon);
            let [x, y] = loc(pos);

            if (pos.altitude < 0) continue;
            if (!label) {
                ctx.fillText(getLocalDate(dt), x, y + (i == 0 ? 50 : -50));
                label = true;
            }

            ctx.fillText(`${h}`, x, y + (i == 0 ? 15 : -15));
            ctx.fillText(`${syn[i]}`, x, y);
        }
    })
    ctx.restore();

    const bearing = 40;
    ctx.fillText('N', 0, -bearing);
    ctx.fillText('S', 0, bearing);
    ctx.fillText('E', bearing, 0);
    ctx.fillText('W', -bearing, 0);

    return ctx.dom;
}

// outline monthly sun plots
function plotSun2(date, lat, lon) {
    date.setSeconds(0);
    date.setMinutes(0);

    var ctx = createCanvas(800, 400)

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
    for (let y = -90; y <= 90; y += 15) {
        ctx.fillText(`${y.toFixed()}°`, 0, base - y * 2);
    }

    date.setHours(0);

    ctx.translate(hour_w, 0);
    ctx.strokeStyle = '#999';
    ctx.beginPath();
    ctx.moveTo(0, base);
    ctx.lineTo(24 * hour_w, base);
    ctx.stroke();

    // year long solar path
    for (let min = 0; min < MINS_A_DAY * 365; min += 2) { // 3, 15, 30 could still work
        const mod_min = min % MINS_A_DAY;
        const day = min / MINS_A_DAY | 0;

        const condition_for_plotting =
            mod_min % 60 == 0 ||
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

    ctx.fillStyle = 'black'
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle'
    ctx.fillText('Solor Altitude Chart', 350, 20);

    return ctx.dom;
}

// overly eager sun path plots
function plotSun1(date, lat, lon) {
    date.setSeconds(0);
    date.setMinutes(0);

    var ctx = createCanvas(1600, 800)

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

    return ctx.dom;
}


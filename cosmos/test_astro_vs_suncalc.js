var SunCalc3 = require('suncalc3');
var Astronomy = require('astronomy-engine')

var lat = 46.998628;
var lon = -121.533743;

var now = new Date();
const observer = new Astronomy.Observer(lat, lon, 0);
console.log(`${pad('Start', 24)}  ${pad('Suncal', 16)}  ${pad('Engine', 16)}`)

for (let i = 0; i < 24; i++) {
    var date = new Date(now.getTime() + i * 60 * 60 * 1000);

    let pos = SunCalc3.getPosition(date, lat, lon, 0)

    let a = pos.azimuthDegrees
    let b = pos.altitudeDegrees

    let equ_ofdate = Astronomy.Equator('Sun', date, observer, true, true);
    let hor = Astronomy.Horizon(date, observer, equ_ofdate.ra, equ_ofdate.dec, 'normal');

    let c = hor.azimuth;
    let d = hor.altitude;

    console.log(`${pad(date + '', 24)} ${format(a)} ${format(b)} ${format(c)} ${format(d)}`)
}


function format(x) {
    return x.toFixed(2).padStart(8);
}


function pad(text, n = 24) {
    var remain = n - text.length;


    return remain > 0 ? `${Array(remain).fill(0).map(_ => ' ').join('')}${text}` : text.substring(0, n)
}
var SunCalc1 = require('suncalc');
var SunCalc3 = require('suncalc3');

var lat, lon;

lat = 51.5;
lon = -0.1;

var now = new Date();

var dayTimes1 = SunCalc1.getTimes(now, lat, lon);
// console.log('dayTimes1',  dayTimes1);
console.log('# SunCalc1');

[
    'sunrise', 'sunset', 'nadir',
    'goldenHour', 'goldenHourEnd'
].forEach(k => {
    const time = dayTimes1[k];
    let pos = SunCalc1.getPosition(time, lat, lon);
    console.log(k, getLocal(time), getAngle(pos.azimuth), getAngle(pos.altitude));
})

var dayTimes3 = SunCalc3.getSunTimes(now, lat, lon);
// console.log('dayTimes3',  dayTimes3);

console.log('# SunCalc3');

['solarNoon', 'nadir', 'sunriseStart', 'sunriseEnd', 'sunsetStart', 'sunsetEnd'].forEach(k => {
    console.log(k, getLocal(dayTimes3[k].value))
})

//blueHourDuskStart goldenHourDawnStart:

console.log('\n# Sunrise for this year\n');
const one_day = 1000 * 60 * 60 * 24;

for (let day = 0; day < 365; day++) {
    let times = SunCalc1.getTimes(new Date(now.getTime() + day * one_day), lat, lon);
    let pos = SunCalc1.getPosition(times.sunrise, lat, lon);

    console.log(`+${day}`, getLocal(times.sunrise), '->', getLocal(times.sunset), getAngle(pos.azimuth), getAngle(pos.altitude))
}

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

function getAngle(rad) {
    return `${(rad * 180 / Math.PI).toFixed(0)}°`
}
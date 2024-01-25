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
    console.log(k, getLocal(dayTimes1[k]));
})

var dayTimes3 = SunCalc3.getSunTimes(now, lat, lon);
// console.log('dayTimes3',  dayTimes3);

console.log('# SunCalc3');

['solarNoon', 'nadir', 'sunriseStart', 'sunriseEnd', 'sunsetStart', 'sunsetEnd'].forEach(k => {
    console.log(k, getLocal(dayTimes3[k].value))
})

//blueHourDuskStart goldenHourDawnStart:

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
    return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`
}

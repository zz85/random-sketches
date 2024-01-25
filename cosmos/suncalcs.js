var SunCalc1 = require('suncalc');
var SunCalc3 = require('suncalc3');

var lat, lon;

lat = 51.5;
lon = -0.1;

var now = new Date();

var dayTimes1 = SunCalc1.getTimes(now, lat, lon);
console.log('dayTimes1',  dayTimes1);

console.log('sunrise', getLocalTime(dayTimes1.sunrise));

var dayTimes3 = SunCalc3.getSunTimes(now, lat, lon);
console.log('dayTimes3',  dayTimes3);

function getLocalTime(date) {
    return `${date.getHours()}:${date.getMinutes()}`
}

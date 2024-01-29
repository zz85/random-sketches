/*
 * Pre-configures locator and sun data
 */
var now = new Date();
var this_hour = new Date(now)
this_hour.setMinutes(0);
this_hour.setSeconds(0);

const locator = new Locator();

const ONE_SEC = 1000;
const ONE_MIN = ONE_SEC * 60;
const ONE_HOUR = ONE_MIN * 60;
const ONE_DAY = ONE_HOUR * 24;

function startLocator(cb) {
    const configureLocator = () => cb(locationUpdate());

    if (!locator.timestamp) {
        locator.getLocation(configureLocator);
    } else {
        configureLocator();

        // use cache results for 1 hour
        if ((Date.now() - locator.timestamp) > ONE_HOUR) {
            locator.getLocation(configureLocator);
        }
    }
}

function locationUpdate() {
    const sunPos = [];

    // now
    const pos = SunCalc.getPosition(now, locator.latitude, locator.longitude);
    sunPos.push(Object.assign({
        now: true,
        relative: 0,
        h: now.getHours(),
    }, pos))

    // today
    for (let i = -12; i < 12; i++) {
        const date = new Date(this_hour.getTime() + i * ONE_HOUR);
        const pos = SunCalc.getPosition(date, locator.latitude, locator.longitude);
        sunPos.push(Object.assign({
            relative: i,
            h: date.getHours(),
        }, pos))
    }

    const startOfDay = new Date(this_hour);
    startOfDay.setHours(0);

    // do this for next 365 days
    for (let day = 0; day < 366; day++) {
        let newDay = new Date(startOfDay.getTime() + day * ONE_DAY);
        const q = newDay.getDate() == 20;
        // const q = day % 90 == 0;
        const skipDays = newDay.getDate() % 3 == 0

        for (let h = 0; h < 24 && skipDays; h++) {
            const date = new Date(startOfDay.getTime() + day * ONE_DAY + h * ONE_HOUR);
            const pos = SunCalc.getPosition(date, locator.latitude, locator.longitude);
            sunPos.push(Object.assign({
                day,
                // h,
                h: date.getHours(),
            }, pos))
        }

        if (q) {
            for (let min = 0; min < 60 * 24; min += 5) {
                const date = new Date(startOfDay.getTime() + day * ONE_DAY + min * ONE_MIN);
                const pos = SunCalc.getPosition(date, locator.latitude, locator.longitude);
                sunPos.push(Object.assign({
                    day,
                    h: date.getHours(),
                }, pos))
            }
        }
    }

    return sunPos;
}
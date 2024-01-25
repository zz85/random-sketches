class Locator {
    constructor() {
        this.latitude = 0;
        this.longitude = 0;
        this.altitude = 0;
        this.accuracy = 0;
        this.altitudeAccuracy = 0;
        this.heading = 0;
        this.speed = 0;
        this.timestamp = 0;

        if (localStorage['cosmos']) {
            Object.assign(this, JSON.parse(localStorage['cosmos']));
        }
    }

    getLocation(cb) {
        navigator.geolocation.getCurrentPosition((position) => {
            this.showPosition(position);
            cb && cb(this);
        });
    }

    showPosition(position) {
        const { timestamp, coords } = position;
        const {
            latitude, longitude, altitude, accuracy, altitudeAccuracy, heading, speed
        } = coords;

        Object.assign(this, { timestamp }, {
            latitude, longitude, altitude, accuracy, altitudeAccuracy, heading, speed
        })

        console.log(JSON.stringify(this));
        localStorage['cosmos'] = JSON.stringify(this)
    }
}
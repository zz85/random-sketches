# Random experiments
* [sun charts](cosmos/suncharts.html) - JS based sunrise and sunset tables
* [compass](cosmos/compass.html) - Web based implementation of IOS compass app
* [compass with positioning](cosmos/compass_position.html) - like compass with positioning data
* [fullbody-quest](fullbody-quest) - Poor man's fullbody for Meta quest 2
* [streaming-server](streaming-server) - Simple scaffolding for real-time web applications without websockets.
* [protrait_effect](protrait_effect) - experiments to render the bokeh (aka Protrait on ios) effect with tensorflow.js and three.js
* [fishy-sketches](fishy-sketches) - drawing fishes with bezier curves in 2d
####  History / Notes
* 26 Jan 2024 - [Compass app variant](cosmos/compass_position.html) that uses geolocation for coordinates and altitude
* 24 Jan 2024 - JS based generation and visualizations of [sunrise and sunset tables](cosmos/suncharts.html). Explore the use of the suncalc libaries and [geolocation](cosmos/location.html) api.
* 23 Jan 2024 - A JS canvas based implementation of the IOS [Compass app](cosmos/compass.html), utilizing device orientation event and webkit compass heading. I implemented most of the UI/UX including bearing display and the dial rotation, including bubble level and direction marking. What's missing are vibration (disallowed in safari) and GPS coordinates and some subtle animations. One improvement I have over Apple's implementation
is that tapping the screen not only marks the change in direction, but gives the angle difference. This
can be useful for just measuring differences in compass bearings.
* 14 Jan 2024 - combined streaming server and tracking code in handstand experiment to mirror pose tracking across the network
* 14 Jan 2024 - streaming-server uses h2 and sse (server sent events) as an alternative to websockets.

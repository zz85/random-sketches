# Random experiments

* [compass](cosmo/compass.html) - Web based implementation of IOS compass app
* [fullbody-quest](fullbody-quest) - Poor man's fullbody for Meta quest 2
* [streaming-server](streaming-server) - Simple scaffolding for real-time web applications without websockets.
* [protrait_effect](protrait_effect) - experiments to render the bokeh (aka Protrait on ios) effect with tensorflow.js and three.js
* [fishy-sketches](fishy-sketches) - drawing fishes with bezier curves in 2d

####  Notes/History
* 23 Jan 2024 - A JS canvas based implementation of the IOS Compass app, utilizing device orientation event and webkit compass heading. I implemented most of the UI/UX including bearing display and the dial rotation, including bubble level and direction marking. What's missing is vibration (disallowed in safari) and GPS coordinates and some animations.
* 14 Jan 2024 - combined streaming server and tracking code in handstand experiment to mirror pose tracking across the network
* 14 Jan 2024 - streaming-server uses h2 and sse (server sent events) as an alternative to websockets.
6 Feb 2024
- canvas version of the Starlings murmurations inspired by https://twitter.com/JulianGarnier/status/1754495444896416025


5 Feb 2024
- Simple visualization to work out [earth, moon, and sun](earthmoonsunsim.html) relations

2 Feb 2024
- Added [true north](cosmos/compass_sun_north.html) for compass heading, updated compass sun position to include current angle
- Integrate "AR passthrough" for [sun path ar 2d](cosmos/sunpath_three_ar_2d.html), removed WebGL renderer

1 Feb 2024
- Added [color palette test](cosmos/skycolor.html) utilizing rgb, oklab and spectral interpolation

30 Jan 2024
- [sun path ar 2d](cosmos/sunpath_three_ar_2d.html) alternative implementation of sunpath ar but rendered on 2d canvas. this uses threejs for 3d calculations but not rendering.

28 Jan 2024
* updated Sun path viz with equal altitude spacing
* Initial implementation of AR sunpath using threejs, geolocation and device motion
* [sun path ar](cosmos/sunpath_three_ar.html) for mobile and [sun path three](cosmos/sunpath_three.html) for desktop experimentations
* [sun year path](cosmos/sunpath_three_year.html) - Sun's visualization path of the year
27 Jan 2024
- exploration of AR with compass direction. [threejs device orientation test](cosmos/compass_three_ar_orient_test.html)
26 Jan 2024
- [Compass with position](cosmos/compass_position.html), compass variant that uses geolocation for coordinates and altitude. Also combined sun positioning to show [compass with sun position](cosmos/compass_sun.html)
24 Jan 2024
 - JS based generation and visualizations of [sunrise and sunset tables](cosmos/suncharts.html). Explore the use of the suncalc libaries and [geolocation](cosmos/location.html) api.
23 Jan 2024
 - A JS canvas based implementation of the IOS [Compass app](cosmos/compass.html), utilizing device orientation event and webkit compass heading. I implemented most of the UI/UX including bearing display and the dial rotation, including bubble level and direction marking. What's missing are vibration (disallowed in safari) and GPS coordinates and some subtle animations. One improvement I have over Apple's implementation
  is that tapping the screen not only marks the change in direction, but gives the angle difference. This
  can be useful for just measuring differences in compass bearings.
14 Jan 2024
 - combined streaming server and tracking code in handstand experiment to mirror pose tracking across the network
14 Jan 2024
 - streaming-server uses h2 and sse (server sent events) as an alternative to websockets.

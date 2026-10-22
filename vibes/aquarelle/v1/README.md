# Aquarelle classic (v1)

The first Aquarelle interface, kept for side-by-side testing: tools on the left, size /
water / paint sliders, pigment wells along the bottom, menu, help card. It is the build
from commit `08ecf21` (the faster engine and white paper, before the Procreate-style
redesign, layers and pen mode). It keeps its own settings (`aquarelle-classic:settings`),
its own painting in IndexedDB (`aquarelle-classic`) and its own offline cache (`aqclassic-v1`),
so it does not touch paintings made in the current app at [`../`](../).

Since then it also has the fix for paint landing below the pen on Android (see the main
README) and a full screen button (top bar), with Menu → Full screen on first touch (on by
default on Android tablets and phones).

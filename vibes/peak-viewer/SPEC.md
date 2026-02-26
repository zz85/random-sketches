# Peak Viewer - AR Mountain Peak Identifier

## Project Overview
- **Project Name**: Peak Viewer
- **Type**: Mobile Web AR Application (iOS-optimized)
- **Core Functionality**: Uses device camera, GPS, and compass to identify and label mountain peaks in the user's view
- **Target Users**: Hikers, mountaineers, and outdoor enthusiasts in the Pacific Northwest (starting with Seattle area)

## UI/UX Specification

### Layout Structure
- **Full-screen camera view** as the primary interface
- **Peak labels** overlaid on camera view at correct compass bearing and elevation
- **Control panel** at bottom with:
  - Compass indicator (top-left)
  - Distance/elevation info panel (top-right)
  - Settings toggle (bottom-right request)
- **Permission screens** for camera, location, and motion sensors

### Responsive Design
- Mobile-first, portrait orientation optimized
- Full viewport utilization (100vw × 100vh)
- Touch-friendly controls (min 44px tap targets)

### Visual Design

**Color Palette**
- Background: Transparent (camera feed)
- Primary: `#00D4FF` (cyan - peak labels)
- Secondary: `#FF6B35` (orange - distance indicators)
- Accent: `#FFFFFF` (white - text with shadow)
- Panel Background: `rgba(0, 0, 0, 0.6)` (dark translucent)
- Success: `#4CAF50` (green - GPS locked)
- Warning: `#FF9800` (amber - calibration needed)

**Typography**
- Font Family: `'SF Pro Display', -apple-system, BlinkMacSystemFont, sans-serif`
- Peak Name: 16px, bold, white with black text-shadow
- Elevation: 14px, regular
- Distance: 12px, light
- Compass: 24px, bold

**Visual Effects**
- Peak labels: Semi-transparent background pill with blur
- Smooth transitions for label movement (60fps)
- Pulsing effect on GPS lock
- Compass rose with needle animation
- View cone indicator showing current FOV

### Components

1. **Camera View**
   - Full-screen video feed
   - Landscape orientation lock hint

2. **Peak Label**
   - Pill-shaped container
   - Peak name (bold)
   - Elevation in feet/meters
   - Distance in miles/km
   - Bearing indicator arrow
   - Opacity based on distance (closer = more opaque)

3. **Compass Rose**
   - Circular gauge
   - N/S/E/W indicators
   - Animated needle
   - Current heading in degrees

4. **Info Panel**
   - Current GPS coordinates
   - Altitude (from GPS)
   - Number of peaks in view
   - Signal strength indicator

5. **Permission Screens**
   - Icon + description for each permission
   - "Grant Permission" button
   - Skip option

6. **Settings Panel**
   - Distance unit toggle (mi/km)
   - Elevation unit toggle (ft/m)
   - Peak prominence threshold slider
   - Max distance slider
   - Debug mode toggle

## Functionality Specification

### Core Features

1. **Camera Integration**
   - Request rear camera access
   - Handle orientation changes
   - Fallback to static image if camera unavailable

2. **Geolocation**
   - Get current position with high accuracy
   - Watch position for updates
   - Handle permission denial gracefully
   - Show accuracy indicator

3. **Device Orientation**
   - Use DeviceOrientationEvent for compass heading
   - Request permission on iOS 13+
   - Handle magnetic declination for Seattle (≈15°E)
   - Smooth heading updates

4. **Peak Calculation**
   - Load pre-bundled peak dataset (Pacific Northwest)
   - Calculate bearing from user to each peak
   - Calculate distance using Haversine formula
   - Calculate elevation angle (is peak visible?)
   - Filter peaks by:
     - Maximum distance (configurable, default 100km)
     - Minimum prominence (configurable, default 100m)
     - Above horizon (using elevation angle)

5. **Label Positioning**
   - Map bearing to screen X position
   - Map elevation angle to screen Y position
   - Only show peaks within current FOV (±30°)
   - Z-order by distance (closest on top)

6. **Data Management**
   - Bundled JSON dataset of ~500 major peaks
   - Efficient binary search for peaks in range
   - Lazy load detailed data

### User Interactions

1. **Pan/Tilt Device**: Labels move to show peaks in new direction
2. **Tap Peak Label**: Expand to show more details
3. **Swipe Up/Down**: Adjust elevation offset
4. **Double Tap**: Recenter view
5. **Pinch**: Zoom view cone (FOV)

### Data Handling

- Pre-bundled peak dataset in JSON format
- Fields: name, lat, lon, elevation, prominence, coordinates
- Initial region: WA, OR, ID, MT (Cascade Range focus)
- Seattle default location: 47.6062° N, 122.3321° W

### Edge Cases

- No GPS signal: Show last known location, indicate uncertainty
- No compass: Allow manual bearing input
- Camera denied: Show map view fallback
- No peaks in view: Show "Point at mountains" message
- Poor accuracy: Show warning, increase label uncertainty

## Acceptance Criteria

1. ✓ App loads and requests permissions on iOS Safari
2. ✓ Camera feed displays full-screen
3. ✓ GPS location is obtained and displayed
4. ✓ Compass heading updates smoothly
5. ✓ Peak labels appear at correct positions
6. ✓ Labels move correctly when device is rotated
7. ✓ Distance and elevation shown for each peak
8. ✓ Works offline with bundled data
9. ✓ Settings persist across sessions
10. ✓ Performance: 60fps label rendering

## Technical Implementation

- Single HTML file with embedded CSS and JavaScript
- No external dependencies (pure vanilla JS)
- ES6+ features
- RequestAnimationFrame for smooth updates
- DeviceOrientationEvent API for compass
- Geolocation API for GPS
- getUserMedia for camera
- localStorage for settings

## Peak Data Source

Bundled dataset includes major peaks from:
- Washington Cascades (Mount Rainier, Adams, St. Helens, etc.)
- Olympic Mountains
- Oregon Cascades (Mount Hood, Three Sisters, etc.)
- Idaho peaks
- British Columbia peaks near border

Data format (JSON):
```json
{
  "name": "Mount Rainier",
  "lat": 46.8523,
  "lon": -121.7603,
  "elevation": 4392,
  "prominence": 4026,
  "state": "WA"
}
```

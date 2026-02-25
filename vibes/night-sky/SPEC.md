# Night Sky Identifier - Specification

## Project Overview
- **Project Name**: Night Sky Pointer
- **Type**: Mobile Web App (HTML5 + JS)
- **Core Functionality**: Augmented reality sky identifier that shows celestial objects when pointing phone at night sky
- **Target Users**: Stargazers, amateur astronomers, anyone curious about the night sky on iOS/Android

## UI/UX Specification

### Layout Structure
- **Fullscreen camera view** as background
- **Overlay UI** on top of camera showing celestial objects
- **Bottom control bar** with controls
- **Top status bar** showing location, time, and compass heading
- **Modal/panel** for object details when tapped

### Responsive Design
- Mobile-first, works in portrait and landscape
- Touch-friendly controls (min 44px tap targets)
- iOS Safari optimized

### Visual Design

#### Color Palette
- **Background**: Transparent (camera shows through)
- **Primary accent**: `#00D4FF` (cyan glow)
- **Secondary**: `#FF6B35` (warm orange for planets)
- **Star color**: `#FFFFFF` with glow
- **Moon**: `#F5F5DC` (cream/beige)
- **UI panels**: `rgba(10, 10, 20, 0.85)` (dark translucent)
- **Text primary**: `#FFFFFF`
- **Text secondary**: `#A0A0B0`
- **Success/active**: `#00FF88`

#### Typography
- **Font family**: "SF Pro Display", -apple-system, BlinkMacSystemFont, sans-serif
- **Headings**: 18px bold
- **Body**: 14px regular
- **Labels**: 12px medium
- **Object names**: 16px semibold

#### Spacing
- Base unit: 8px
- Panel padding: 16px
- Control buttons: 48px diameter
- Object labels: 8px padding

### Components

#### 1. Camera View
- Fullscreen video background
- Uses getUserMedia API with { facingMode: 'environment' } for rear camera
- Fallback to front camera if rear unavailable

#### 2. Celestial Object Markers
- Circular markers (24px) with object type icon
- Pulsing glow animation for bright objects
- Label showing object name below marker
- Tap to select and show details

#### 3. Compass Heading Display
- Top-left position
- Shows N/S/E/W + degrees (e.g., "NW 315°")
- Updates in real-time

#### 4. Location/Time Display
- Top-right position
- Shows city name (from geocoding) and current time
- Format: "San Francisco • 10:45 PM"

#### 5. Bottom Control Bar
- **Compass calibration button**: Circular button with compass icon
- **Search button**: Magnifying glass (future feature placeholder)
- **Settings gear**: Opens settings modal
- **Object filter toggle**: Show/hide specific object types

#### 6. Object Detail Panel
- Slides up from bottom when object tapped
- Shows: Name, type, magnitude, distance, rise/set times
- Close button (X) top-right

#### 7. Permission Request Screen
- Shown on first launch
- Explains why camera + location + motion needed
- Large "Enable" button
- Graceful fallback if denied

### Animations
- Object markers: Subtle pulse (scale 1.0 to 1.15, 2s ease-in-out infinite)
- Panel slide-up: 300ms ease-out
- Fade-in on load: 500ms
- Compass needle: Smooth rotation (no animation, real-time)

## Functionality Specification

### Core Features

#### 1. Device Orientation (Critical)
- Uses DeviceOrientationEvent API
- Requests permission on iOS 13+ (button trigger)
- Tracks: alpha (compass), beta (tilt), gamma (rotation)
- Calculates device heading (0-360°)
- Updates at 60fps via requestAnimationFrame

#### 2. Geolocation
- Gets user lat/long via Geolocation API
- Accurate to city level needed
- Updates on app resume

#### 3. Celestial Position Calculation
- Uses astronomical algorithms to calculate positions of:
  - **Moon**: Phase, altitude, azimuth
  - **Planets**: Mercury, Venus, Mars, Jupiter, Saturn (visible ones)
  - **Major Stars**: ~50 brightest stars with names
  - **Constellation lines**: Optional overlay
- Calculations based on: current time + user lat/long
- Altitude (0-90° above horizon), Azimuth (0-360°)

#### 4. Object Filtering
- Filter by: Planets, Stars, Moon, Constellations
- Toggle visibility per category
- Persists preference in localStorage

#### 5. iOS Specific Handling
- DeviceOrientationEvent permission request
- Fullscreen meta tag for standalone mode
- Prevent viewport zoom on input focus
- Handle safe area insets

### Data Handling
- All calculations client-side (no API calls for positions)
- User location stored in memory only (not persisted)
- Preferences in localStorage

### Edge Cases
- Location denied: Show manual location input or default to lat/long
- Orientation denied: Show "point your phone up" instruction
- Camera denied: Show static star map background
- No objects in view: Show "No objects in view - try looking at different direction"
- Daytime: Show sun position + "Best at night" message

## Technical Implementation

### Libraries (CDN)
- **No external libraries** - Pure vanilla JS for performance
- All celestial calculations implemented in-app

### Celestial Calculation Formulas
- Use simplified solar system algorithms
- Julian Date calculation
- Right Ascension / Declination conversion
- Local Sidereal Time
- Altitude/Azimuth from RA/Dec + lat/long

### File Structure
```
index.html - Single file app (HTML + CSS + JS inline for simplicity)
```

## Acceptance Criteria

### Must Work
- [ ] Camera displays fullscreen on mobile
- [ ] Device orientation controls view direction
- [ ] At least 5 bright stars visible and labeled
- [ ] Moon position accurate (check phase)
- [ ] At least 3 planets visible (when in sky)
- [ ] Tap on object shows detail panel
- [ ] Works on iOS Safari (with permission flow)
- [ ] Works on Android Chrome

### Visual Checkpoints
- [ ] Dark translucent UI panels readable
- [ ] Object markers visible against night sky
- [ ] Compass heading accurate
- [ ] Smooth 60fps performance
- [ ] Touch targets adequately sized

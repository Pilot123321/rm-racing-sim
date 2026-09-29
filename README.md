# RM Racing Sim

A browser F1 simulator built around a helmet-visor HUD concept: it uses the position data every car already
sends to show danger in the next two or three corners (stopped cars, recovery vehicles, marshals, cars hidden by
spray or a barrier), paired with a visor light that says "danger, now" without the driver looking.

It is a playable sim: a Grand Prix circuit in daylight (grandstands, pit building, grass run-off, gravel traps,
guardrails, light towers), a car whose tyres, brakes, aero and surfaces are modelled from real data, rain and
fog, online multiplayer, and a phone (iPhone or Android) that works as the steering wheel.

### What's in it

- **Visor HUD**: light-only (screen-blended) outlines, a perspective road ribbon with cars
  to scale, wheel-to-wheel gaps, hazard warnings, lane guidance and a visor light.
- **Scenarios**: free drive with traffic (press X to hide a hazard past the next blind corner),
  plus three situations modelled on Paletti 1982, Pryce 1977 and Bianchi 2014 / Gasly 2022.
- **Circuit builder**: upload a map or photo of a circuit, or draw one, and the track, 3D
  street and HUD are rebuilt from it.
- **On-board radar**: a simulated 77 GHz radar in the nose, alongside the position feed. It is
  blocked by barriers and cars, loses range in rain, spray and (barely) fog, and its tracks show on the HUD as teal diamonds.
- **Spray**: every car throws a plume from its rear tyres that grows with speed (about 5 m at 150 km/h and
  10 m at 300 km/h). Following in it blurs your view, puts droplets on the visor, thickens the fog and costs
  downforce (dirty air).
- **Wet track**: the rain setting darkens the asphalt and lays a water film on it; puddles (world-space noise,
  deeper at the edges where the camber drains, thinner on the rubbered racing line) go mirror-smooth and ring with
  rain drops.
- **Car behind**: thin flat flashes on the side a car is closing from, within 50 m.
- **Engine sound**: loops cut from real V8 recordings (a Maserati V8 and the Bentley Speed 8 Le Mans car), pitched
  to the physics rpm and crossfaded by rpm and throttle, with upshift cuts, overrun crackle and the nearest car
  panned with Doppler.
- **Phone wheel**: tilt a phone (iPhone or Android) to steer; gas and brake are slides on the sides (a long gas
  travel for fine throttle, a short brake). The sim's steering wheel turns exactly as far as the phone. The phone
  shows the game screen's HUD layout with the track edges (no 3D picture). Force feedback comes from the tyres
  through the vibration motor: impacts (scaled by severity), lock-ups, kerbs, wheelspin and slides, front scrub,
  and a steering-weight hum that fades as the front goes light.

- **Layout**: the sim fills the window; Setup, Phone and Circuit open as tabs over it. The game screen stays
  clean (gear and speed); boxes, call signs and the radar live on the phone, or on the PC with the
  Visor HUD button (V).
- **2D radar**: flat, heading-up proximity radar (like iRacing's) with range rings, call signs, side bars when a car
  is alongside, and yellow/red flag sectors.
- **Flags**: ~200 m marshal sectors go yellow around a hazard and red when it blocks the track or a marshal is
  running across; the autopilot drops to VSC pace through red.
- **Pairing**: phones pair through the key in the QR code; phones over USB need none.
- **Circuits from screenshots**: drop a screenshot anywhere on the page or paste it (Cmd+V).

### On the web

The simulator runs entirely in the browser (the physics is WebAssembly), so it can be deployed on Vercel as is
(`vercel.json`: serves `public/`, `/` opens the game). Phones and multiplayer rooms go through a WebSocket relay
function (`api/ws.js`) with a private room code, so no home IP is ever exposed. The relay works within one server
instance; set `REDIS_URL` (any Redis, e.g. from the Vercel Marketplace) to relay across instances when many people
use the site at once. The local server below works for Wi-Fi and USB.

### Run it

Requires Node.js 18+. The physics core is prebuilt (`public/physics.wasm`), so this is enough:

    npm install
    npm start

To change the physics you need Python 3 (for the Zig C compiler from pip):

    npm run setup:physics    # .venv with ziglang + numpy
    npm run build:physics    # physics/*.c -> public/physics.wasm (+ build/libphysics for tests)
    npm test                 # build, then check the C against Python reference models

- Game on the computer: http://localhost:8080
- Phone over Wi-Fi: scan the QR code in the "Phone wheel" panel. Accept the self-signed
  certificate warning once (the gyro needs https). Some campus and office networks block
  devices from reaching each other; use a phone hotspot or USB instead.
- Phone over USB: enable USB debugging, plug in, open http://localhost:8080/wheel on the
  phone. The server runs `adb reverse` automatically.

Keyboard: W/↑ throttle, S/↓/Space brake, A/D steer, X drop hazard, C camera, N HUD size,
+/- HUD range, [ ] traction control, ; ' ABS, , . brake balance, Esc stop. With a keyboard, "Keyboard brake:
Driver's foot" (Setup) presses the pedal like a driver would: hardest at speed, easing as downforce fades.

### Code layout

- `physics/*.c` (C): the car (`vehicle.c`), the 77 GHz radar sensor and tracker (`radar.c`), tyre spray (`spray.c`).
- `physics/*.cpp` (C++): the track (`track.cpp`: smoothing, curvature, corners, barriers, racing line,
  speed profile, line of sight, standing water) and the screenshot tracer (`trace.cpp`: colour mask, thinning, loop walk).
  C and C++ compile into one WebAssembly module, `public/physics.wasm`, and a native library for the tests.
- `tools/` (Python): `build.py` compiles the core with Zig; `test_physics.py` checks it against numpy reference
  models and real-world figures; `physics.py` is the ctypes binding.
- `public/css/` (CSS): all styling, including the spray-on-visor blur and the car-behind edge glow.
- `public/js/game.js`, `public/js/wheel.js`: scene, driver model, HUD drawing and UI (three.js), talking to the
  core. `public/game.html` and `public/wheel.html` are markup only.

### Radar

`physics/radar.c` works from the radar range equation: 12 dBm output, 25 dBi far beam (±9°) and 16 dBi near
beam (±45°), 14 dB noise figure, 15 dB losses, and 5 ms coherent frames. On top of that it models:

- rain attenuation in the ITU-R P.838 form, plus a wet radome
- rain clutter, and extra loss through spray plumes
- two-ray reflection off the road
- Swerling-1 targets behind a CFAR detector, with detection probability Pd = Pfa^(1/(1+SINR))
- measurement noise that depends on SNR, merging of targets that fall in the same resolution cell, and
  returns from the barriers
- a Kalman tracker

What the radar can reach is decided by the scene: barriers and cars block it. Results: a car at
about 275 m in the dry, 190 m at 60 % rain and 150 m in a downpour; a person at about 110 m in rain.

### Physics

Your car is a dynamic bicycle model in track coordinates (Liniger, Domahidi & Morari 2015) with:
- wheel-speed dynamics per axle: rear-wheel drive through an 8-speed gearbox (engine inertia
  reflected through the gear), brakes on both axles, so wheelspin and lock-ups happen
- combined-slip Magic Formula tyres, "theoretical slip" form (Pacejka, *Tire and Vehicle Dynamics*,
  2012; as used by Velenis, Tsiotras & Lu 2007), with a sliding-friction floor for locked or
  drifting tyres
- tyre load sensitivity, lateral and longitudinal load transfer, aero downforce and drag,
  tyre relaxation length, aquaplaning, slippery wet kerbs
- drift equilibria as in Hindiyeh & Gerdes 2014: power holds the rear slip, countersteer balances it
- tyres peak at ~7° slip angle and 13-15 % slip ratio, like racing slicks; five compounds with tread
  temperature, wear and water (soft, medium, hard, intermediate, wet)
- brakes (brake-by-wire): an adjustable brake balance; front and rear carbon discs, each with a friction
  surface that heats within a stop and a core it conducts into, duct cooling ~v^0.8 (turbulent forced
  convection) plus radiation; pad friction from the surface temperature (little bite cold, full from
  ~400 °C, fade past 1000 °C); the MGU-K harvests up to 120 kW on the rear axle; a locked tyre wears a
  flat spot that then thumps once a revolution
- traction control and ABS as set in Setup, 0 (off) to 12 like a motorsport rotary switch, or a custom
  map (slip target and response); [ ] ; ' , . change TC, ABS and brake balance on the move. TC holds
  the rears at a slip target by cutting torque through the ignition; ABS releases, holds and reapplies
  each axle's pressure from wheel slip and deceleration (cycling at ~5-15 Hz). Both lower their target
  as the tyre's lateral slip grows (friction circle). No stability control: F1 cars have none.
- each axle on its own surface: ridged kerbs, grass run-off (grip ~0.45 dry, ~0.2 wet, sinking in a
  little) and gravel traps (a fast car skims the bed, a slow one digs in); bumps make the tyre load
  flutter; grass and grit in the tread cost grip back on the asphalt until they scrub off; turf and stones
  fly from the tyres. A 1.1 m steel guardrail stands behind the run-off: you see over it, the nose radar
  does not
- clear-day visibility ~12 km, less with falling rain (optical rain attenuation), spray mist and fog
- sound: tyre squeal from the slip at each axle (a CC BY loop, credits in `public/assets/tyres`), off-road
  rumble and gravel crunch
- fog: the slider sets the visibility (meteorological optical range); contrast falls as Beer-Lambert,
  and the radar's fog loss follows ITU-R P.840 (under 1 dB over its range even in thick fog)
- checked against real figures in `tools/test_physics.py`: Monza turn 1 braking (Brembo: 337 -> 89 km/h in
  2.75 s / 129 m, ~5-6 g), cornering ~2 g slow to ~4 g fast, 0-100 km/h ~2.3 s, locked-wheel stops on grass
  (Cenek et al.), decelerations in a gravel bed, fog attenuation (ITU-R P.840)

### Multiplayer

Setup → Race online: pick a name, make a new room (or type a friend's code) and join. Everyone in the room races
on the same circuit, with the AI traffic off. On this Wi-Fi, friends open this computer's address (the local server
relays the room); on the website the Vercel relay does, from anywhere (rooms spanning several server instances need
Redis). Each game sends its car ~20 times a second and dead-reckons the others between messages. Crashes between
drivers are rigid-body impulses on the cars' real footprints (separating-axis contact, equal masses, restitution
0.25, bodywork friction 0.5, spin from off-centre hits); both drivers feel the hit, and a hard one ends the run.

### Car model

Other cars and your car in the chase view use a real F1 2022 model (`public/assets/f1.glb`),
merged by material at load time and repainted per team. The driver's-eye view uses the
procedural cockpit (`public/f1car.js`). Swap in any glTF you are licensed to use at the same
path; if it faces the wrong way add `public/assets/f1.json` with `{"yaw": 180}`.

### Credits

- F1 2022 car model by Blender458 (https://sketchfab.com/Blender458), CC BY 4.0
  (https://creativecommons.org/licenses/by/4.0/), obtained via FetchCFD. Unmodified; scaled and
  recoloured at runtime.
- Asphalt "asphalt_track" and concrete "brushed_concrete" by Poly Haven, CC0
- Tyre squeal loop by Tom Haigh (audible-edge on freesound), via OpenGameArt, CC BY 3.0
  (`public/assets/tyres/CREDITS.txt`)
- three.js r128 and its example add-ons, MIT licence (`public/vendor/`)
- Engine sound: loops cut from real V8 recordings (`tools/engine_samples.py`, `public/assets/engine/CREDITS.txt`):
  Maserati GranTurismo S exhaust by lmartins (freesound 465453), CC BY 4.0 (idle, low revs, free revving), and
  Bentley Speed 8 (2003) by Edvvc on Wikimedia Commons, CC BY-SA 3.0 (full load; the derived `load.wav` keeps
  that licence)

### Files

- `server.js`: static server, WebSocket relay between phone and game and between racers, QR codes,
  self-signed cert, adb reverse
- `api/ws.js`: the same relay as a Vercel function (phone rooms and race rooms)
- `public/game.html`: the simulator scene, driver model and HUD (three.js); physics in `physics/*.c`
- `public/f1car.js`: the procedural F1 car model (cockpit, carbon weave, halo)
- `public/wheel.html`: the phone steering-wheel controller

The simulation is a simplified model for demonstrating the idea, not a reconstruction of real accidents.

### Contributing

Fork and open a pull request. Keep `certs/` out of commits (it holds the local HTTPS key; `.gitignore`
already excludes it).

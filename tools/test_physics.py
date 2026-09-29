"""Checks the C physics core against independent numpy reference models and against real-world figures.

    .venv/bin/python tools/test_physics.py            # asserts + a short report

Radar: the link budget is recomputed here from the textbook radar equation and must match the C to 1e-9, and
detection ranges must land where long-range 77 GHz sensors do (~250 m for a car in the dry, ~100 m for a person).
Spray: a reference mist droplet in the wake is integrated with RK4 as a sanity check of the wake model; the C
plume must climb with speed to 5-10 m at 200-300 km/h. Vehicle: top speed, braking and cornering in F1 ranges.
"""
import math
import numpy as np
from physics import LIB, VEH_FIELDS

ok = True
def check(cond, msg):
    global ok
    print(("  ok   " if cond else "  FAIL ") + msg)
    ok &= bool(cond)

# ---------------- radar ----------------
print("Radar (77 GHz FMCW)")
F0, PT, LSYS, NF, TF, B, PFA, HR, GAM = 76.5e9, 0.016, 10 ** 1.5, 10 ** 1.4, 0.005, 600e6, 1e-6, 0.35, -0.65
LAM = 3e8 / F0
K = PT * LAM ** 2 / ((4 * np.pi) ** 3 * LSYS * 1.380649e-23 * 290 * NF / TF)
G_FAR, HALF, BWA, EL, DR = 10 ** 2.5, np.radians(9), np.radians(2.2), np.radians(5), 3e8 / (2 * B)

def rain_db(rain):                         # ITU-R P.838 form, k≈1, α≈0.72 at 77 GHz, dB/km one way
    rr = 50 * rain ** 2 + 8 * rain
    return rr ** 0.72 if rr > 0 else 0.0

def two_ray(R, hts):
    ph = 4 * np.pi * HR * np.asarray(hts) / (LAM * R)
    F = np.abs(1 + GAM * np.exp(-1j * ph)) ** 2
    return np.mean(F ** 2)

def sinr_ref(r, az, sigma, hts, loss_db, rain):
    g = G_FAR * math.exp(-0.6925 * (az / HALF) ** 2)
    rad = 10 ** (-(4 * rain) / 10)
    S = K * g * g * sigma * two_ray(r, hts) * rad * 10 ** (-(loss_db + 2 * rain_db(rain) * r / 1000) / 10) / r ** 4
    eta = 3.6e-6 * (50 * rain ** 2 + 8 * rain)
    C = K * g * g * eta * (r * r * BWA * EL * DR * np.pi / 4) * rad * 10 ** (-(2 * rain_db(rain) * r / 1000) / 10) / r ** 4
    return S / (1 + C)

worst = 0
for r in [20, 60, 120, 180, 240]:
    for rain in [0, 0.5, 1]:
        for az in [0, 0.05, -0.12]:
            c = LIB.radar_sinr(r, az, 10, 0.25, 0.5, 0.8, 1.5, rain)
            if LIB.radar_out()[0] != 0: continue
            ref = sinr_ref(r, az, 10, [0.25, 0.5, 0.8], 1.5, rain)
            worst = max(worst, abs(c - ref) / ref)
check(worst < 1e-9, f"C link budget matches the numpy radar equation (max rel. error {worst:.1e})")

def range_pd(sigma, hts, rain, pd=0.9):
    need = math.log(PFA) / math.log(pd) - 1
    for r in np.arange(300, 5, -1.0):
        if LIB.radar_sinr(r, 0, sigma, *hts, 0, rain) >= need and LIB.radar_out()[0] >= 0: return r
    return 0

car_dry, car_wet, car_storm = (range_pd(10, (0.25, 0.5, 0.8), x) for x in (0, 0.6, 1))
person = range_pd(0.7, (0.5, 1.0, 1.5), 0.6)
print(f"       Pd 0.9 range, 10 m² car: dry {car_dry:.0f} m, rain 60% {car_wet:.0f} m, rain 100% {car_storm:.0f} m; marshal (0.7 m², 60%) {person:.0f} m")
check(200 <= car_dry <= 280, "a car is seen at 200-280 m in the dry (long-range radar datasheets: ~250 m)")
check(car_storm < car_wet < car_dry, "rain shortens the range")
check(60 <= person <= 140, "a person is seen at 60-140 m in rain (typical pedestrian range ~100 m)")
check(abs(LIB.radar_range90(0) - min(car_dry, 250)) < 20, "radar_range90 agrees with the brute-force search")
rb = 4 * HR * 0.5 / LAM
far = LIB.radar_two_ray(rb * 10, 0.5, 0.5, 0.5)
check(far < 0.1, f"road multipath: {10*math.log10(far):.1f} dB at 10× the break range {rb:.0f} m (returns fall off faster than R⁻⁴)")

# tracker: a car 120 m ahead closing at 20 m/s is confirmed within 5 scans and its speed estimated
LIB.radar_seed(7)
tx, tz, dt, conf, est = 0.0, 120.0, 1 / 15, False, None
for k in range(30):
    tz -= 20 * dt
    LIB.radar_begin()
    LIB.radar_return(tz, 0.0, -20.0, 10, 0.25, 0.5, 0.8, 0, 0.3, 1, 0)
    LIB.radar_resolve(0, 0, 0, 1, 0, 0)
    n = LIB.radar_track(dt, 0, 0, 0, 0)
    T = LIB.radar_tracks()
    for i in range(n):
        if T[i * 12 + 5] > 0: conf = conf or k < 5; est = (T[i * 12 + 2], T[i * 12 + 4])
check(conf, "tracker confirms the car within 5 scans")
check(est is not None and abs(est[1] + 20) < 1.0 and abs(est[0] - tz) < 1.0, f"track position/speed within 1 m, 1 m/s (z {est[0]:.1f} vs {tz:.1f}, vz {est[1]:.2f})")

# ---------------- spray ----------------
print("Spray")
# one mist droplet (d = 60 µm) in the wake of a car at 250 km/h: numpy RK4 of dv/dt = (u - v)/τ + g
v_car, d = 250 / 3.6, 60e-6
vt = LIB.spray_vt(d); tau = vt / 9.81; w0 = 0.09 * v_car
def rhs(t, y):
    uy = w0 * math.exp(-t / 1.4)
    return np.array([y[1], (uy - y[1]) / tau - 9.81])
y, t, h, top = np.array([0.0, 0.0]), 0.0, 1e-4, 0.0
while t < 3.0:
    k1 = rhs(t, y); k2 = rhs(t + h / 2, y + h / 2 * k1); k3 = rhs(t + h / 2, y + h / 2 * k2); k4 = rhs(t + h, y + h * k3)
    y = y + h / 6 * (k1 + 2 * k2 + 2 * k3 + k4); t += h; top = max(top, y[0])
check(0.75 < top / (w0 * 1.4) < 1.0, f"reference mist droplet rises {top:.1f} m, just under the upwash integral w0·T = {w0*1.4:.1f} m (settling + lag)")
check(abs(LIB.spray_vt(1e-3) - 3.9) < 0.6 and abs(LIB.spray_vt(1e-4) - 0.3) < 0.1, "terminal velocities: 1 mm ≈ 4 m/s, 0.1 mm ≈ 0.3 m/s (Gunn & Kinzer)")

heights = {}
for kmh in [100, 150, 200, 250, 300]:
    LIB.spray_clear(); v = kmh / 3.6; z = 0.0
    for k in range(int(3.0 / 0.016)):
        z += v * 0.016
        for side in (-0.8, 0.8):
            LIB.spray_emit(6, side, 0.3, z - 1.9, 0.0, v, 0.0)
        LIB.spray_update(0.016, 0.8)
    heights[kmh] = LIB.spray_height_q(0.95)
print("       95th-percentile mist height: " + ", ".join(f"{k} km/h {h:.1f} m" for k, h in heights.items()))
hs = list(heights.values())
check(all(b > a for a, b in zip(hs, hs[1:])), "the plume gets taller the faster the car goes")
check(all(5 <= heights[k] <= 10.5 for k in (200, 250, 300)), "5-10 m of spray at 200-300 km/h")

# fog: ITU-R P.840 coefficient against the Recommendation's own curve at 0 °C, and the radar barely notices thick fog
kl = [LIB.radar_fog_kl(f, 273.15) for f in (10, 30, 100)]
check(0.07 < kl[0] < 0.12 and 0.6 < kl[1] < 0.95 and 4.2 < kl[2] < 5.5, f"fog Kl at 0 °C: {kl[0]:.2f}, {kl[1]:.2f}, {kl[2]:.2f} dB/km per g/m³ at 10, 30, 100 GHz (ITU-R P.840: ~0.1, ~0.8, ~5)")
LIB.radar_set_fog(0.5, 15); fdb = 2 * LIB.radar_fog_db() * 0.25; LIB.radar_set_fog(0, 15)
check(fdb < 1.0, f"thick fog (0.5 g/m³, ~50 m visibility) costs the 77 GHz radar {fdb:.2f} dB two-way over 250 m")

# ---------------- vehicle ----------------
print("Vehicle")
N = 4000
curv = LIB.veh_curv()
for i in range(N): curv[i] = 0.0
LIB.veh_set_track(N, 2.0)
st = LIB.veh_state(); ix = {n: i for i, n in enumerate(VEH_FIELDS)}
def reset(v):
    for i in range(len(VEH_FIELDS)): st[i] = 0.0
    st[ix["vx"]] = v; LIB.veh_reset()
reset(10); st[ix["thr"]] = 1
for k in range(60 * 120): LIB.veh_step(1 / 120, 1.5, 0, 1, 6.6)
check(300 <= st[ix["v"]] * 3.6 <= 360, f"top speed {st[ix['v']]*3.6:.0f} km/h (F1: ~320-350)")
reset(300 / 3.6); st[ix["brk"]] = 1; x0 = st[ix["s"]]; st[ix["v"]] = 300 / 3.6
while st[ix["v"]] > 100 / 3.6: LIB.veh_step(1 / 120, 1.5, 0, 1, 6.6)
dist = st[ix["s"]] - x0
check(60 <= dist <= 140, f"300→100 km/h braking in {dist:.0f} m (F1 dry: ~80-110 m)")
ay = 0
for steer in [0.02, 0.04, 0.06, 0.08, 0.12]:          # sweep the steering until the tyres saturate
    reset(250 / 3.6); st[ix["thr"]] = 0.5
    for k in range(120 * 2):
        LIB.veh_step(1 / 120, 1.5, steer, 1, 1e4)
        ay = max(ay, abs(st[ix["ay"]]))
check(3.5 <= ay / 9.81 <= 5.5, f"peak lateral {ay/9.81:.1f} g at 250 km/h (real F1 ~4-5 g in fast corners)")

# Monza turn 1 (Brembo, 2022): 337 -> 89 km/h in 2.75 s over 129 m at ~5-6 g peak. Here with hot brakes and full
# pedal (no ABS): the car should match it closely (drivers ease off towards the corner, so real is a little longer)
LIB.veh_set_control(6, 0); reset(337 / 3.6); st[ix["v"]] = st[ix["vx"]]
for f in ("brakeT", "brakeTR", "bCoreF", "bCoreR"): st[ix[f]] = 550
st[ix["brk"]] = 1; x0 = st[ix["s"]]; tb = 0; pk = 0
while st[ix["v"]] > 89 / 3.6: vp = st[ix["v"]]; LIB.veh_step(1 / 120, 1.5, 0, 1, 6.6); tb += 1 / 120; pk = max(pk, (vp - st[ix["v"]]) * 120 / 9.81)
db = st[ix["s"]] - x0; LIB.veh_set_control(6, 6)
check(2.0 < tb < 3.2 and 100 < db < 145 and 4.5 < pk < 6.8, f"Monza T1 stop 337->89 km/h: {tb:.2f} s, {db:.0f} m, peak {pk:.1f} g (Brembo: 2.75 s, 129 m, ~5-6 g)")
# trail braking: a little brake held into the turn-in loads the fronts and rotates the car more, without a spin
def turn_in(brk):
    reset(180 / 3.6); st[ix["v"]] = st[ix["vx"]]; st[ix["brk"]] = brk; bmax = 0
    for k in range(90): LIB.veh_step(1 / 120, 1.5, 0.035, 1, 1e4); bmax = max(bmax, abs(np.arctan2(st[ix["vy"]], max(st[ix["vx"]], 1))))
    return st[ix["r"]], np.degrees(bmax)
(r0, b0), (r3, b3) = turn_in(0), turn_in(0.3)
check(r3 > r0 and b3 < 8, f"trail braking at 180 km/h: yaw rate {r3:.2f} rad/s with 30 % brake vs {r0:.2f} without, slide {b3:.1f} deg")
st[ix["brk"]] = 0

# aquaplaning: deeper water brings the onset down; in a 1 mm film nothing happens at race speed
def aqua_at(kmh, mm):
    LIB.veh_set_water(mm); reset(kmh / 3.6); st[ix["thr"]] = 0.5
    for k in range(12): LIB.veh_step(1 / 120, 1.2, 0.0, 1, 1e4)
    return st[ix["aqua"]]
a1, a4, a4s = aqua_at(290, 1.0), aqua_at(290, 4.0), aqua_at(120, 4.0)
check(a1 < 0.05 and a4 > 0.3 and a4s < 0.05, f"aquaplaning at 290 km/h: {a1:.2f} in a 1 mm film, {a4:.2f} in 4 mm; at 120 km/h in 4 mm: {a4s:.2f}")
def brake_dist(mm):
    LIB.veh_set_water(mm); reset(280 / 3.6); st[ix["brk"]] = 1; st[ix["v"]] = 280 / 3.6; x0 = st[ix["s"]]
    while st[ix["v"]] > 100 / 3.6: LIB.veh_step(1 / 120, 1.1, 0, 1, 6.6)
    return st[ix["s"]] - x0
d0, d4 = brake_dist(0), brake_dist(4.0)
check(d4 > d0 * 1.05, f"wet braking 280→100 km/h: {d0:.0f} m on a thin film, {d4:.0f} m through 4 mm of standing water")
LIB.veh_set_water(0)

# front-tyre spray at 250 km/h: tread pick-up climbs a few metres beside the car, the bow wave stays low
LIB.spray_clear(); v = 250 / 3.6; z = 0.0
for k in range(int(2.0 / 0.016)):
    z += v * 0.016
    for side in (-1, 1): LIB.spray_emit_tyre(8, side * 0.8, 0.3, z + 1.9, 0.0, v, side, 0.0, 0.0)
    LIB.spray_update(0.016, 0.8)
fh = LIB.spray_height_q(0.95)
check(1.0 <= fh <= 6.0, f"front-tyre mist reaches {fh:.1f} m at 250 km/h (lower than the rear plume)")

# reverse: from a standstill with reverse engaged the car backs up, and tops out at a crawl
reset(0); st[ix["rev"]] = 1; st[ix["thr"]] = 1
for k in range(120 * 4): LIB.veh_step(1 / 120, 1.4, 0, 1, 1e4)
check(-12 < st[ix["vx"]] < -4, f"reverse: {st[ix['vx']]*3.6:.0f} km/h after 4 s on full reverse throttle")
st[ix["rev"]] = 0

# steering feel: aligning torque rises with steering, peaks, then drops while lateral grip is still building
mz, fy = [], []
for steer in np.linspace(0.005, 0.2, 24):
    reset(150 / 3.6); st[ix["thr"]] = 0.3
    for k in range(120): LIB.veh_step(1 / 120, 1.5, steer, 1, 1e4)
    mz.append(abs(st[ix["mz"]])); fy.append(st[ix["gripF"]])
kmz, kfy = int(np.argmax(mz)), int(np.argmax(fy))
check(0 < kmz < kfy, f"self-aligning torque peaks (step {kmz}) before front grip does (step {kfy}): the wheel goes light before the front slides")

# tyre compounds: grip follows the tread temperature window, wear and water (0 soft, 1 medium, 2 hard, 3 inter, 4 wet)
def fit(c, v, T=None, wear=0.0):
    reset(v); LIB.veh_set_compound(c)
    if T is not None: st[ix["tempF"]] = st[ix["tempR"]] = T
    st[ix["wearF"]] = st[ix["wearR"]] = wear
def peak_ay(c, T, wear=0.0):
    LIB.veh_set_water(0); ay = 0
    for steer in [0.02, 0.04, 0.06, 0.08, 0.12]:
        fit(c, 250 / 3.6, T, wear); st[ix["thr"]] = 0.5
        for k in range(120 * 2):
            LIB.veh_step(1 / 120, 1.5, steer, 1, 1e4); ay = max(ay, abs(st[ix["ay"]]))
    return ay / 9.81
def corner(c, steer, water, mu, secs=90, v0=180):          # a long steady corner at constant speed
    LIB.veh_set_water(water); fit(c, v0 / 3.6)
    for k in range(int(120 * secs)):
        st[ix["thr"]] = min(1, max(0, 0.3 + 0.1 * (v0 / 3.6 - st[ix["v"]])))
        LIB.veh_step(1 / 120, mu, steer, 1, 1e4)
    return st[ix["tempF"]], st[ix["tempR"]], st[ix["tyreF"]]
aS, aM, aH = peak_ay(0, 95), peak_ay(1, 105), peak_ay(2, 115)
check(aS > aM > aH, f"in their windows softs grip most: {aS:.2f} g soft, {aM:.2f} g medium, {aH:.2f} g hard")
aSc = peak_ay(0, 40)
check(aSc < 0.85 * aS, f"cold softs slide: {aSc:.2f} g at 40 °C against {aS:.2f} g at 95 °C")
aSw = peak_ay(0, 95, 0.8)
check(aSw < 0.85 * aS, f"worn softs (80 % of the tread gone) grip less: {aSw:.2f} g")
tS, tH, tW = corner(0, 0.045, 0, 1.5), corner(2, 0.045, 0, 1.5), corner(4, 0.045, 0, 1.5)   # near the car's cornering limit
check(tS[0] > 95 - 22 and tH[0] < 115 - 22, f"pushed hard in the dry, softs reach their window ({tS[0]:.0f} °C) and hards stay cold ({tH[0]:.0f} °C)")
check(max(tW[:2]) > 60 + 35, f"wets overheat on a dry track ({tW[0]:.0f}/{tW[1]:.0f} °C, window 60 °C)")
mR, iR, wR = corner(1, 0.02, 1.5, 1.0), corner(3, 0.02, 1.5, 1.0), corner(4, 0.02, 1.5, 1.0)
check(mR[0] < 105 - 25 and mR[2] < iR[2] < wR[2], f"in 1.5 mm of water slicks go cold ({mR[0]:.0f} °C); grip factor slick {mR[2]:.2f} < inter {iR[2]:.2f} < wet {wR[2]:.2f}")
def aqua_c(c):
    LIB.veh_set_water(2.0); fit(c, 200 / 3.6); st[ix["thr"]] = 0.5
    for k in range(12): LIB.veh_step(1 / 120, 1.2, 0.0, 1, 1e4)
    return st[ix["aqua"]]
qS, qW = aqua_c(1), aqua_c(4)
check(qS > 0.5 and qW < 0.05, f"slicks aquaplane at 200 km/h in 2 mm of water ({qS:.2f}), full wets do not ({qW:.2f})")
# carbon brakes: a heavy stop takes the discs into the visible glow (~550 °C+); the ducts cool them on the straight
LIB.veh_set_water(0); fit(1, 320 / 3.6, 95); st[ix["v"]] = st[ix["vx"]]; st[ix["brakeT"]] = 60; st[ix["brk"]] = 1; peak = 0
while st[ix["v"]] > 90 / 3.6: LIB.veh_step(1 / 120, 1.5, 0, 1, 6.6); peak = max(peak, st[ix["brakeT"]])
st[ix["brk"]] = 0; st[ix["thr"]] = 1
for k in range(120 * 6): LIB.veh_step(1 / 120, 1.5, 0, 1, 6.6)
check(550 < peak < 1100 and st[ix["brakeT"]] < 0.6 * peak, f"brake discs: {peak:.0f} °C after 320→90 km/h, {st[ix['brakeT']]:.0f} °C six seconds later")
# traction control: on a wet (mu 0.8) launch at full throttle the rears spin up without it; with it the slip is
# held at the level's target (20 % at level 1 down to 6 % at 12) by cutting torque, and the car pulls away faster
def launch(tc, mu=0.8):
    LIB.veh_set_control(tc, 6); LIB.veh_set_water(0); fit(1, 60 / 3.6, 105); st[ix["v"]] = st[ix["vx"]]; st[ix["thr"]] = 1; ks = []
    for k in range(240): LIB.veh_step(1 / 120, mu, 0, 1, 1e4); ks.append(st[ix["kr"]])
    return st[ix["v"]] * 3.6, float(np.mean(ks[60:]))
(v0, k0), (v6, k6), (v12, k12) = launch(0), launch(6), launch(12)
t6, t12 = LIB.veh_tc_target(6), LIB.veh_tc_target(12)
check(k0 > 1 and abs(k6 - t6) < 0.05 and abs(k12 - t12) < 0.03 and v6 > v0,
      f"TC: wet launch slip {k0:.2f} off, {k6:.2f} at level 6 (target {t6:.2f}), {k12:.2f} at 12 (target {t12:.2f}); {v0:.0f} vs {v6:.0f} km/h after 2 s")
# power oversteer: full throttle at a corner exit (~1 g, 113 km/h). Without TC the rear lets go and the car spins;
# TC lowers its slip target as the rear's lateral slip grows (friction circle) and holds a small, catchable slide
import math
def power_corner(tc):
    LIB.veh_set_control(tc, 6); LIB.veh_set_water(0); fit(1, 113 / 3.6, 95); st[ix["v"]] = st[ix["vx"]]; st[ix["thr"]] = 1; mx = 0
    for k in range(360): LIB.veh_step(1 / 120, 1.5, 0.04, 1, 1e4); mx = max(mx, abs(math.atan2(st[ix["vy"]], max(abs(st[ix["vx"]]), 3))))
    return math.degrees(mx)
b0, b6 = power_corner(0), power_corner(6)
check(b0 > 45 and b6 < 10, f"full throttle in a corner: {b0:.0f}° of slide without TC (a spin), {b6:.0f}° at TC 6")
# ABS: full pedal from 250 km/h. Off, the fronts lock and the stop is long; on, the pressure cycles at a few to
# ~15 Hz and holds the slip near the level's target
def stop(ab, mu):
    LIB.veh_set_control(6, ab); fit(1, 250 / 3.6, 105); st[ix["v"]] = st[ix["vx"]]; st[ix["brakeT"]] = 600; st[ix["brk"]] = 1
    x0 = st[ix["s"]]; t = 0; lock = 0; pf = []
    while st[ix["v"]] > 60 / 3.6 and t < 10:
        LIB.veh_step(1 / 120, mu, 0, 1, 6.6); t += 1 / 120; lock = max(lock, -st[ix["kf"]]); pf.append(st[ix["pbF"]])
    return st[ix["s"]] - x0, lock, sum(1 for a, b in zip(pf, pf[1:]) if b < a - 0.01) / t
(dOff, lOff, _), (dOn, lOn, hz) = stop(0, 0.8), stop(6, 0.8)
check(lOff > 0.9 and lOn < 0.25 and dOn < 0.85 * dOff and 3 < hz < 20,
      f"ABS in the wet, 250→60 km/h: {dOff:.0f} m locked without, {dOn:.0f} m with (peak slip {lOn:.2f}, {hz:.0f} Hz cycling)")
# carbon brakes need heat: the same stop on cold discs (150 °C) is longer than on hot ones
def stopT(T):
    LIB.veh_set_control(6, 6); fit(1, 250 / 3.6, 105); st[ix["v"]] = st[ix["vx"]]; st[ix["brk"]] = 1; x0 = st[ix["s"]]
    for f in ("brakeT", "brakeTR", "bCoreF", "bCoreR"): st[ix[f]] = T
    for k in range(60): LIB.veh_step(1 / 120, 1.5, 0, 1, 6.6)
    return st[ix["s"]] - x0, st[ix["v"]] * 3.6
(dc, vc), (dh, vh) = stopT(150), stopT(600)
check(vc > vh + 5, f"cold carbon brakes bite less: after 0.5 s of full pedal {vc:.0f} km/h on 150 °C discs, {vh:.0f} km/h on 600 °C")
LIB.veh_set_control(6, 6)
# brake-by-wire: the MGU-K harvests up to 120 kW on the rear axle, so the rear discs run cooler than the fronts; the
# friction surface runs far hotter than the disc's core during a stop
LIB.veh_set_surface(1, 0, 0, 1, 0, 0, 0); fit(1, 320 / 3.6, 95); st[ix["v"]] = st[ix["vx"]]; st[ix["brk"]] = 1; pf = pr = rg = 0
while st[ix["v"]] > 90 / 3.6: LIB.veh_step(1 / 120, 1.5, 0, 1, 6.6); pf, pr, rg = max(pf, st[ix["brakeT"]]), max(pr, st[ix["brakeTR"]]), max(rg, st[ix["regen"]])
check(115 < rg <= 120.5 and pf > pr + 100 and pf > st[ix["bCoreF"]] + 300,
      f"brakes: MGU-K harvests {rg:.0f} kW; surfaces {pf:.0f} °C front, {pr:.0f} °C rear; front core {st[ix['bCoreF']]:.0f} °C")
# brake balance: with ABS off, moving the balance rearward makes the rears lock; a locked tyre wears a flat spot
def bias_lock(bb):
    LIB.veh_set_control(6, 0); LIB.veh_set_bias(bb); fit(1, 200 / 3.6, 95); st[ix["v"]] = st[ix["vx"]]; st[ix["brk"]] = 1
    for k in range(40): LIB.veh_step(1 / 120, 1.5, 0, 1, 6.6)
    return st[ix["kr"]], st[ix["flatF"]]
(kr50, fl50), (kr65, fl65) = bias_lock(0.50), bias_lock(0.65)
LIB.veh_set_bias(0.57); LIB.veh_set_control(6, 6)
check(kr50 < -0.8 and kr65 > -0.5 and fl65 > 0.02, f"brake balance 50 % locks the rears (slip {kr50:.2f}), 65 % does not ({kr65:.2f}); locked fronts wore a flat spot ({fl65:.2f})")
# off-road: the tread picks up grass and earth, and grips less back on the asphalt until it scrubs clean
def ay_peak():
    ay = 0
    for k in range(240): LIB.veh_step(1 / 120, 1.5, 0.05, 1, 1e4); ay = max(ay, abs(st[ix["ay"]]))
    return ay / 9.81
LIB.veh_set_surface(1, 0, 0, 1, 0, 0, 0); fit(1, 150 / 3.6, 95); clean = ay_peak()
fit(1, 150 / 3.6, 95); LIB.veh_set_surface(0.3, 0.08, 1, 0.3, 0.08, 1, 0.3)
for k in range(120): LIB.veh_step(1 / 120, 1.5, 0, 1, 1e4)
LIB.veh_set_surface(1, 0, 0, 1, 0, 0, 0); st[ix["vx"]] = 150 / 3.6; st[ix["vy"]] = st[ix["r"]] = 0; dirty = ay_peak()
check(dirty < 0.95 * clean and st[ix["dirtF"]] < 0.9, f"dirty tyres after the grass: {dirty:.2f} g against {clean:.2f} g clean; dirt scrubs off ({st[ix['dirtF']]:.2f} left)")
# grass and gravel against measurements: locked-wheel skids on mown rye-grass (Cenek, Jamieson & McLarin) average
# ~0.38 g dry and 0.21-0.24 g wet (17 m and 26-30 m from 40 km/h); in a circuit gravel bed (16-32 mm round gravel)
# cars decelerate ~0.3 g coasting and up to ~0.9 g braking. Same surface values as surfaceAt() in game.js.
def off_stop(v0, mu_abs, crr, floor, bk, pl, brake, until=0.3):
    LIB.veh_set_control(6, 0); LIB.veh_set_water(0); fit(1, v0 / 3.6, 105); st[ix["v"]] = st[ix["vx"]]
    for f in ("brakeT", "brakeTR"): st[ix[f]] = 500
    LIB.veh_step(1 / 120, 1.5, 0, 1, 1e4); x0 = st[ix["s"]]; t = 0; st[ix["brk"]] = brake; st[ix["thr"]] = 0
    while st[ix["v"]] > until and t < 30:
        v = st[ix["v"]]; rel = mu_abs / (1.5 * max(st[ix["tyreF"]], 0.3)); c = crr(v) if callable(crr) else crr
        LIB.veh_set_surface(rel, c, 1, rel, c, 1, 0.35); LIB.veh_set_loose(floor, bk, pl, floor, bk, pl)
        LIB.veh_step(1 / 120, 1.5, 0, 1, 1e4); t += 1 / 120
    d = st[ix["s"]] - x0; return d, (v0 / 3.6) ** 2 / (2 * 9.81 * d)
import math
gcrr = lambda v: 0.30 * min(1, math.sqrt(14 / max(v, 1)))
(dgd, agd), (dgw, agw) = off_stop(40, 0.32 / 0.95, 0.06, 0.95, 0.6, 0, 1), off_stop(40, 0.19 / 0.95, 0.09, 0.95, 0.6, 0, 1)
check(12 < dgd < 20 and 19 < dgw < 32, f"grass, locked from 40 km/h: {dgd:.0f} m dry ({agd:.2f} g), {dgw:.0f} m wet ({agw:.2f} g); measured 17 m and 26-30 m")
# (the passenger cars in the study coasted without an F1's engine braking and harvest, so the comparison is the
# deceleration the gravel adds over the same car coasting on asphalt)
(dc, ac), (dr, ar_), (db, ab) = off_stop(50, 0.35 / 0.95, gcrr, 0.95, 0.5, 0.35, 0), off_stop(50, 1.5, 0, 0.74, 1, 0, 0), off_stop(100, 0.35 / 0.95, gcrr, 0.95, 0.5, 0.35, 1)
check(0.2 < ac - ar_ < 0.4 and 0.7 < ab < 1.0, f"gravel bed: coasting from 50 km/h it adds {ac - ar_:.2f} g over asphalt (measured ~0.3); locked braking from 100 km/h {ab:.2f} g (up to ~0.9)")
LIB.veh_set_surface(1, 0, 0, 1, 0, 0, 0); LIB.veh_set_loose(0.74, 1, 0, 0.74, 1, 0); LIB.veh_set_control(6, 6)
LIB.veh_set_water(0); LIB.veh_set_compound(4)

# ---------------- track (C++) ----------------
print("Track (C++)")
n = LIB.track_default(); N = LIB.track_build(n)
check(2800 < LIB.track_len() < 3000 and LIB.track_ncorners() == 8, f"default circuit: {LIB.track_len():.0f} m, {LIB.track_ncorners()} corners, {N} samples")
vp = np.ctypeslib.as_array(LIB.track_vprof(), shape=(N,)); lat = np.ctypeslib.as_array(LIB.track_lat(), shape=(N,))
check(vp.min() > 15 and vp.max() <= 83.0 + 1e-9, f"speed profile {vp.min()*3.6:.0f}-{vp.max()*3.6:.0f} km/h")
check(np.abs(lat).max() <= 4.7 + 1e-9, f"racing line stays on the road (max offset {np.abs(lat).max():.2f} m)")
crest = LIB.track_crest()
hh = np.ctypeslib.as_array(LIB.track_h(), shape=(N,))
check(np.abs(hh).max() == 0 and LIB.track_los(crest - 120, 0, 0.3, crest + 60, 0, 0.3) == 1,
      "flat circuit: no elevation anywhere, so a low sight line runs the length of the straight")
# guardrail behind the grass run-off, ~1.1 m tall: across a corner the radar low in the nose (0.35 m) cannot see a
# low target on the far side, while the driver's eye (~1 m) sees a 3 m recovery vehicle over the rail
cor = np.ctypeslib.as_array(LIB.track_corners(), shape=(LIB.track_ncorners() * 4,))
pairs = [(s0 - 40 + a, s0 - 40 + a + dd) for s0 in cor[0::4] for a in range(0, 60, 5) for dd in range(60, 200, 10)
         if LIB.track_los(s0 - 40 + a, 0, 0.35, s0 - 40 + a + dd, 0, 0.5) == 0 and LIB.track_los(s0 - 40 + a, 0, 1.0, s0 - 40 + a + dd, 0, 3.0) == 1]
check(len(pairs) > 5, f"guardrail: {len(pairs)} sight lines across corners are blocked for the radar (0.35 m) but open to the driver's eye over a 3 m vehicle")
check(LIB.track_water(100, 0, 0) == 0 and LIB.track_water(100, 5.5, 1) > LIB.track_water(100, 5.5, 0.5) > 0, "standing water grows with rain")

# ---------------- screenshot tracer (C++) ----------------
print("Screenshot tracer (C++)")
W = H = 300; img = np.full((H, W, 4), 255, np.uint8)
yy, xx = np.mgrid[0:H, 0:W]; rr = np.hypot((xx - 150) / 1.3, yy - 150)
img[(rr > 88) & (rr < 96)] = (200, 30, 40, 255)                     # an oval lap drawn in red on white
ctypes_buf = np.ctypeslib.as_array(LIB.trace_rgba(), shape=(W * H * 4,)); ctypes_buf[:] = img.reshape(-1)
m = LIB.trace_run(W, H, 0, 0, 0, 0, 60.0)
pts = np.ctypeslib.as_array(LIB.trace_points(), shape=(max(m, 0) * 2,)).reshape(-1, 2) if m > 0 else np.zeros((0, 2))
rad = np.hypot((pts[:, 0] - 150) / 1.3, pts[:, 1] - 150) if m > 0 else np.array([0])
check(m > 100 and LIB.trace_method() == 0 and abs(rad.mean() - 92) < 3, f"traces the oval as a centreline loop ({m} points, mean radius {rad.mean():.1f} px)")
img[:] = 255; ctypes_buf[:] = img.reshape(-1)
check(LIB.trace_run(W, H, 0, 0, 0, 0, 60.0) == -1, "blank image: no track found")

print("\nall checks passed" if ok else "\nSOME CHECKS FAILED")
raise SystemExit(0 if ok else 1)

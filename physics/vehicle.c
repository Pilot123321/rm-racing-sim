/* Vehicle dynamics: dynamic bicycle model in track coordinates (Liniger, Domahidi & Morari 2015) with
   - wheel-speed dynamics per axle: rear drive through an 8-speed gearbox (engine inertia reflected through the
     gear), brakes on both axles, so wheelspin and lock-ups happen
   - combined-slip Magic Formula tyres in the "theoretical slip" form (Pacejka, Tire and Vehicle Dynamics 2012,
     ch. 4; as used by Velenis, Tsiotras & Lu 2007), with a sliding-friction floor
   - tyre load sensitivity, lateral and longitudinal load transfer, aero downforce and drag, tyre relaxation
   - drift equilibria as in Hindiyeh & Gerdes 2014
   - brake hydraulics (line-pressure lag) and carbon-carbon pad friction that depends on disc temperature
   - driver-set traction control and ABS (0 = off, 1-12 like a motorsport rotary switch), modelled on how the real
     systems work: TC holds the driven wheels' slip at a target by cutting engine torque through the ignition;
     ABS modulates each axle's brake pressure (release / hold / reapply) from wheel slip and wheel deceleration
   - barrier contact: rigid-body impulse with restitution and Coulomb friction at the car's corners
   The driver model (throttle/brake/steering filters, steering target) stays in JavaScript; this file integrates
   the physics between two frames. */
#include "physics.h"

/* car parameters (2022-rules F1 car, wet setup) */
#define M 798.0
#define IZ 1150.0
#define LF 1.95
#define LR 1.65
#define HCG 0.3
#define CLA 5.0    /* downforce area: ~2x the car's weight at 260 km/h, 4-5 g in fast corners like a 2022 car */
#define CDA 1.35
#define AEROF 0.42
#define PMAX 760e3
#define FBRAKE (5.5 * 798 * 9.81)
#define BB0 0.57   /* default brake balance, share of the braking torque at the front */
/* Magic Formula stiffness B. With C = 1.9, E = 0.97 the force peaks at B·s = 1.8, so these put the peak at about
   7.5° slip angle / 15 % slip ratio at the front and 6.5° / 13 % at the rear: racing slicks peak at roughly 6-8°
   and 5-15 % (softer compounds a little later, via COMP[].bk) */
#define BF 13.7
#define BR 15.8
#define CC 1.9
#define EE 0.97
#define REARMU 1.08
#define DMAX 0.34
#define RHO 1.2
#define RW 0.36
#define WALL_E 0.25    /* steel guardrail: the rails and posts deform, so less comes back than off concrete */
#define WALL_MU 0.4

/* B·s at the Magic Formula peak for C = 1.9, E = 0.97: C·atan(Bs - E(Bs - atan Bs)) = π/2 gives Bs ≈ 1.8 */
#define BS_PEAK 1.8
#define TRAIL0 0.04   /* pneumatic trail at small slip, m */
static const double GEARS[8] = {18.1, 14.98, 12.4, 10.27, 8.5, 7.04, 5.83, 4.81};
#define GREV 16.0      /* reverse: overall ratio, drive fades out above ~8 m/s */
static const double CORNERS4[4][2] = {{2.7, 0.95}, {2.7, -0.95}, {-2.55, 0.95}, {-2.55, -0.95}};

/* state shared with JavaScript: index order must match VEH_FIELDS in game.js */
enum { S_S, S_LAT, S_PSI, S_VX, S_VY, S_R, S_WF, S_WR, S_KF, S_KR, S_AF, S_AR, S_FYFS, S_FYRS, S_AX, S_AY,
       S_THR, S_BRK, S_DELTA, S_GEAR, S_CUT, S_RPM, S_HITV, S_LATV, S_V, S_SLIDING, S_BETA,
       S_SATF, S_SATR, S_MZ, S_GRIPF, S_GRIPR, S_AQUA, S_REV,
       S_TEMPF, S_TEMPR, S_WEARF, S_WEARR, S_TYREF, S_TYRER, S_BRAKET,
       S_PBF, S_PBR, S_TCCUT, S_TCI, S_ABSF, S_ABSR, S_PADMU,
       S_BRAKETR, S_BCOREF, S_BCORER, S_REGEN, S_DIRTF, S_DIRTR, S_FLATF, S_FLATR, S_BUMP, S_COUNT };
static double st[S_COUNT];

/* Tyre compounds. Grip is set by the tread's temperature and wear and by water:
   - peak grip and cornering stiffness per compound: softer rubber grips more and builds force more progressively
     (smaller Magic Formula B), harder rubber less but with a sharper peak
   - tread temperature per axle: heated by frictional sliding power |Fx·vslip_x| + |Fy·vslip_y| and by rolling
     hysteresis (~1.5 % of load x speed), a share of which stays in the tread; cooled by forced convection (grows
     with speed) and, strongly, by water on the road. Grip follows a window around the compound's working
     temperature: cold rubber is hard and slides, overheated rubber goes greasy
   - wear: rubber lost in proportion to sliding energy, faster above the window; worn tread grips less
   - water: slicks cannot clear water from the contact patch (grip falls with the film, aquaplaning comes at
     ~45 % of a full wet's speed); intermediates clear some; full wets are what the base model describes
   So wets overheat and wear out on a dry track, slicks go cold and slide in the rain, softs are quick but fade. */
typedef struct { double mu, bk, topt, win, heat, wear, evac, t0; } compound_t;
static const compound_t COMP[5] = {
  /* mu    B     Topt  window heat  wear  evac  blanket */
  {1.00, 0.93,  95,  22,  1.25, 1.60, 0.00,  80},   /* 0 soft (red)            */
  {0.97, 1.00, 105,  25,  1.00, 1.00, 0.00,  80},   /* 1 medium (yellow)       */
  {0.94, 1.07, 115,  28,  0.80, 0.60, 0.00,  80},   /* 2 hard (white)          */
  {0.90, 0.96,  75,  30,  1.10, 1.80, 0.50,  60},   /* 3 intermediate (green)  */
  {0.86, 0.92,  60,  35,  1.00, 2.50, 1.00,  60},   /* 4 wet (blue)            */
};
static int comp = 4;
#define TAIR 22.0      /* ambient, deg C */
#define CTH 4200.0     /* tread heat capacity per axle, J/K (a thin rubber layer: warms up in about a minute) */
EXPORT(veh_set_compound) void veh_set_compound(int c) {
  comp = c < 0 ? 0 : c > 4 ? 4 : c;
  st[S_TEMPF] = st[S_TEMPR] = COMP[comp].t0; st[S_WEARF] = st[S_WEARR] = 0; st[S_FLATF] = st[S_FLATR] = st[S_DIRTF] = st[S_DIRTR] = 0;
  if (st[S_BRAKET] < 150) st[S_BRAKET] = 300;
  if (st[S_BRAKETR] < 150) st[S_BRAKETR] = 280;
  if (st[S_BCOREF] < 100) st[S_BCOREF] = 250;
  if (st[S_BCORER] < 100) st[S_BCORER] = 230;
}
/* grip factor of one axle's tyres at tread temperature T, wear W, in a water film of wetness w (0..1).
   The base grip passed in by the game is that of a full wet on the current surface, hence the /COMP[4].mu. */
static double tyre_factor(double T, double W, double w) {
  const compound_t *c = &COMP[comp];
  double x = (T - c->topt) / c->win, fT = clampd(1 - 0.18 * x * x, 0.6, 1);
  double water = 1 - (1 - c->evac) * 0.5 * w;
  return c->mu / COMP[4].mu * fT * (1 - 0.3 * clampd(W, 0, 1)) * water;
}
/* Carbon-carbon discs, one model per axle (each stands for the pair). Two thermal nodes per disc: the friction
   surface, a few millimetres that heat within one stop and set the pad friction and the glow, and the core it
   conducts into. The pads (the same carbon) take part of the heat; the disc gets ~80 %. Cooling by forced
   convection through the brake ducts, h ~ Re^0.8 ~ v^0.8 (turbulent flow, Dittus-Boelter), from both nodes, and
   radiation from the hot surface. Discs run at 400-1000 deg C and glow visibly above ~550 deg C. */
#define CSURF 650.0    /* J/K: friction surface layer of one disc */
#define CCORE 1300.0   /* J/K: the rest of a ~1.2 kg disc (carbon-carbon, c ~ 1.1 kJ/kg K hot) */
#define GCOND 70.0     /* W/K: surface to core, through-thickness conduction */
static void disc_thermal(int ts, int tc, double P, double v, double duct, double h) {
  double Ts = st[ts], Tc = st[tc], Tk = Ts + 273.15, rad = 5.67e-8 * 0.85 * 0.12 * (Tk * Tk * Tk * Tk - 295.0 * 295 * 295 * 295);
  double hc = duct * (6 + 5.2 * pow(fmax(v, 0), 0.8)), q = GCOND * (Ts - Tc);
  st[ts] = fmax(TAIR, Ts + (0.8 * P - q - 0.5 * hc * (Ts - TAIR) - rad) / CSURF * h);
  st[tc] = fmax(TAIR, Tc + (q - 0.5 * hc * (Tc - TAIR)) / CCORE * h);
}
/* Carbon-carbon friction against disc temperature: little bite cold (~0.2 at ambient against ~0.6 hot),
   full from ~400 deg C, and fading as the surface starts to oxidise above ~1000 deg C. Returned relative to the
   hot value that FBRAKE is calibrated for. */
static double pad_mu(double T) {
  double w = clampd((T - 50) / 400, 0, 1), f = clampd((T - 1000) / 250, 0, 1);
  return (0.35 + 0.65 * w * w * (3 - 2 * w)) * (1 - 0.3 * f * f * (3 - 2 * f));
}
/* Driver settings. A level (1 lightest intervention, 12 heaviest) is a preset of the two things a motorsport
   TC/ABS calibration really sets: the target slip ratio and how hard the controller works to hold it (its gain).
   veh_set_aids takes them directly for a custom map; a target <= 0 switches that system off. */
static double tcT = 0.124, tcG = 1, absT = 0.119, absG = 1, bbF = BB0;
EXPORT(veh_tc_target) double veh_tc_target(int l) { return l <= 0 ? 0 : 0.20 - 0.14 * (l - 1) / 11.0; }
EXPORT(veh_abs_target) double veh_abs_target(int l) { return l <= 0 ? 0 : 0.16 - 0.09 * (l - 1) / 11.0; }
EXPORT(veh_level_gain) double veh_level_gain(int l) { return 0.5 + l / 12.0; }
EXPORT(veh_set_aids) void veh_set_aids(double tcTarget, double tcGain, double absTarget, double absGain) {
  tcT = tcTarget; tcG = clampd(tcGain, 0.2, 3); absT = absTarget; absG = clampd(absGain, 0.2, 3); }
EXPORT(veh_set_control) void veh_set_control(int tc, int abs) {
  tc = tc < 0 ? 0 : tc > 12 ? 12 : tc; abs = abs < 0 ? 0 : abs > 12 ? 12 : abs;
  veh_set_aids(veh_tc_target(tc), veh_level_gain(tc), veh_abs_target(abs), veh_level_gain(abs)); }
/* brake balance: share of the braking torque the driver asks of the front axle (F1 drivers run ~54-60 % and move it
   corner by corner) */
EXPORT(veh_set_bias) void veh_set_bias(double f) { bbF = clampd(f, 0.45, 0.70); }
#define TAU_LINE 0.025   /* brake-by-wire / hydraulic line pressure lag, s */
#define TAU_IGN 0.012    /* ignition-cut torque path: acts within a couple of engine cycles */
/* one axle's brake pressure with ABS: slip ratio lam (> 0 braking), wheel deceleration beyond the car's own (m/s²).
   Bosch-style phases: release fast when slip overshoots the target or the wheel decelerates far faster than the
   car (a lock starting), hold around the target, reapply more slowly than the driver could. That cycles at the
   5-15 Hz of real systems, set by the wheel inertia and valve rates. Returns 1 while ABS is modulating. */
/* A tyre shares one friction budget between braking/driving and cornering (the friction circle), so slip used in
   one direction is grip taken from the other. Like motorsport ABS/TC ("lateral-acceleration slip adjustment"),
   the target shrinks as the tyre's lateral slip u (as a fraction of its peak slip) grows. */
static double lat_scale(double alpha, double B) { double u = fabs(tan(alpha)) * B / BS_PEAK; return sqrt(fmax(0.09, 1 - u * u)); }
static int abs_axle(int pi, double demand, double lam, double dwd, double v, double h, double ls) {
  double p = st[pi];
  if (absT <= 0 || v < 2.0 || demand < 0.02) { st[pi] = p + (demand - p) * fmin(1, h / TAU_LINE); return 0; }
  double lt = absT * ls, band = 0.0195 / absG;                                   /* a keener controller holds a tighter band */
  int act = 1;
  if (lam > lt + band || (dwd > 30 / absG && lam > 0.5 * lt)) p -= h / 0.05;     /* release (dump valve) */
  else if (lam > lt - band) {}                                                    /* hold */
  else { p += h * absG / 0.12; act = p < demand - 0.02; }                         /* reapply, staircase-slow */
  st[pi] = clampd(fmin(p, demand), 0, 1);
  return act;
}
/* heat and wear one axle over h seconds: sliding power P (W), axle load Fz (N), speed v (m/s), wetness w */
static void tyre_thermal(int ti, int wi, double P, double Fz, double v, double w, double h) {
  const compound_t *c = &COMP[comp];
  double heat = c->heat * (0.15 * P + 0.4 * 0.015 * Fz * v);
  double cool = (15 + 0.8 * v + 110 * w) * (st[ti] - TAIR);
  st[ti] += (heat - cool) / CTH * h;
  double over = fmax(0, st[ti] - (c->topt + c->win)) / 15;
  st[wi] = fmin(1, st[wi] + c->wear * 0.05 * (P / 1e6) * (1 + over) * h);
}
static double curv[16384];
static int KN = 1;
static double KDS = 1, KL = 1;
static double water_mm = 0;   /* standing water under the car, set by the caller each frame */

/* Aquaplaning. A tyre has to push water out of its footprint; above a critical speed it cannot, and a wedge of
   water lifts the contact patch. For smooth tyres Horne & Dreher's law puts the onset at v ~ sqrt(pressure); a
   grooved wet evacuates water through its tread, so the onset here scales as 1/sqrt(film depth): about 380 km/h
   in a 1 mm film, 220 km/h in 3 mm, 170 km/h in 5 mm. Grip then fades over the next ~50 % of that speed. */
static double aqua_loss(double v, double depth, double evac) {
  if (depth < 0.15) return 0;
  double vc = 105.0 * sqrt(1.0 / depth) * (0.45 + 0.55 * evac);   /* slicks have no grooves to clear the water */
  return clampd((v - 0.8 * vc) / (0.5 * vc), 0, 1);
}
EXPORT(veh_set_water) void veh_set_water(double mm) { water_mm = mm > 0 ? mm : 0; }
/* off the road: rolling-resistance coefficient of the surface under the car (tyres sinking into turf ~0.06-0.12,
   into a gravel trap ~0.3+, which is what gravel is for). The grip of the surface comes in through mu. */
static double sMu[2] = {1, 1}, sCrr[2] = {0, 0}, sOff[2] = {0, 0}, sRough = 0;
/* per axle (front, rear): grip of the surface relative to the track, rolling-resistance coefficient, 1 if off the
   road (the tread picks up grass, earth and grit there), and the ground's roughness (0 smooth .. 1 very bumpy) */
EXPORT(veh_set_surface) void veh_set_surface(double muF, double crrF, double offF, double muR, double crrR, double offR, double rough) {
  sMu[0] = muF; sCrr[0] = fmax(0, crrF); sOff[0] = offF; sMu[1] = muR; sCrr[1] = fmax(0, crrR); sOff[1] = offR; sRough = clampd(rough, 0, 1); }
/* loose and soft ground, per axle: the sliding-friction floor as a share of peak (asphalt 0.74; on turf and gravel
   the force-slip curve is nearly flat, ~0.95), a stiffness factor on B (soft ground peaks at larger slip), and the
   ploughing coefficient of a sliding tyre (gravel ~0.5: a locked car stops at up to ~0.9 g in a gravel bed) */
static double sFloor[2] = {0.74, 0.74}, sBk[2] = {1, 1}, sPl[2] = {0, 0};
EXPORT(veh_set_loose) void veh_set_loose(double floorF, double bkF, double plF, double floorR, double bkR, double plR) {
  sFloor[0] = clampd(floorF, 0.5, 1); sBk[0] = clampd(bkF, 0.2, 1.5); sPl[0] = fmax(0, plF);
  sFloor[1] = clampd(floorR, 0.5, 1); sBk[1] = clampd(bkR, 0.2, 1.5); sPl[1] = fmax(0, plR); }
/* uneven ground: the tyre load rises and falls as the wheel rides over it. A sum of sines in distance stands in for
   the surface profile (wavelengths ~0.5-3 m), unit amplitude. */
static double bumps(double s) { return (sin(s * 2.3) + 0.6 * sin(s * 5.7 + 1.1) + 0.4 * sin(s * 11.9 + 2.3)) / 2.0; }

EXPORT(veh_state) double *veh_state(void) { return st; }
EXPORT(veh_curv) double *veh_curv(void) { return curv; }
EXPORT(veh_set_track) void veh_set_track(int n, double ds) { KN = n; KDS = ds; KL = n * ds; }

static double wrap_s(double s) { s = fmod(s, KL); return s < 0 ? s + KL : s; }
static double kappa(double s) {
  double x = wrap_s(s) / KDS; int i = (int)x % KN, j = (i + 1) % KN; double f = x - floor(x);
  return curv[i] + (curv[j] - curv[i]) * f;
}
static double rpm_of(double v, int g) { double r = v / (2 * PI * RW) * 60 * GEARS[g]; return r > 4200 ? r : 4200; }
static double torque_at(double rpm) { double x = (rpm - 10800) / 7200, t = 560 * (1 - x * x); return t > 260 ? t : 260; }
/* axle grip with load sensitivity: the loaded outside tyre gains grip less than in proportion. F1 tyres are built
   for ~4 kN; the friction coefficient falls ~10 % per extra nominal load (a racing slick keeps ~90 % at twice it) */
static double mu_load(double F, double mu0) { double k = 1 - 0.10 * (F / 4000 - 1); return mu0 * (k > 0.6 ? k : 0.6); }
static double axle_grip(double Fz, double dF, double mu0) {
  double a = Fz / 2 + fabs(dF), b = Fz / 2 - fabs(dF); if (b < 0) b = 0;
  return mu_load(a, mu0) * a + mu_load(b, mu0) * b;
}
/* combined slip, theoretical-slip form: sx = k/(1+k), sy = tan(a)/(1+k), |F| = MF(|s|) shared along (sx, sy) */
static void combined_slip(double k, double a, double D, double B, double floor, double *Fx, double *Fy, double *sat) {
  double k1 = 1 + k > 0.08 ? 1 + k : 0.08, sx = k / k1, sy = tan(clampd(a, -1.4, 1.4)) / k1, sm = hypot(sx, sy);
  *sat = B * sm / BS_PEAK;
  if (sm < 1e-7) { *Fx = *Fy = 0; return; }
  double Bs = B * sm, F = D * sin(CC * atan(Bs - EE * (Bs - atan(Bs))));
  if (Bs > 2.2 && F < floor * D) F = floor * D;  /* sliding rubber keeps ~3/4 of peak grip on asphalt, nearly all on turf or gravel */
  *Fx = F * sx / sm; *Fy = F * sy / sm;
}
/* barrier impulse: j = (1+e) vn / (1/m + (r x n)^2 / Iz), friction |jt| <= mu_w j, at the deepest corner */
static void wall_contact(double wall) {
  double cs = cos(st[S_PSI]), sn = sin(st[S_PSI]);
  double Vs = st[S_VX] * cs - st[S_VY] * sn, Vn = st[S_VX] * sn + st[S_VY] * cs, r = st[S_R], hit = 0;
  for (int side = 1; side >= -1; side -= 2) {
    double pen = 0, ps = 0, pn = 0; int found = 0;
    for (int c = 0; c < 4; c++) {
      double a = CORNERS4[c][0], b = CORNERS4[c][1], cps = a * cs - b * sn, cpn = a * sn + b * cs, lat = st[S_LAT] + cpn;
      double over = side > 0 ? lat - wall : -wall - lat;
      if (over > pen) { pen = over; ps = cps; pn = cpn; found = 1; }
    }
    if (!found) continue;
    double nrm = side;
    st[S_LAT] -= nrm * pen;
    double vn = (Vn + r * ps) * nrm;
    if (vn <= 0) continue;
    double rxn = ps * nrm, k = 1 / M + rxn * rxn / IZ, j = (1 + WALL_E) * vn / k;
    Vn -= nrm * j / M; r -= rxn * j / IZ;
    double vt = Vs - r * pn, kt = 1 / M + pn * pn / IZ, jt = -sgn(vt) * fmin(WALL_MU * j, fabs(vt) / kt);
    Vs += jt / M; r += (-pn) * jt / IZ;
    if (vn > hit) hit = vn;
  }
  if (hit > 0) {
    st[S_VX] = Vs * cs + Vn * sn; st[S_VY] = -Vs * sn + Vn * cs; st[S_R] = r;
    if (hit > st[S_HITV]) st[S_HITV] = hit;
    if (st[S_REV] < 0.5) { double wmax = st[S_VX] / RW + 2; if (st[S_WF] > wmax) st[S_WF] = wmax; if (st[S_WF] < 0) st[S_WF] = 0; }
  }
}

/* put the wheels at road speed and pick the gear for the current speed (new car / reset) */
EXPORT(veh_reset) void veh_reset(void) {
  st[S_WF] = st[S_WR] = st[S_VX] / RW; st[S_KF] = st[S_KR] = st[S_AF] = st[S_AR] = 0;
  int g = 0; while (g < 7 && rpm_of(st[S_VX], g) > 11000) g++;
  st[S_GEAR] = g; st[S_CUT] = 0;
}

/* one frame: gearbox, steering rate limit, then adaptive substeps of the stiff wheel-slip dynamics */
EXPORT(veh_step) void veh_step(double dt, double mu, double dTarget, double aeroK, double wall) {
  if (st[S_TEMPF] <= 0) veh_set_compound(comp);                     /* first call: a fresh set out of the blankets */
  const double L = LF + LR;
  int gear = (int)st[S_GEAR], rev = st[S_REV] > 0.5;
  st[S_RPM] = fmax(4200, fabs(st[S_WR]) * 60 / (2 * PI) * (rev ? GREV : GEARS[gear]));
  if (rev) { gear = 0; st[S_CUT] = 0; }
  else if (st[S_CUT] > 0) st[S_CUT] -= dt;
  else if (st[S_RPM] > 11800 && gear < 7) { gear++; st[S_CUT] = 0.045; }
  else if (st[S_RPM] < 7300 && gear > 0) { gear--; st[S_CUT] = 0.03; }
  st[S_GEAR] = gear;
  double rate = 3.0 * dt;                                           /* how fast the driver's hands can wind on lock */
  st[S_DELTA] += clampd(dTarget - st[S_DELTA], -rate, rate);
  double dl = st[S_DELTA], cd = cos(dl), sd = sin(dl), Gr = rev ? GREV : GEARS[gear];
  double Iwf = 2.4, Iwr = 2.6 + 0.045 * Gr * Gr;
  double Dest = mu * (3900 + 0.25 * RHO * CLA * aeroK * st[S_VX] * st[S_VX]);
  double stiff = RW * RW * BR * CC * Dest / (Iwf * fmax(fabs(st[S_VX]), 3));
  int n = (int)clampd(ceil(dt * stiff * 1.4), 4, 48); double h = dt / n;
  for (int k = 0; k < n; k++) {
    double kap = kappa(st[S_S]), vx = st[S_VX], vy = st[S_VY], r = st[S_R], v2 = vx * vx + vy * vy;
    double down = 0.5 * RHO * CLA * aeroK * v2;
    double Fzf = fmax(500, M * G0 * LR / L + down * AEROF - M * st[S_AX] * HCG / L);
    double Fzr = fmax(500, M * G0 * LF / L + down * (1 - AEROF) + M * st[S_AX] * HCG / L);
    /* rolling resistance: the road's, plus a rolling wheel sinking into turf or gravel under its axle's load. A
       locked or spinning wheel slides instead of rolling, so its sinkage drag gives way to sliding friction and
       ploughing (below). */
    const double rollF = clampd(1 - fabs(st[S_KF]) / 0.4, 0, 1), rollR = clampd(1 - fabs(st[S_KR]) / 0.4, 0, 1);
    double drag = 0.5 * RHO * CDA * v2 * sgn(vx) + (fabs(vx) > 0.1 ? (220 + sCrr[0] * Fzf * rollF + sCrr[1] * Fzr * rollR) * sgn(vx) : 0);
    if (sRough > 0) { double bf = sRough * 0.25 * bumps(st[S_S]), br = sRough * 0.25 * bumps(st[S_S] - L);
      Fzf *= 1 + bf; Fzr *= 1 + br; st[S_BUMP] = fmax(fabs(bf), fabs(br)); } else st[S_BUMP] = 0;
    /* grass and grit in the tread: picked up within a few metres off the road, scrubbed off over ~1 km of asphalt */
    { double ds = fabs(vx) * h;
      st[S_DIRTF] = sOff[0] > 0.5 ? st[S_DIRTF] + (1 - st[S_DIRTF]) * ds / 12 : st[S_DIRTF] * (1 - ds / 350);
      st[S_DIRTR] = sOff[1] > 0.5 ? st[S_DIRTR] + (1 - st[S_DIRTR]) * ds / 12 : st[S_DIRTR] * (1 - ds / 350); }
    const double dirtF = sOff[0] > 0.5 ? 1 : 1 - 0.22 * st[S_DIRTF], dirtR = sOff[1] > 0.5 ? 1 : 1 - 0.22 * st[S_DIRTR];   /* dirt only matters back on the asphalt */
    const double flatF = 1 - 0.06 * st[S_FLATF], flatR = 1 - 0.06 * st[S_FLATR];
    /* the fronts meet the full water film; the rears run in the channels the fronts have partly cleared */
    const double evac = COMP[comp].evac, wet = clampd(water_mm / 0.8, 0, 1), bk = COMP[comp].bk;
    double aqF = aqua_loss(fabs(vx), water_mm, evac), aqR = aqua_loss(fabs(vx), water_mm * 0.55, evac);
    st[S_AQUA] = aqF;
    const double tfF = tyre_factor(st[S_TEMPF], st[S_WEARF], wet), tfR = tyre_factor(st[S_TEMPR], st[S_WEARR], wet * 0.8);
    st[S_TYREF] = tfF; st[S_TYRER] = tfR;
    double capF = axle_grip(Fzf, M * st[S_AY] * HCG / 1.6 * 0.55, mu * sMu[0] * dirtF * flatF * tfF * (1 - 0.65 * aqF * (1 - sOff[0]))),
           capR = axle_grip(Fzr, M * st[S_AY] * HCG / 1.6 * 0.45, mu * sMu[1] * dirtR * flatR * REARMU * tfR * (1 - 0.65 * aqR * (1 - sOff[1])));
    double vxf = vx * cd + (vy + LF * r) * sd, vyf = -vx * sd + (vy + LF * r) * cd, vxr = vx, vyr = vy - LR * r;
    double af = -atan2(vyf, fmax(fabs(vxf), 0.5)), ar = -atan2(vyr, fmax(fabs(vxr), 0.5));
    double kf = clampd((st[S_WF] * RW - vxf) / fmax(fabs(vxf), 3), -1, 3), kr = clampd((st[S_WR] * RW - vxr) / fmax(fabs(vxr), 3), -1, 3);
    double Fxf, Fyf, Fxr, Fyr, satf, satr;
    combined_slip(kf, af, capF, BF * bk * sBk[0], sFloor[0], &Fxf, &Fyf, &satf); combined_slip(kr, ar, capR, BR * bk * sBk[1], sFloor[1], &Fxr, &Fyr, &satr);
    /* ploughing: a tyre sliding through gravel pushes a bow wave of stones, a force against the contact patch's
       sliding velocity (u = wheel speed - ground speed along the wheel, and the sideways speed), building up over the
       first ~3 m/s of slip. A rolling tyre does not plough (its sinkage is the rolling resistance). */
    if (sPl[0] > 0) { double ux = st[S_WF] * RW - vxf, sv = hypot(ux, vyf);
      if (sv > 0.05) { double f = sPl[0] * Fzf * fmin(1, sv / 3) / sv; Fxf += f * ux; Fyf -= f * vyf; } }
    if (sPl[1] > 0) { double ux = st[S_WR] * RW - vxr, sv = hypot(ux, vyr);
      if (sv > 0.05) { double f = sPl[1] * Fzr * fmin(1, sv / 3) / sv; Fxr += f * ux; Fyr -= f * vyr; } }
    /* frictional power in each contact patch (force x sliding speed) heats and wears the tread */
    tyre_thermal(S_TEMPF, S_WEARF, fabs(Fxf * kf * vxf) + fabs(Fyf * vyf), Fzf, fabs(vx), wet, h);
    tyre_thermal(S_TEMPR, S_WEARR, fabs(Fxr * kr * vxr) + fabs(Fyr * vyr), Fzr, fabs(vx), wet * 0.8, h);
    /* tyre relaxation length ~0.35 m: lateral force builds over distance rolled */
    double kr2 = fmin(1, fmax(fabs(vx), 1) * h / 0.35);
    st[S_FYFS] += (Fyf - st[S_FYFS]) * kr2; st[S_FYRS] += (Fyr - st[S_FYRS]) * kr2; Fyf = st[S_FYFS]; Fyr = st[S_FYRS];
    /* torques: engine through the gearbox on the rear, brakes on both, engine braking off throttle */
    double rpm = fmax(4200, fabs(st[S_WR]) * 60 / (2 * PI) * Gr);
    double Tdrive = st[S_CUT] > 0 ? 0 : st[S_THR] * fmin(torque_at(rpm) * Gr * 0.93, PMAX / fmax(fabs(st[S_WR]), 4));
    if (rev) {                                                        /* reverse: drive backwards, gently, up to ~30 km/h */
      Tdrive = -Tdrive * 0.35 * clampd(1 - (fabs(vx) - 6) / 3, 0, 1);
    }
    /* traction control: PI on the driven wheels' slip above target -> ignition cut, which takes effect after TAU_IGN */
    double cutReq = 0, drv = rev ? -kr : kr;
    if (tcT > 0 && st[S_THR] > 0.05 && Tdrive * (rev ? -1 : 1) > 0) {
      double e = drv - tcT * lat_scale(ar, BR * bk), kp = 6 * tcG;
      st[S_TCI] = clampd(st[S_TCI] + 20 * tcG * e * h, 0, 1);
      cutReq = clampd(kp * e + st[S_TCI], 0, 1);
    } else st[S_TCI] = 0;
    st[S_TCCUT] += (cutReq - st[S_TCCUT]) * fmin(1, h / TAU_IGN);
    Tdrive *= 1 - st[S_TCCUT];
    /* off the throttle: engine braking, plus the MGU-K harvesting (up to 120 kW, shared with braking regeneration)
       as F1 cars do on every lift. That drag on the rear wheels and the load it shifts forward are what make a car
       rotate when the driver lifts mid-corner. */
    double Tlift = 0;
    if (!rev && st[S_THR] < 0.05 && st[S_WR] > 3) {
      Tdrive -= fmin(1400 * RW, 0.11 * rpm * RW);
      /* under braking the harvest is part of the rear brake demand (brake-by-wire, below), not on top of it */
      /* the lift-off harvest is capped by the engine-braking map at ~0.25 g, for stability at low speed */
      if (st[S_BRK] < 0.05) Tlift = fmin(fmin(0.7 * 120e3 / fabs(st[S_WR]), 0.25 * M * G0 * RW), 200 * Gr * 0.93); Tdrive -= Tlift; }
    /* brakes (brake-by-wire): the pedal asks for a torque split bbF front / (1-bbF) rear. Front: pressure (ABS) x
       carbon friction at the front discs' surface temperature. Rear: the MGU-K takes what it can as regeneration
       (120 kW, and at most ~200 N m at the crank through the gearbox), the rear discs make up the rest. */
    const double Tnom = FBRAKE * RW, pmF = pad_mu(st[S_BRAKET]), pmR = pad_mu(st[S_BRAKETR]);
    double TreqR = st[S_PBR] * Tnom * (1 - bbF), Tk = rev ? 0 : fmax(0, fmin(TreqR, fmin(120e3 / fmax(fabs(st[S_WR]), 1), 200 * Gr * 0.93) - Tlift));
    double Tbf = st[S_PBF] * Tnom * bbF * pmF, Tbr = (TreqR - Tk) * pmR + Tk;
    double dwf = -((-Fxf * RW) - Tbf) / Iwf * RW - fmax(0, -st[S_AX]);      /* wheel decel beyond the car's */
    double dwr = -((Tdrive - Fxr * RW) - Tbr) / Iwr * RW - fmax(0, -st[S_AX]);
    st[S_ABSF] = abs_axle(S_PBF, st[S_BRK], rev ? 0 : -kf, dwf, fabs(vx), h, lat_scale(af, BF * bk));
    st[S_ABSR] = abs_axle(S_PBR, st[S_BRK], rev ? 0 : -kr, dwr, fabs(vx), h, lat_scale(ar, BR * bk));
    st[S_PADMU] = pmF; st[S_REGEN] = (Tk + Tlift) * fabs(st[S_WR]) / 1000;
    disc_thermal(S_BRAKET, S_BCOREF, 0.5 * Tbf * fabs(st[S_WF]), fabs(vx), 1.0, h);            /* per disc: half the axle */
    disc_thermal(S_BRAKETR, S_BCORER, 0.5 * (Tbr - Tk) * fabs(st[S_WR]), fabs(vx), 0.8, h);   /* smaller rear ducts */
    /* a locked wheel grinds one patch of tread flat: a flat spot grows with the sliding energy, and then thumps
       once a revolution and costs a little grip */
    if (fabs(vx) > 8) { if (kf < -0.85) st[S_FLATF] = fmin(1, st[S_FLATF] + 6e-7 * fabs(Fxf * vxf) * h);
                        if (kr < -0.85) st[S_FLATR] = fmin(1, st[S_FLATR] + 6e-7 * fabs(Fxr * vxr) * h); }
    st[S_WF] += (-Fxf * RW) / Iwf * h; st[S_WR] += (Tdrive - Fxr * RW) / Iwr * h;
    if (rev) {                                                        /* brakes slow a wheel towards zero from either side */
      st[S_WF] = sgn(st[S_WF]) * fmax(0, fabs(st[S_WF]) - Tbf / Iwf * h);
      st[S_WR] = sgn(st[S_WR]) * fmax(0, fabs(st[S_WR]) - Tbr / Iwr * h);
    } else {                                                          /* brakes can stop a wheel but never spin it backwards */
      st[S_WF] = st[S_WF] > 0 ? fmax(0, st[S_WF] - Tbf / Iwf * h) : 0;
      st[S_WR] = st[S_WR] > 0 ? fmax(0, st[S_WR] - Tbr / Iwr * h) : fmax(0, st[S_WR]);
    }
    double FxB = Fxf * cd - Fyf * sd + Fxr, FyB = Fxf * sd + Fyf * cd + Fyr;
    double ax = (FxB - drag) / M + vy * r, ay = FyB / M - vx * r, rd = (LF * (Fxf * sd + Fyf * cd) - LR * Fyr) / IZ;
    st[S_VX] += ax * h; st[S_VY] += ay * h; st[S_R] += rd * h;
    if (!rev) {
      if (st[S_VX] < 0.4 && st[S_THR] < 0.05 && fabs(st[S_VY]) < 0.4) { st[S_VX] = fmax(0, st[S_VX]); if (st[S_VX] < 0.05) { st[S_VY] *= 0.9; st[S_R] *= 0.9; } }
      if (st[S_VX] < -1) st[S_VX] = -1;                             /* no rolling back without reverse, only a rock-back after a spin */
    } else if (st[S_THR] < 0.05 && fabs(st[S_VX]) < 0.3 && fabs(st[S_VY]) < 0.4) { st[S_VX] *= 0.9; st[S_VY] *= 0.9; st[S_R] *= 0.9; }
    st[S_AY] = lerpd(st[S_AY], ay + vx * r, 0.2); st[S_AX] = lerpd(st[S_AX], ax - vy * r, 0.15);
    st[S_KF] = kf; st[S_KR] = kr; st[S_AF] = af; st[S_AR] = ar;
    /* what the driver feels through the wheel: self-aligning torque Mz = trail · Fy. The pneumatic trail shrinks
       as the contact patch starts to slide (brush model), so Mz peaks and falls before Fy does: the steering goes
       light just before the front washes out. Normalised by trail0 · front grip. */
    double tr = 1 - fmin(1, satf / 2); st[S_MZ] = TRAIL0 * tr * tr * Fyf / (TRAIL0 * fmax(capF, 1));
    st[S_SATF] = satf; st[S_SATR] = satr;
    st[S_GRIPF] = hypot(Fxf, Fyf) / fmax(capF, 1); st[S_GRIPR] = hypot(Fxr, Fyr) / fmax(capR, 1);
    double psi = st[S_PSI], sdot = (st[S_VX] * cos(psi) - st[S_VY] * sin(psi)) / fmax(0.2, 1 - kap * st[S_LAT]);
    st[S_LATV] = st[S_VX] * sin(psi) + st[S_VY] * cos(psi);
    st[S_LAT] += st[S_LATV] * h; st[S_PSI] += (st[S_R] - kap * sdot) * h; st[S_S] = wrap_s(st[S_S] + sdot * h);
    wall_contact(wall);
  }
  st[S_PSI] = atan2(sin(st[S_PSI]), cos(st[S_PSI]));
  st[S_V] = hypot(st[S_VX], st[S_VY]);
  st[S_BETA] = atan2(st[S_VY], fmax(fabs(st[S_VX]), 3));
  st[S_SLIDING] = (fabs(st[S_AR]) > 0.12 || st[S_KR] > 0.2 || st[S_KF] < -0.3 || st[S_KR] < -0.3) ? 1 : 0;
}

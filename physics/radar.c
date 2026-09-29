/* On-board radar: 77 GHz FMCW long-range sensor in the nose, modelled from physics every scan.
   - radar range equation  Pr = Pt·G(θ)²·λ²·σ / ((4π)³·R⁴·L)  with a Gaussian beam per mode (far ±9°, near ±45°)
   - thermal noise k·T0·F / T_frame: the range-Doppler FFT integrates coherently over one frame
   - two-way rain attenuation γ = k·Rr^α dB/km (ITU-R P.838 form; k≈1.0, α≈0.72 near 77 GHz), a wet radome,
     and any extra loss the caller adds (spray plumes, a car in the way)
   - fog: Rayleigh absorption by the droplets, ITU-R P.840 (double-Debye permittivity of water): about
     3 dB/km per g/m³ at 77 GHz and 15 °C, so even thick fog (0.5 g/m³, 50 m visibility) costs under 1 dB two-way
     over the radar's 250 m, while it blinds the eye. Fog droplets are too small to add clutter.
   - rain volume clutter η·V in the resolution cell competing with the target (SINR)
   - two-ray multipath off the wet road (Γ≈-0.65): fading, and faster than R⁻⁴ fall-off past 4·h_r·h_t/λ
   - Swerling-1 fluctuating targets behind a CA-CFAR at Pfa: Pd = Pfa^(1/(1+SINR))
   - measurement noise σ ≈ resolution/√(2·SNR); returns within one cell in range, Doppler and angle merge
   - false alarms at Pfa × (range × Doppler × beam) cells
   Then a constant-velocity Kalman tracker (position + range-rate updates, χ² gating, global-nearest-neighbour
   association, 3-of-5 confirmation). Scene geometry (who is in line of sight) is decided by the caller. */
#include "physics.h"

#define F0 76.5e9
#define LAM (3e8 / F0)
#define PT 0.016          /* 12 dBm */
#define LSYS 31.6227766   /* 15 dB system losses */
#define NF 25.1188643     /* 14 dB noise figure */
#define TF 0.005          /* 5 ms frame */
#define BW 600e6          /* chirp bandwidth -> 0.25 m range cells */
#define PFA 1e-6
#define HR 0.35           /* radar height above the road */
#define GAMMA_ROAD (-0.65)
#define ETA_K 3.6e-6      /* rain backscatter η per mm/h (m²/m³) */
#define DR (3e8 / (2 * BW))
#define DV (LAM / (2 * TF))
#define MAXRAW 256
#define MAXDET 160
#define MAXTRK 96

typedef struct { double G, half, bw, el, rmax; } mode_t;
static const mode_t MODES[2] = {{316.227766, 9 * PI / 180, 2.2 * PI / 180, 5 * PI / 180, 250},
                                {39.8107171, 45 * PI / 180, 7 * PI / 180, 12 * PI / 180, 80}};
static double K_SNR;      /* Pt·λ² / ((4π)³·L·N0) */
static rng_t RNG = {0x9E3779B97F4A7C15ULL};
static double out[8];
/* raw returns: r, az, vr, snr, sr, sa, sv, bw, ref, st */
static double raw[MAXRAW][10]; static int nraw;
/* resolved detections: r, az, vr, snr, sr, sa, sv, bw, ref, st, x, z */
static double det[MAXDET][12]; static int ndet;
/* tracks: id, x, z, vx, vz, conf, hits, miss, age, snr, P[16] */
typedef struct { double id, x, z, vx, vz, conf, hits, miss, age, snr, P[4][4]; int hit; } trk_t;
static trk_t trk[MAXTRK]; static int ntrk; static double nid = 1;
static double trk_out[MAXTRK][12];

static void init_k(void) { if (K_SNR == 0) { double N0 = 1.380649e-23 * 290 * NF / TF; K_SNR = PT * LAM * LAM / (pow(4 * PI, 3) * LSYS * N0); } }
EXPORT(radar_out) double *radar_out(void) { return out; }
EXPORT(radar_det) double *radar_det(void) { return &det[0][0]; }
EXPORT(radar_tracks) double *radar_tracks(void) { return &trk_out[0][0]; }
EXPORT(radar_seed) void radar_seed(double s) { RNG.s = (uint64_t)(s * 2654435761.0) | 1; nraw = ndet = ntrk = 0; nid = 1; }
EXPORT(radar_rain_rate) double radar_rain_rate(double rain) { return 50 * rain * rain + 8 * rain; }       /* mm/h */
EXPORT(radar_rain_db) double radar_rain_db(double rain) { double r = radar_rain_rate(rain); return r > 0 ? pow(r, 0.72) : 0; } /* dB/km one way */
/* ITU-R P.840 specific attenuation coefficient Kl (dB/km per g/m³) at f GHz and T kelvin */
EXPORT(radar_fog_kl) double radar_fog_kl(double f, double T) {
  double th = 300 / T, e0 = 77.66 + 103.3 * (th - 1), e1 = 0.0671 * e0, e2 = 3.52;
  double fp = 20.20 - 146 * (th - 1) + 316 * (th - 1) * (th - 1), fs = 39.8 * fp;
  double e2p = f * (e0 - e1) / (fp * (1 + (f / fp) * (f / fp))) + f * (e1 - e2) / (fs * (1 + (f / fs) * (f / fs)));
  double e1p = (e0 - e1) / (1 + (f / fp) * (f / fp)) + (e1 - e2) / (1 + (f / fs) * (f / fs)) + e2;
  double eta = (2 + e1p) / e2p;
  return 0.819 * f / (e2p * (1 + eta * eta));
}
static double fog_db_km = 0;   /* one way, dB/km */
EXPORT(radar_set_fog) void radar_set_fog(double lwc, double tc) { fog_db_km = lwc > 0 ? radar_fog_kl(F0 / 1e9, tc + 273.15) * lwc : 0; }
EXPORT(radar_fog_db) double radar_fog_db(void) { return fog_db_km; }
/* one-way path attenuation, dB/km: rain + fog */
static double path_db(double rain) { return radar_rain_db(rain) + fog_db_km; }
EXPORT(radar_radome) double radar_radome(double rain) { return pow(10, -(4 * rain) / 10); }                /* wet radome, two way */

static double gain(const mode_t *m, double az) { double x = az / m->half; return m->G * exp(-0.6925 * x * x); } /* -3 dB at the FOV edge */
/* two-ray propagation factor F⁴ averaged over the target's scattering heights */
EXPORT(radar_two_ray) double radar_two_ray(double R, double h0, double h1, double h2) {
  double hs[3] = {h0, h1, h2}, a = 0;
  for (int i = 0; i < 3; i++) {
    double ph = 4 * PI * HR * hs[i] / (LAM * R), re = 1 + GAMMA_ROAD * cos(ph), im = -GAMMA_ROAD * sin(ph), F2 = re * re + im * im;
    a += F2 * F2;
  }
  return a / 3;
}
/* SINR of a point target: returns SINR, out[0]=mode index (-1 if outside every beam) */
EXPORT(radar_sinr) double radar_sinr(double r, double az, double sigma, double h0, double h1, double h2, double lossDB, double rain) {
  init_k();
  int best = -1; double bg = 0;
  for (int i = 0; i < 2; i++) { if (r > MODES[i].rmax * 1.15 || fabs(az) > MODES[i].half * 1.25) continue; double g = gain(&MODES[i], az); if (g > bg) { bg = g; best = i; } }
  out[0] = best; if (best < 0) return 0;
  const mode_t *m = &MODES[best];
  double loss = lossDB + 2 * path_db(rain) * r / 1000, rad = radar_radome(rain), r4 = r * r * r * r;
  double S = K_SNR * bg * bg * sigma * radar_two_ray(r, h0, h1, h2) * rad * pow(10, -loss / 10) / r4;
  double eta = ETA_K * radar_rain_rate(rain), V = r * r * m->bw * m->el * DR * PI / 4;
  double C = K_SNR * bg * bg * eta * V * rad * pow(10, -(2 * path_db(rain) * r / 1000) / 10) / r4;
  return S / (1 + C);
}
/* one return: detection draw and noisy measurement; appends to the raw list. Returns 1 if detected. */
EXPORT(radar_return) int radar_return(double r, double az, double vr, double sigma, double h0, double h1, double h2,
                                      double lossDB, double rain, double ref, int stationary) {
  double snr = radar_sinr(r, az, sigma, h0, h1, h2, lossDB, rain); int mi = (int)out[0];
  if (mi < 0 || nraw >= MAXRAW) return 0;
  double pd = pow(PFA, 1 / (1 + snr));
  if (rng_u(&RNG) > pd) return 0;
  double s2 = sqrt(2 * snr), bw = MODES[mi].bw, sr = fmax(0.03, DR / s2), sa = bw / (1.6 * s2) + 0.0008, sv = fmax(0.04, DV / s2);
  double *d = raw[nraw++];
  d[0] = r + rng_n(&RNG) * sr; d[1] = az + rng_n(&RNG) * sa; d[2] = vr + rng_n(&RNG) * sv; d[3] = snr;
  d[4] = sr; d[5] = sa; d[6] = sv; d[7] = bw; d[8] = ref; d[9] = stationary;
  return 1;
}
/* CFAR false alarms over range × Doppler × beam cells */
EXPORT(radar_false_alarms) int radar_false_alarms(void) {
  double mean = 256.0 * 128 * 12 * PFA; int n = 0;
  for (int k = 0; k < 4; k++) if (rng_u(&RNG) < mean / 4 && nraw < MAXRAW) {
    double *d = raw[nraw++]; d[0] = 5 + rng_u(&RNG) * 200; d[1] = (rng_u(&RNG) * 2 - 1) * MODES[0].half; d[2] = (rng_u(&RNG) * 2 - 1) * 40;
    d[3] = 25; d[4] = 0.3; d[5] = 0.02; d[6] = 0.3; d[7] = MODES[0].bw; d[8] = -1; d[9] = 0; n++; }
  return n;
}
EXPORT(radar_begin) void radar_begin(void) { nraw = 0; }
/* resolution: strongest first; a weaker return within one cell in range, Doppler and angle is absorbed.
   Converts to world x,z from the radar origin and heading; flags returns that are stationary on the ground. */
EXPORT(radar_resolve) int radar_resolve(double ox, double oz, double hx, double hz, double vex, double vez) {
  /* insertion sort by SNR, descending */
  for (int i = 1; i < nraw; i++) { double t[10]; for (int k = 0; k < 10; k++) t[k] = raw[i][k]; int j = i - 1;
    while (j >= 0 && raw[j][3] < t[3]) { for (int k = 0; k < 10; k++) raw[j + 1][k] = raw[j][k]; j--; }
    for (int k = 0; k < 10; k++) raw[j + 1][k] = t[k]; }
  ndet = 0;
  for (int i = 0; i < nraw && ndet < MAXDET; i++) {
    double *d = raw[i]; int merged = 0;
    for (int j = 0; j < ndet; j++) if (fabs(det[j][0] - d[0]) < DR * 1.5 && fabs(det[j][2] - d[2]) < DV * 1.5 && fabs(det[j][1] - d[1]) < d[7]) { merged = 1; break; }
    if (merged) continue;
    double *e = det[ndet++]; for (int k = 0; k < 10; k++) e[k] = d[k];
    double ca = cos(d[1]), sa = sin(d[1]);
    e[10] = ox + (hx * ca - hz * sa) * d[0]; e[11] = oz + (hz * ca + hx * sa) * d[0];
    double ux = (e[10] - ox) / d[0], uz = (e[11] - oz) / d[0];
    e[9] = fabs(d[2] + vex * ux + vez * uz) < 1.2 ? 1 : 0;       /* ground speed along the line of sight ~ 0 */
  }
  return ndet;
}
/* Kalman tracker on the resolved detections; returns the number of tracks written to radar_tracks() */
EXPORT(radar_track) int radar_track(double dt, double vex, double vez, double ox, double oz) {
  const double q = 30, d2 = dt * dt, d3 = d2 * dt;
  for (int t = 0; t < ntrk; t++) {                                  /* predict: x += v·dt, P = F P Fᵀ + Q */
    trk_t *T = &trk[t]; double (*P)[4] = T->P;
    T->x += T->vx * dt; T->z += T->vz * dt;
    for (int a = 0; a < 2; a++) for (int b = 0; b < 2; b++) {
      P[a][b] += dt * (P[a + 2][b] + P[a][b + 2]) + d2 * P[a + 2][b + 2]; P[a][b + 2] += dt * P[a + 2][b + 2]; P[a + 2][b] += dt * P[a + 2][b + 2]; }
    for (int a = 0; a < 2; a++) { P[a][a] += q * d3 / 3; P[a][a + 2] += q * d2 / 2; P[a + 2][a] += q * d2 / 2; P[a + 2][a + 2] += q * dt; }
    T->hit = 0;
  }
  /* measurement covariance of each detection in x,z (polar -> Cartesian) */
  static double Rm[MAXDET][3], U[MAXDET][2];
  for (int j = 0; j < ndet; j++) {
    double *d = det[j], bx = d[10] - ox, bz = d[11] - oz, br = hypot(bx, bz), c = bx / br, s = bz / br, rr = d[4] * d[4], aa = (d[0] * d[5]) * (d[0] * d[5]);
    Rm[j][0] = c * c * rr + s * s * aa; Rm[j][1] = c * s * (rr - aa); Rm[j][2] = s * s * rr + c * c * aa; U[j][0] = c; U[j][1] = s;
  }
  /* gated candidate pairs, then greedy global nearest neighbour */
  static double pm[MAXTRK * MAXDET]; static int pi_[MAXTRK * MAXDET], pj[MAXTRK * MAXDET]; int np = 0;
  for (int j = 0; j < ndet; j++) for (int t = 0; t < ntrk; t++) {
    trk_t *T = &trk[t]; double *d = det[j];
    double S00 = T->P[0][0] + Rm[j][0], S01 = T->P[0][1] + Rm[j][1], S11 = T->P[1][1] + Rm[j][2], dt_ = S00 * S11 - S01 * S01, ex = d[10] - T->x, ez = d[11] - T->z;
    double m = (S11 * ex * ex - 2 * S01 * ex * ez + S00 * ez * ez) / dt_;
    if (m > 9.21) continue;                                          /* χ²(2) at 99 % */
    double c = U[j][0], s = U[j][1], vr = (T->vx - vex) * c + (T->vz - vez) * s;
    if (fabs(vr - d[2]) > 3 * sqrt(T->P[2][2] * c * c + T->P[3][3] * s * s + d[6] * d[6]) + 1) continue;
    pm[np] = m; pi_[np] = t; pj[np] = j; np++;
  }
  static int ut[MAXTRK], ud[MAXDET];
  for (int t = 0; t < ntrk; t++) ut[t] = 0; for (int j = 0; j < ndet; j++) ud[j] = 0;
  for (;;) {
    int bi = -1; double bm = 1e18;
    for (int k = 0; k < np; k++) if (!ut[pi_[k]] && !ud[pj[k]] && pm[k] < bm) { bm = pm[k]; bi = k; }
    if (bi < 0) break;
    int t = pi_[bi], j = pj[bi]; ut[t] = ud[j] = 1;
    trk_t *T = &trk[t]; double (*P)[4] = T->P, *d = det[j];
    /* position update */
    double S00 = P[0][0] + Rm[j][0], S01 = P[0][1] + Rm[j][1], S10 = P[1][0] + Rm[j][1], S11 = P[1][1] + Rm[j][2], dd = S00 * S11 - S01 * S10;
    double i00 = S11 / dd, i01 = -S01 / dd, i10 = -S10 / dd, i11 = S00 / dd, K[4][2], y0 = d[10] - T->x, y1 = d[11] - T->z, P0[4][4];
    for (int a = 0; a < 4; a++) { K[a][0] = P[a][0] * i00 + P[a][1] * i10; K[a][1] = P[a][0] * i01 + P[a][1] * i11; }
    T->x += K[0][0] * y0 + K[0][1] * y1; T->z += K[1][0] * y0 + K[1][1] * y1; T->vx += K[2][0] * y0 + K[2][1] * y1; T->vz += K[3][0] * y0 + K[3][1] * y1;
    for (int a = 0; a < 4; a++) for (int b = 0; b < 4; b++) P0[a][b] = P[a][b];
    for (int a = 0; a < 4; a++) for (int b = 0; b < 4; b++) P[a][b] = P0[a][b] - K[a][0] * P0[0][b] - K[a][1] * P0[1][b];
    /* range-rate update: h = [0,0,ux,uz], measurement vr + v_ego·u */
    double ux = U[j][0], uz = U[j][1], hx[4];
    for (int a = 0; a < 4; a++) hx[a] = P[a][2] * ux + P[a][3] * uz;
    double sv = hx[2] * ux + hx[3] * uz + d[6] * d[6], inn = d[2] + vex * ux + vez * uz - (T->vx * ux + T->vz * uz);
    T->x += hx[0] / sv * inn; T->z += hx[1] / sv * inn; T->vx += hx[2] / sv * inn; T->vz += hx[3] / sv * inn;
    for (int a = 0; a < 4; a++) for (int b = 0; b < 4; b++) P[a][b] -= hx[a] * hx[b] / sv;
    T->hit = 1; T->hits++; T->miss = 0; T->snr = d[3];
    if (!T->conf && T->hits >= 3 && T->age <= 5) T->conf = 1;
  }
  /* age, drop lost or diverged tracks */
  int w = 0;
  for (int t = 0; t < ntrk; t++) {
    trk_t *T = &trk[t]; T->age++; if (!T->hit) T->miss++;
    int drop = (!T->conf && (T->miss >= 2 || T->age > 5)) || T->miss >= 4 || T->P[0][0] + T->P[1][1] > 400;
    if (!drop) trk[w++] = *T;
  }
  ntrk = w;
  /* new tentative tracks from unused detections; velocity along the line of sight from Doppler */
  for (int j = 0; j < ndet && ntrk < MAXTRK; j++) {
    if (ud[j]) continue;
    double ux = U[j][0], uz = U[j][1], v = det[j][2] + vex * ux + vez * uz;
    trk_t *T = &trk[ntrk++];
    T->id = nid++; T->x = det[j][10]; T->z = det[j][11]; T->vx = v * ux; T->vz = v * uz; T->conf = 0; T->hits = 1; T->miss = 0; T->age = 0; T->snr = det[j][3]; T->hit = 1;
    for (int a = 0; a < 4; a++) for (int b = 0; b < 4; b++) T->P[a][b] = 0;
    T->P[0][0] = Rm[j][0]; T->P[0][1] = T->P[1][0] = Rm[j][1]; T->P[1][1] = Rm[j][2];
    T->P[2][2] = 60 + 80 * uz * uz; T->P[3][3] = 60 + 80 * ux * ux; T->P[2][3] = T->P[3][2] = -80 * ux * uz;
  }
  for (int t = 0; t < ntrk; t++) { trk_t *T = &trk[t]; double *o = trk_out[t];
    o[0] = T->id; o[1] = T->x; o[2] = T->z; o[3] = T->vx; o[4] = T->vz; o[5] = T->conf; o[6] = T->hits; o[7] = T->miss; o[8] = T->age; o[9] = T->snr; o[10] = T->P[0][0] + T->P[1][1]; o[11] = 0; }
  return ntrk;
}
/* how far a 10 m² car is seen with Pd = 0.9 straight ahead, clear line of sight */
EXPORT(radar_range90) double radar_range90(double rain) {
  init_k();
  double need = log(PFA) / log(0.9) - 1, rr = 250, g = MODES[0].G;
  for (int it = 0; it < 8; it++) {
    double S = K_SNR * g * g * 10 * radar_two_ray(rr, 0.25, 0.5, 0.8) * radar_radome(rain) * pow(10, -(2 * path_db(rain) * rr / 1000) / 10) / (rr * rr * rr * rr);
    rr = clampd(rr * pow(S / need, 0.25), 5, 400);
  }
  return rr < MODES[0].rmax ? rr : MODES[0].rmax;
}

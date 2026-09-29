/* Track construction and track queries, C++ (compiled into public/physics.wasm with the C physics).

   From a closed polyline (a drawn lap, a traced map, or the default circuit) this builds everything the game needs:
   1. a clean shape: uniform 2 m resampling, then smoothing until no corner is tighter than an 18 m radius, rescaled
      back to the requested lap length and re-sampled at ~1 m
   2. tangents, curvature, and corners found from smoothed curvature
   3. a flat circuit (no elevation); the longest straight is noted for the scenarios
   4. guardrails at +-WALL behind a grass run-off, with gaps where another part of the track comes close
   5. a racing line by elastic-band relaxation, and a speed profile from its curvature with braking/traction limits
   Queries used every frame: line of sight past barriers, "is another part of the track near this point",
   and the depth of standing water on the surface.

   No heap: every array is static, so wasm memory never grows and JavaScript keeps typed-array views on it. */
#include "physics.h"

namespace {
constexpr int MAXN = 16384, MAXRAW = 65536, MAXCORN = 256, GB = 8192;
constexpr double HW = 6.0, WALL = 16.0;   // 12 m of road, a kerb, then ~9 m of grass run-off to the barrier
constexpr double BARRIER_H = 1.1;         // triple-rail steel guardrail: the top rail's upper edge above the ground

double raw[MAXRAW * 2];
double PX[MAXN], PZ[MAXN], TX[MAXN], TZ[MAXN], HH[MAXN], SL[MAXN], KC[MAXN], LAT[MAXN], VP[MAXN];
double WLX[MAXN], WLZ[MAXN], WRX[MAXN], WRZ[MAXN];
uint8_t WGL[MAXN], WGR[MAXN];
double CORN[MAXCORN * 4];  // s0, s1, sign, turned angle
int N = 0, NCORN = 0;
double LEN = 1, DS = 1, CREST = 0, LONG_S0 = 0, LONG_LEN = 0;

// work buffers
double wx[MAXRAW], wz[MAXRAW], vx[MAXRAW], vz[MAXRAW], cum[MAXRAW + 1];
double TH[MAXN], KS[MAXN], QX[MAXN], QZ[MAXN], QA[MAXN], KR[MAXN];
int gHead[GB], gNext[MAXN];

inline double wrapS(double s) { s = fmod(s, LEN); return s < 0 ? s + LEN : s; }
inline double dSigned(double a, double b) { double d = wrapS(b - a); return d > LEN / 2 ? d - LEN : d; }
inline double angd(double a, double b) { double d = a - b; while (d > PI) d -= 2 * PI; while (d < -PI) d += 2 * PI; return d; }
inline int mod(int i, int n) { return ((i % n) + n) % n; }
inline double sampleArr(const double *A, double s) {
  double x = wrapS(s) / DS; int i = (int)x % N, j = (i + 1) % N; double f = x - floor(x);
  return A[i] + (A[j] - A[i]) * f;
}

double polyLen(const double *x, const double *z, int n) {
  double l = 0;
  for (int i = 0; i < n; i++) { int j = (i + 1) % n; l += hypot(x[j] - x[i], z[j] - z[i]); }
  return l;
}
/* n points evenly spaced along the closed polyline (x, z, m points) */
void resample(const double *x, const double *z, int m, int n, double *ox, double *oz) {
  cum[0] = 0;
  for (int i = 1; i <= m; i++) cum[i] = cum[i - 1] + hypot(x[i % m] - x[i - 1], z[i % m] - z[i - 1]);
  double Lt = cum[m]; int j = 0;
  for (int k = 0; k < n; k++) {
    double s = k * Lt / n;
    while (j < m - 1 && cum[j + 1] < s) j++;
    double seg = cum[j + 1] - cum[j], f = (s - cum[j]) / (seg > 0 ? seg : 1);
    ox[k] = lerpd(x[j], x[(j + 1) % m], f); oz[k] = lerpd(z[j], z[(j + 1) % m], f);
  }
}
double maxCurv(const double *x, const double *z, int n, double step) {
  const int k = 3; double mx = 0;
  for (int i = 0; i < n; i++) {
    int a = mod(i - k, n), c = (i + k) % n;
    double t1 = atan2(z[i] - z[a], x[i] - x[a]), t2 = atan2(z[c] - z[i], x[c] - x[i]);
    double kk = fabs(angd(t2, t1)) / (k * step);
    if (kk > mx) mx = kk;
  }
  return mx;
}
void smoothOnce(double *x, double *z, int n) {
  for (int i = 0; i < n; i++) { int a = mod(i - 1, n), c = (i + 1) % n;
    vx[i] = 0.25 * x[a] + 0.5 * x[i] + 0.25 * x[c]; vz[i] = 0.25 * z[a] + 0.5 * z[i] + 0.25 * z[c]; }
  for (int i = 0; i < n; i++) { x[i] = vx[i]; z[i] = vz[i]; }
}

/* spatial hash of every other centreline point, 20 m cells */
inline int cellOf(double v) { return (int)floor(v / 20); }
inline int hashCell(int gx, int gz) { return (int)(((unsigned)gx * 73856093u) ^ ((unsigned)gz * 19349663u)) & (GB - 1); }
void gridBuild() {
  for (int i = 0; i < GB; i++) gHead[i] = -1;
  for (int i = 0; i < N; i += 2) { int h = hashCell(cellOf(PX[i]), cellOf(PZ[i])); gNext[i] = gHead[h]; gHead[h] = i; }
}
/* any centreline point within r of (x, z); points within `far` samples of `self` along the lap are ignored */
bool nearTrack(double x, double z, double r, int self, int far) {
  int gx = cellOf(x), gz = cellOf(z), cells = (int)ceil(r / 20);
  if (cells < 1) cells = 1;
  for (int a = -cells; a <= cells; a++) for (int b = -cells; b <= cells; b++) {
    int cx = gx + a, cz = gz + b;
    for (int j = gHead[hashCell(cx, cz)]; j >= 0; j = gNext[j]) {
      if (cellOf(PX[j]) != cx || cellOf(PZ[j]) != cz) continue;
      if (self >= 0) { int d = abs(j - self); if (N - d < d) d = N - d; if (d < far) continue; }
      if (hypot(PX[j] - x, PZ[j] - z) < r) return true;
    }
  }
  return false;
}
bool segX(double ax, double az, double bx, double bz, double cx, double cz, double dx, double dz, double *t = nullptr) {
  double d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax), d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  if (d1 * d2 >= 0) return false;
  double d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx), d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  if (d3 * d4 >= 0) return false;
  if (t) *t = d3 / (d3 - d4);   // where along a->b the barrier is crossed
  return true;
}
void worldPos(double s, double lat, double *x, double *z, double *y) {
  double u = wrapS(s) / DS; int i = (int)u % N, j = (i + 1) % N; double f = u - floor(u);
  double tx = lerpd(TX[i], TX[j], f), tz = lerpd(TZ[i], TZ[j], f), tl = hypot(tx, tz); if (tl <= 0) tl = 1;
  tx /= tl; tz /= tl;
  *x = lerpd(PX[i], PX[j], f) - tz * lat; *z = lerpd(PZ[i], PZ[j], f) + tx * lat; *y = lerpd(HH[i], HH[j], f);
}
}  // namespace

extern "C" {
EXPORT(track_raw) double *track_raw(void) { return raw; }
EXPORT(track_px) double *track_px(void) { return PX; }
EXPORT(track_pz) double *track_pz(void) { return PZ; }
EXPORT(track_tx) double *track_tx(void) { return TX; }
EXPORT(track_tz) double *track_tz(void) { return TZ; }
EXPORT(track_h) double *track_h(void) { return HH; }
EXPORT(track_sl) double *track_sl(void) { return SL; }
EXPORT(track_kc) double *track_kc(void) { return KC; }
EXPORT(track_lat) double *track_lat(void) { return LAT; }
EXPORT(track_vprof) double *track_vprof(void) { return VP; }
EXPORT(track_wlx) double *track_wlx(void) { return WLX; }
EXPORT(track_wlz) double *track_wlz(void) { return WLZ; }
EXPORT(track_wrx) double *track_wrx(void) { return WRX; }
EXPORT(track_wrz) double *track_wrz(void) { return WRZ; }
EXPORT(track_wgl) uint8_t *track_wgl(void) { return WGL; }
EXPORT(track_wgr) uint8_t *track_wgr(void) { return WGR; }
EXPORT(track_corners) double *track_corners(void) { return CORN; }
EXPORT(track_ncorners) int track_ncorners(void) { return NCORN; }
EXPORT(track_len) double track_len(void) { return LEN; }
EXPORT(track_ds) double track_ds(void) { return DS; }
EXPORT(track_crest) double track_crest(void) { return CREST; }

/* The default circuit: eight corners of given radius joined by straights, as a dense polyline in raw[].
   Returns the number of points. */
EXPORT(track_default) int track_default(void) {
  static const double V[8][2] = {{-450, 0}, {550, 0}, {600, 260}, {420, 420}, {150, 400}, {0, 560}, {-300, 560}, {-520, 330}};
  static const double RAD[8] = {40, 35, 120, 30, 60, 45, 150, 50};
  const int n = 8;
  double p1[8][2], p2[8][2], ax[8], az[8], phi[8];
  for (int i = 0; i < n; i++) {
    const double *P = V[(i + n - 1) % n], *C = V[i], *Q = V[(i + 1) % n];
    double a_x = C[0] - P[0], a_z = C[1] - P[1], al = hypot(a_x, a_z); a_x /= al; a_z /= al;
    double b_x = Q[0] - C[0], b_z = Q[1] - C[1], bl = hypot(b_x, b_z); b_x /= bl; b_z /= bl;
    phi[i] = atan2(a_x * b_z - a_z * b_x, a_x * b_x + a_z * b_z);
    double t = RAD[i] * tan(fabs(phi[i]) / 2);
    p1[i][0] = C[0] - a_x * t; p1[i][1] = C[1] - a_z * t; p2[i][0] = C[0] + b_x * t; p2[i][1] = C[1] + b_z * t;
    ax[i] = a_x; az[i] = a_z;
  }
  int m = 0;
  for (int i = 0; i < n; i++) {
    double sg = phi[i] >= 0 ? 1 : -1, R = RAD[i];
    double cx = p1[i][0] - az[i] * R * sg, cz = p1[i][1] + ax[i] * R * sg, th0 = atan2(p1[i][1] - cz, p1[i][0] - cx);
    int arc = (int)fmax(4, ceil(R * fabs(phi[i]) / 0.5));
    for (int k = 0; k < arc && m < MAXRAW; k++) { double th = th0 + phi[i] * k / arc; raw[2 * m] = cx + R * cos(th); raw[2 * m + 1] = cz + R * sin(th); m++; }
    int nx = (i + 1) % n; double sl = hypot(p1[nx][0] - p2[i][0], p1[nx][1] - p2[i][1]);
    int st = (int)fmax(1, ceil(sl / 0.5));
    for (int k = 0; k < st && m < MAXRAW; k++) { double u = (double)k / st; raw[2 * m] = lerpd(p2[i][0], p1[nx][0], u); raw[2 * m + 1] = lerpd(p2[i][1], p1[nx][1], u); m++; }
  }
  return m;
}

/* Build the track from nraw points in raw[]. Returns the number of samples N (about one per metre). */
EXPORT(track_build) int track_build(int nraw) {
  if (nraw < 3) return 0;
  if (nraw > MAXRAW) nraw = MAXRAW;
  for (int i = 0; i < nraw; i++) { vx[i] = raw[2 * i]; vz[i] = raw[2 * i + 1]; }
  // 1. clean shape: 2 m spacing, smooth until no corner is tighter than an 18 m radius, keep the lap length
  double target = polyLen(vx, vz, nraw);
  int n = (int)fmax(60, round(target / 2)); if (n > MAXRAW) n = MAXRAW;
  resample(vx, vz, nraw, n, wx, wz);
  double step = target / n;
  for (int it = 0; it < 900; it++) { if (it % 4 == 0 && maxCurv(wx, wz, n, step) < 1.0 / 18) break; smoothOnce(wx, wz, n); }
  double cur = polyLen(wx, wz, n), cx = 0, cz = 0;
  for (int i = 0; i < n; i++) { cx += wx[i]; cz += wz[i]; }
  cx /= n; cz /= n;
  double k = target / cur;
  for (int i = 0; i < n; i++) { wx[i] = (wx[i] - cx) * k; wz[i] = (wz[i] - cz) * k; }
  LEN = polyLen(wx, wz, n); N = (int)round(LEN); if (N > MAXN) N = MAXN; if (N < 16) N = 16; DS = LEN / N;
  resample(wx, wz, n, N, PX, PZ);
  // 2. tangents, curvature, corners
  for (int i = 0; i < N; i++) {
    int a = mod(i - 1, N), b = (i + 1) % N; double tx = PX[b] - PX[a], tz = PZ[b] - PZ[a], l = hypot(tx, tz); if (l <= 0) l = 1;
    TX[i] = tx / l; TZ[i] = tz / l; TH[i] = atan2(TZ[i], TX[i]);
  }
  for (int i = 0; i < N; i++) KC[i] = angd(TH[(i + 3) % N], TH[mod(i - 3, N)]) / (6 * DS);
  for (int i = 0; i < N; i++) { double a = 0; for (int d = -8; d <= 8; d++) a += KC[mod(i + d, N)]; KS[i] = a / 17; }
  const double thr = 1.0 / 320;
  int i0 = 0; while (i0 < N && fabs(KS[i0]) > thr) i0++; if (i0 >= N) i0 = 0;
  NCORN = 0; int rs = -1, re = -1; double rsg = 0;
  auto flush = [&]() {
    if (rs < 0) return;
    double ang = 0; for (int k2 = rs; k2 <= re; k2++) ang += KC[(i0 + k2) % N] * DS;
    if (fabs(ang) >= 0.3 && NCORN < MAXCORN) {
      double *c = &CORN[4 * NCORN++]; c[0] = ((i0 + rs) % N) * DS; c[1] = ((i0 + re) % N) * DS; c[2] = rsg; c[3] = ang;
    }
  };
  for (int k2 = 0; k2 < N; k2++) {
    int i = (i0 + k2) % N; double sg = sgn(KS[i]);
    if (fabs(KS[i]) > thr) {
      if (rs >= 0 && rsg == sg && k2 - re <= 12) re = k2;
      else { flush(); rs = re = k2; rsg = sg; }
    }
  }
  flush();
  // sort corners by s0
  for (int a = 1; a < NCORN; a++) for (int b = a; b > 0 && CORN[4 * b] < CORN[4 * (b - 1)]; b--)
    for (int q = 0; q < 4; q++) { double t = CORN[4 * b + q]; CORN[4 * b + q] = CORN[4 * (b - 1) + q]; CORN[4 * (b - 1) + q] = t; }
  // 3. elevation: rolls plus a crest a little past the middle of the longest straight
  LONG_S0 = 0; LONG_LEN = LEN;
  if (NCORN) { LONG_LEN = -1;
    for (int c = 0; c < NCORN; c++) { double s0 = CORN[4 * c + 1], s1 = CORN[4 * ((c + 1) % NCORN)], len = wrapS(s1 - s0); if (len == 0) len = LEN;
      if (len > LONG_LEN) { LONG_LEN = len; LONG_S0 = s0; } } }
  CREST = wrapS(LONG_S0 + clampd(LONG_LEN * 0.55, 60, fmax(60, LONG_LEN - 90)));
  for (int i = 0; i < N; i++) HH[i] = 0;   // flat: no rolls, no crest
  for (int i = 0; i < N; i++) SL[i] = (HH[(i + 1) % N] - HH[mod(i - 1, N)]) / (2 * DS);
  // 4. barriers, with gaps where another part of the track is close
  for (int i = 0; i < N; i++) {
    WLX[i] = PX[i] + TZ[i] * WALL; WLZ[i] = PZ[i] - TX[i] * WALL; WRX[i] = PX[i] - TZ[i] * WALL; WRZ[i] = PZ[i] + TX[i] * WALL;
  }
  gridBuild();
  int far = (int)round(60 / DS);
  for (int i = 0; i < N; i++) {
    WGL[i] = nearTrack(WLX[i], WLZ[i], HW + 0.8, i, far); WGR[i] = nearTrack(WRX[i], WRZ[i], HW + 0.8, i, far);
  }
  // 5. racing line: elastic band relaxation at shrinking spans (outside-inside-outside falls out of it)
  const double Wr = HW - 1.3;
  for (int i = 0; i < N; i++) LAT[i] = 0;
  const int spans[4] = {60, 30, 15, 7};
  for (int sp : spans) for (int it = 0; it < 50; it++) for (int i = 0; i < N; i++) {
    int a = mod(i - sp, N), b = (i + sp) % N;
    double mx = (PX[a] - TZ[a] * LAT[a] + PX[b] - TZ[b] * LAT[b]) / 2, mz = (PZ[a] + TX[a] * LAT[a] + PZ[b] + TX[b] * LAT[b]) / 2;
    LAT[i] = clampd((mx - PX[i]) * (-TZ[i]) + (mz - PZ[i]) * TX[i], -Wr, Wr);
  }
  for (int i = 0; i < N; i++) { QX[i] = PX[i] - TZ[i] * LAT[i]; QZ[i] = PZ[i] + TX[i] * LAT[i]; }
  for (int i = 0; i < N; i++) { int a = mod(i - 3, N), b = (i + 3) % N; QA[i] = atan2(QZ[b] - QZ[a], QX[b] - QX[a]); }
  for (int i = 0; i < N; i++) { int a = mod(i - 4, N), b = (i + 4) % N; KR[i] = angd(QA[b], QA[a]) / (8 * DS); }
  // speed profile: lateral grip limit on the line's curvature, then braking and traction passes
  const double ALAT = 20, DEC = 22, ACCP = 8.5, VCAP = 83;
  for (int i = 0; i < N; i++) {
    double s2 = 0; for (int d = -6; d <= 6; d++) s2 += fabs(KR[mod(i + d, N)]); s2 /= 13;
    VP[i] = fmin(VCAP, s2 > 1e-5 ? sqrt(ALAT / s2) : VCAP);
  }
  for (int rep = 0; rep < 3; rep++) {
    for (int i = N - 1; i >= 0; i--) { int b = (i + 1) % N; VP[i] = fmin(VP[i], sqrt(VP[b] * VP[b] + 2 * DEC * DS)); }
    for (int i = 0; i < N; i++) { int a = mod(i - 1, N); VP[i] = fmin(VP[i], sqrt(VP[a] * VP[a] + 2 * ACCP * DS)); }
  }
  return N;
}

/* is another part of the circuit within r of (x, z)? self/far skip the stretch around sample `self` (-1: none) */
EXPORT(track_near) int track_near(double x, double z, double r, int self, int far) { return N ? nearTrack(x, z, r, self, far) : 0; }

/* Can a point at height hA over (sA, latA) see one at height hB over (sB, latB) further along the lap?
   Blocked where the sight line crosses a guardrail below its top (BARRIER_H over the ground there; a driver's eye
   at ~1 m sees over it to anything tall enough, the radar low in the nose does not), or by the road rising above
   the sight line (a crest). */
EXPORT(track_los) int track_los(double sA, double latA, double hA, double sB, double latB, double hB) {
  double d = dSigned(sA, sB); if (d <= 0) return 0;
  double ax, az, ay, bx, bz, by; worldPos(sA, latA, &ax, &az, &ay); worldPos(sB, latB, &bx, &bz, &by);
  int i0 = (int)floor(wrapS(sA) / DS), steps = (int)floor(d / DS);
  double ya = ay + hA, yb = by + hB, t;
  for (int k = 1; k < steps; k += 2) {
    int i = (i0 + k) % N, j = (i0 + k + 2) % N;
    if (!WGL[i] && !WGL[j] && segX(ax, az, bx, bz, WLX[i], WLZ[i], WLX[j], WLZ[j], &t) && ya + (yb - ya) * t < HH[i] + BARRIER_H) return 0;
    if (!WGR[i] && !WGR[j] && segX(ax, az, bx, bz, WRX[i], WRZ[i], WRX[j], WRZ[j], &t) && ya + (yb - ya) * t < HH[i] + BARRIER_H) return 0;
  }
  for (int k = 2; k < steps - 1; k += 2) { double f = (double)k / steps; if (HH[(i0 + k) % N] + 0.12 > ya + (yb - ya) * f) return 0; }
  return 1;
}

/* standing water, mm: a film that grows with the rain, deeper toward the edges where the camber drains it, thinner
   on the racing line the cars keep clearing, and puddles in patches where the surface dips */
EXPORT(track_water) double track_water(double s, double lat, double rain) {
  if (rain <= 0 || !N) return 0;
  double edge = clampd((fabs(lat) - HW * 0.5) / (HW * 0.5), 0, 1), dl = lat - sampleArr(LAT, s), line = exp(-dl * dl / 2);
  double pud = fmax(0, sin(s * 0.021 + 1.3) * sin(s * 0.0137 - lat * 0.4 + 0.7) - 0.35) * 2.2;
  return rain * (0.4 + 1.6 * rain) * (1 + 0.8 * edge) * (1 - 0.35 * line) + rain * rain * 3.5 * pud;
}
}

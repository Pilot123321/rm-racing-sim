/* Circuit screenshot -> closed lap, C++ (compiled into public/physics.wasm).

   The page scales the image to at most TMAX px on its long side and copies the RGBA pixels into trace_rgba().
   1. colour mask: pixels near the picked track colour, or (auto) pixels far from the median border colour
   2. close small gaps (3x3 dilate then erode) and keep the largest 4-connected blob
   3. thin it to a one-pixel centreline (Zhang-Suen) and prune dead-end spurs
   4. walk the centreline loop preferring straight-on steps; if that fails, trace the blob outline (Moore neighbour)
   Output: every other point of the loop as (x, y) pixel pairs in trace_points(). */
#include "physics.h"

namespace {
constexpr int TMAX = 400, TN = TMAX * TMAX;
uint8_t rgba[TN * 4], mask[TN], tmp[TN], comp[TN], sk[TN], vis[TN];
int lab[TN], que[TN], on[TN], path[TN], outPts[TN * 2];
int method = 0;
uint8_t bordR[4 * TMAX], bordG[4 * TMAX], bordB[4 * TMAX];

double dist(int i, int r, int g, int b) {
  double dr = rgba[i * 4] - r, dg = rgba[i * 4 + 1] - g, db = rgba[i * 4 + 2] - b;
  return sqrt(dr * dr + dg * dg + db * db);
}
int median(uint8_t *a, int n) {  // counting sort, values are bytes
  int h[256] = {0}; for (int i = 0; i < n; i++) h[a[i]]++;
  int c = 0; for (int v = 0; v < 256; v++) { c += h[v]; if (c > n / 2) return v; }
  return 255;
}
void morph(const uint8_t *src, uint8_t *dst, int W, int H, bool dilate) {
  for (int i = 0; i < W * H; i++) dst[i] = 0;
  for (int y = 1; y < H - 1; y++) for (int x = 1; x < W - 1; x++) {
    int i = y * W + x; uint8_t v = dilate ? 0 : 1;
    for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
      uint8_t s = src[i + dy * W + dx];
      if (dilate && s) v = 1;
      if (!dilate && !s) v = 0;
    }
    dst[i] = v;
  }
}
/* Zhang-Suen thinning */
void thin(uint8_t *m, int W, int H) {
  for (int x = 0; x < W; x++) { m[x] = 0; m[(H - 1) * W + x] = 0; }
  for (int y = 0; y < H; y++) { m[y * W] = 0; m[y * W + W - 1] = 0; }
  bool changed = true;
  while (changed) {
    changed = false;
    for (int pass = 0; pass < 2; pass++) {
      int nd = 0;
      for (int y = 1; y < H - 1; y++) for (int x = 1; x < W - 1; x++) {
        int i = y * W + x; if (!m[i]) continue;
        int p2 = m[i - W], p3 = m[i - W + 1], p4 = m[i + 1], p5 = m[i + W + 1], p6 = m[i + W], p7 = m[i + W - 1], p8 = m[i - 1], p9 = m[i - W - 1];
        int B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9; if (B < 2 || B > 6) continue;
        int A = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) + (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
        if (A != 1) continue;
        if (pass == 0) { if (p2 && p4 && p6) continue; if (p4 && p6 && p8) continue; }
        else { if (p2 && p4 && p8) continue; if (p2 && p6 && p8) continue; }
        que[nd++] = i;
      }
      if (nd) { changed = true; for (int k = 0; k < nd; k++) m[que[k]] = 0; }
    }
  }
}
/* Moore-neighbour boundary trace of the blob; returns the number of path points */
int moore(const uint8_t *m, int W, int H) {
  static const int D[8][2] = {{-1, 0}, {-1, -1}, {0, -1}, {1, -1}, {1, 0}, {1, 1}, {0, 1}, {-1, 1}};
  int start = -1; for (int i = 0; i < W * H; i++) if (m[i]) { start = i; break; }
  if (start < 0) return 0;
  int n = 0, c = start, bd = 0;
  for (int g = 0; g < W * H * 2 && n < TN; g++) {
    path[n++] = c; bool found = false;
    for (int k = 1; k <= 8; k++) {
      int di = (bd + k) % 8, x = c % W + D[di][0], y = c / W + D[di][1];
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      int j = y * W + x;
      if (m[j]) {
        int pd = (bd + k - 1) % 8, bx = c % W + D[pd][0], by = c / W + D[pd][1], ddx = bx - x, ddy = by - y;
        c = j; bd = 0;
        for (int q = 0; q < 8; q++) if (D[q][0] == ddx && D[q][1] == ddy) { bd = q; break; }
        found = true; break;
      }
    }
    if (!found || (c == start && n > 2)) break;
  }
  return n;
}
}  // namespace

extern "C" {
EXPORT(trace_rgba) uint8_t *trace_rgba(void) { return rgba; }
EXPORT(trace_points) int *trace_points(void) { return outPts; }
EXPORT(trace_method) int trace_method(void) { return method; }  // 0 centreline, 1 outline
EXPORT(trace_max) int trace_max(void) { return TMAX; }

/* Returns the number of output points, or -1 no track found, -2 most of the image matched, -3 could not follow it. */
EXPORT(trace_run) int trace_run(int W, int H, int pick, int pr, int pg, int pb, double tol) {
  if (W < 3 || H < 3 || W > TMAX || H > TMAX) return -1;
  const int n = W * H;
  // 1. colour mask
  if (!pick) {
    int k = 0;
    auto take = [&](int i) { bordR[k] = rgba[i * 4]; bordG[k] = rgba[i * 4 + 1]; bordB[k] = rgba[i * 4 + 2]; k++; };
    for (int x = 0; x < W; x++) { take(x); take((H - 1) * W + x); }
    for (int y = 0; y < H; y++) { take(y * W); take(y * W + W - 1); }
    pr = median(bordR, k); pg = median(bordG, k); pb = median(bordB, k);
  }
  for (int i = 0; i < n; i++) { double d = dist(i, pr, pg, pb); mask[i] = pick ? d < tol : d > tol; }
  // 2. close gaps, keep the largest blob
  morph(mask, tmp, W, H, true); morph(tmp, mask, W, H, false);
  for (int i = 0; i < n; i++) lab[i] = -1;
  int best = -1, bestA = 0;
  for (int i = 0; i < n; i++) {
    if (!mask[i] || lab[i] >= 0) continue;
    int h = 0, t = 0, a = 0; que[t++] = i; lab[i] = i;
    while (h < t) {
      int j = que[h++]; a++; int x = j % W, y = j / W;
      const int nb[4][2] = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
      for (auto &d : nb) { int xx = x + d[0], yy = y + d[1]; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        int k = yy * W + xx; if (mask[k] && lab[k] < 0) { lab[k] = i; que[t++] = k; } }
    }
    if (a > bestA) { bestA = a; best = i; }
  }
  if (best < 0 || bestA < 150) return -1;
  if (bestA > n * 0.5) return -2;
  for (int i = 0; i < n; i++) { comp[i] = lab[i] == best; sk[i] = comp[i]; }
  // 3. centreline, dead ends pruned
  thin(sk, W, H);
  auto nbs = [&](int i) { return sk[i - W - 1] + sk[i - W] + sk[i - W + 1] + sk[i - 1] + sk[i + 1] + sk[i + W - 1] + sk[i + W] + sk[i + W + 1]; };
  int non = 0; for (int i = 0; i < n; i++) if (sk[i]) on[non++] = i;
  for (int guard = 0; guard < 4000; guard++) {
    int rem = 0; for (int k = 0; k < non; k++) if (nbs(on[k]) <= 1) que[rem++] = on[k];
    if (!rem) break;
    for (int k = 0; k < rem; k++) sk[que[k]] = 0;
    int w = 0; for (int k = 0; k < non; k++) if (sk[on[k]]) on[w++] = on[k]; non = w;
  }
  // 4. walk the loop, straight-on first
  int np = 0; method = 0;
  if (non > 40) {
    static const int OFF[8][2] = {{1, 0}, {1, 1}, {0, 1}, {-1, 1}, {-1, 0}, {-1, -1}, {0, -1}, {1, -1}};
    int start = on[0]; for (int k = 0; k < non; k++) if (nbs(on[k]) == 2) { start = on[k]; break; }
    for (int i = 0; i < n; i++) vis[i] = 0;
    vis[start] = 1; path[0] = start; np = 1; int cur = start; bool closed = false;
    for (int g = 0; g < non + 5; g++) {
      int cx = cur % W, cy = cur / W;
      if (np > 30) { for (auto &o : OFF) if ((cy + o[1]) * W + cx + o[0] == start) { closed = true; break; } if (closed) break; }
      int pdx = 0, pdy = 0;
      if (np > 1) { int p0 = path[np - 5 > 0 ? np - 5 : 0]; pdx = cx - p0 % W; pdy = cy - p0 / W; }
      int bj = -1; double bs = -1e9;
      for (auto &o : OFF) {
        int j = (cy + o[1]) * W + cx + o[0]; if (!sk[j] || vis[j]) continue;
        double sc = (pdx || pdy) ? (o[0] * pdx + o[1] * pdy) / hypot(o[0], o[1]) / hypot(pdx, pdy) : 0;
        if (!o[0] || !o[1]) sc += 0.02;
        if (sc > bs) { bs = sc; bj = j; }
      }
      if (bj < 0) break;
      vis[bj] = 1; path[np++] = bj; cur = bj;
    }
    if (!(closed && np > 40)) np = 0;
  }
  if (!np) { method = 1; np = moore(comp, W, H); if (np < 40) return -3; }
  int m = 0; for (int i = 0; i < np; i += 2) { outPts[2 * m] = path[i] % W; outPts[2 * m + 1] = path[i] / W; m++; }
  return m;
}
}

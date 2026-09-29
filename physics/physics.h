/* Look-Ahead Radar physics core, compiled to WebAssembly (public/physics.wasm) for the game and to a native
   shared library for the Python tests in tools/. No allocation: every buffer is static, so wasm memory never
   grows and JavaScript can keep typed-array views on it. */
#ifndef LAR_PHYSICS_H
#define LAR_PHYSICS_H
#include <math.h>
#include <stdint.h>

#ifdef __wasm__
#define EXPORT(name) __attribute__((export_name(#name)))
#else
#define EXPORT(name) __attribute__((visibility("default")))
#endif

#define PI 3.14159265358979323846
#define G0 9.81

static inline double clampd(double x, double a, double b) { return x < a ? a : x > b ? b : x; }
static inline double sgn(double x) { return (x > 0) - (x < 0); }
static inline double lerpd(double a, double b, double t) { return a + (b - a) * t; }

/* xorshift64* random numbers; each module keeps its own stream so results are reproducible */
typedef struct { uint64_t s; } rng_t;
static inline double rng_u(rng_t *r) {
  r->s ^= r->s >> 12; r->s ^= r->s << 25; r->s ^= r->s >> 27;
  return (double)((r->s * 2685821657736338717ULL) >> 11) * (1.0 / 9007199254740992.0);
}
static inline double rng_n(rng_t *r) { /* standard normal, Box-Muller */
  double u = rng_u(r) + 1e-12, v = rng_u(r);
  return sqrt(-2.0 * log(u)) * cos(2.0 * PI * v);
}
#endif

"""ctypes binding to the native build of physics/*.c (build/libphysics.*), the same code the game runs as wasm."""
import ctypes, pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
LIB = ctypes.CDLL(str(ROOT / "build" / ("libphysics.dylib" if sys.platform == "darwin" else "libphysics.so")))
D, I, PD, PF = ctypes.c_double, ctypes.c_int, ctypes.POINTER(ctypes.c_double), ctypes.POINTER(ctypes.c_float)
SIG = {
    "radar_sinr": (D, [D] * 8), "radar_two_ray": (D, [D] * 4), "radar_rain_db": (D, [D]), "radar_rain_rate": (D, [D]),
    "radar_radome": (D, [D]), "radar_fog_kl": (D, [D, D]), "radar_set_fog": (None, [D, D]), "radar_fog_db": (D, []), "radar_range90": (D, [D]), "radar_out": (PD, []), "radar_seed": (None, [D]),
    "radar_begin": (None, []), "radar_return": (I, [D] * 10 + [I]), "radar_resolve": (I, [D] * 6),
    "radar_track": (I, [D] * 5), "radar_det": (PD, []), "radar_tracks": (PD, []),
    "spray_emit": (None, [I] + [D] * 6), "spray_update": (None, [D, D]), "spray_clear": (None, []),
    "spray_height_q": (D, [D]), "spray_vt": (D, [D]), "spray_count": (I, []),
    "track_default": (I, []), "track_build": (I, [I]), "track_len": (D, []), "track_ncorners": (I, []), "track_crest": (D, []), "track_corners": (PD, []), "track_h": (PD, []),
    "track_los": (I, [D] * 6), "track_near": (I, [D, D, D, I, I]), "track_water": (D, [D, D, D]), "track_raw": (PD, []),
    "track_vprof": (PD, []), "track_lat": (PD, []),
    "trace_rgba": (ctypes.POINTER(ctypes.c_uint8), []), "trace_run": (I, [I, I, I, I, I, I, D]), "trace_method": (I, []),
    "trace_points": (ctypes.POINTER(ctypes.c_int), []),
    "veh_state": (PD, []), "veh_curv": (PD, []), "veh_set_track": (None, [I, D]), "veh_reset": (None, []),
    "veh_step": (None, [D, D, D, D, D]), "veh_set_control": (None, [I, I]), "veh_tc_target": (D, [I]), "veh_abs_target": (D, [I]), "veh_set_water": (None, [D]), "veh_set_surface": (None, [D] * 7), "veh_set_loose": (None, [D] * 6), "veh_set_aids": (None, [D] * 4), "veh_level_gain": (D, [I]), "veh_set_bias": (None, [D]), "veh_set_compound": (None, [I]),
    "spray_emit_tyre": (None, [I] + [D] * 8),
}
for name, (res, args) in SIG.items():
    f = getattr(LIB, name); f.restype = res; f.argtypes = args

# vehicle state layout, same order as the enum in physics/vehicle.c and VEH_FIELDS in game.js
VEH_FIELDS = ["s", "lat", "psi", "vx", "vy", "r", "wf", "wr", "kf", "kr", "af", "ar", "FyfS", "FyrS", "ax", "ay",
              "thr", "brk", "delta", "gear", "cut", "rpm", "hitV", "latV", "v", "sliding", "beta",
              "satF", "satR", "mz", "gripF", "gripR", "aqua", "rev",
              "tempF", "tempR", "wearF", "wearR", "tyreF", "tyreR", "brakeT",
              "pbF", "pbR", "tcCut", "tcI", "absF", "absR", "padMu",
              "brakeTR", "bCoreF", "bCoreR", "regen", "dirtF", "dirtR", "flatF", "flatR", "bump"]

"""Engine sound: seamless V8 loops cut from real recordings.

    .venv/bin/python tools/engine_samples.py       # writes public/assets/engine/*.wav + CREDITS.txt (needs ffmpeg)

Sources (Wikimedia Commons, free licences, see CREDITS.txt):
  Maserati GranTurismo S exhaust (4.2/4.7 l V8), lmartins via freesound, CC BY 4.0: idle, low revs, free revving
  Bentley Speed 8 (2003 Le Mans winner, 4.0 l twin-turbo V8), Edvvc, CC BY-SA 3.0: pulling away under full load

A V8 fires four times per crankshaft revolution, so the firing frequency is rpm / 15. For each chosen stretch:
  1. track the firing frequency (autocorrelation, parabolic peak, searched in a band around the known pitch,
     median-smoothed)
  2. flatten it: resample along the engine's own phase so the firing frequency is exactly constant (the stretch
     becomes one steady rpm, and its cycle length is known to the sample)
  3. cut a whole number of engine cycles (8 firings = 2 revolutions, so the cross-plane V8's uneven beat repeats
     exactly) and crossfade the end into the start: a seamless loop
  4. normalise loudness (RMS)
The game then plays each loop at playbackRate = rpm / loop rpm and crossfades between them by rpm and throttle.
"""
import pathlib, subprocess, urllib.request, wave
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "assets" / "engine"
CACHE = ROOT / "build" / "engine_src"
SR = 44100          # analysis rate
OUT_SR = 32000      # loops are stored at this rate (the top of an F1 V8's useful spectrum after pitching up 3x)

SOURCES = {
    "maserati": ("https://upload.wikimedia.org/wikipedia/commons/9/98/Maserati_GranTurismo_S_Exhaust.ogg",
                 "Maserati GranTurismo S Exhaust.ogg - lmartins (freesound.org/people/lmartins/sounds/465453), CC BY 4.0"),
    "bentley": ("https://upload.wikimedia.org/wikipedia/commons/e/e3/Bentley-Speed-8-2003.ogg",
                "Bentley-Speed-8-2003.ogg - Edvvc (commons.wikimedia.org/wiki/User:Edvvc), CC BY-SA 3.0"),
}
# name: source, start s, end s, firing-frequency search band (Hz), cycles to keep, role
LOOPS = {
    "idle": ("maserati", 3.2, 8.8, (45, 70), 12, "idle, off load"),
    "low": ("maserati", 55.3, 57.8, (100, 145), 24, "low revs, light load"),
    "high": ("maserati", 48.9, 49.6, (250, 295), 16, "free revving, off throttle"),
    "load": ("bentley", 8.3, 9.9, (235, 285), 40, "racing V8 pulling hard, full throttle"),
}


def fetch(name):
    url, _ = SOURCES[name]
    CACHE.mkdir(parents=True, exist_ok=True)
    ogg, wav = CACHE / f"{name}.ogg", CACHE / f"{name}.wav"
    if not ogg.exists():
        req = urllib.request.Request(url, headers={"User-Agent": "rm-sim engine_samples.py"})
        ogg.write_bytes(urllib.request.urlopen(req).read())
    if not wav.exists():
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(ogg), "-ac", "1", "-ar", str(SR), str(wav)], check=True)
    w = wave.open(str(wav))
    return np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float64) / 32768


def track(x, band, N=4096, hop=256):
    """firing frequency every hop samples, searched in band (Hz)"""
    lo, hi = band
    a, b = int(SR / hi), int(SR / lo) + 2
    ts, fs = [], []
    win = np.hanning(N)
    for i in range(0, len(x) - N, hop):
        f = x[i:i + N] * win
        F = np.fft.rfft(f, 2 * N)
        ac = np.fft.irfft(np.abs(F) ** 2)[:N]
        ac /= ac[0] + 1e-12
        k = a + int(np.argmax(ac[a:b]))
        y0, y1, y2 = ac[k - 1], ac[k], ac[k + 1]            # parabolic peak for sub-sample lag
        d = 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2 + 1e-12)
        ts.append((i + N / 2) / SR); fs.append(SR / (k + d))
    fs = np.array(fs)
    k = 9                                                  # median smoothing
    pad = np.pad(fs, k // 2, mode="edge")
    fs = np.array([np.median(pad[i:i + k]) for i in range(len(fs))])
    return np.array(ts), fs


def flatten(x, ts, fs, f0):
    """resample x along its own phase so its firing frequency becomes exactly f0"""
    t = np.arange(len(x)) / SR
    f = np.interp(t, ts, fs)
    phase = np.cumsum(f) / SR                              # firings elapsed
    n_out = int(phase[-1] / f0 * SR)
    target = np.arange(n_out) * f0 / SR                    # phase wanted at each output sample
    src = np.interp(target, phase, np.arange(len(x)))      # input sample index with that phase
    return np.interp(src, np.arange(len(x)), x)


def make_loop(name):
    src, t0, t1, band, cycles, role = LOOPS[name]
    x = fetch(src)
    seg = x[int(t0 * SR):int(t1 * SR)]
    ts, fs = track(seg, band)
    f0 = float(np.median(fs))
    flat = flatten(seg, ts, fs, f0)
    per_cycle = 8 * SR / f0                                # one engine cycle: 8 firings, 2 revolutions
    cycles = min(cycles, int((len(flat) - 0.05 * SR) / per_cycle))
    L = int(round(cycles * per_cycle))
    xf = int(0.03 * SR)                                    # 30 ms crossfade: the tail blends into the head
    body = flat[xf:xf + L].copy()
    fade = np.linspace(0, 1, xf)
    body[-xf:] = body[-xf:] * (1 - fade) + flat[:xf] * fade
    body -= body.mean()
    # to the storage rate, loudness normalised
    n2 = int(round(len(body) * OUT_SR / SR))
    out = np.interp(np.arange(n2) * SR / OUT_SR, np.arange(len(body)), body)
    out *= 0.25 / (np.sqrt((out ** 2).mean()) + 1e-9)
    out = np.clip(out, -1, 1)
    OUT.mkdir(parents=True, exist_ok=True)
    w = wave.open(str(OUT / f"{name}.wav"), "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(OUT_SR)
    w.writeframes((out * 32767).astype(np.int16).tobytes()); w.close()
    rpm = f0 * 15
    spread = (fs.max() - fs.min()) / f0 * 100
    print(f"{name:5s} {rpm:6.0f} rpm  {cycles} cycles  {len(out) / OUT_SR:.2f} s  (pitch spread before flattening {spread:.1f} %)  {role}")
    return {"rpm": round(rpm, 1), "role": role, "src": src}


def main():
    meta = {k: make_loop(k) for k in LOOPS}
    (OUT / "loops.json").write_text(__import__("json").dumps(meta, indent=1) + "\n")
    credits = ["Engine loops in this folder are cut, pitch-flattened and looped from these recordings",
               "(tools/engine_samples.py). The derived loops keep the source licences:", ""]
    for k, (src, *_r) in LOOPS.items():
        credits.append(f"{k}.wav  <-  {SOURCES[src][1]}")
    credits += ["", "CC BY 4.0: https://creativecommons.org/licenses/by/4.0/",
                "CC BY-SA 3.0: https://creativecommons.org/licenses/by-sa/3.0/ (load.wav is shared under the same licence)"]
    (OUT / "CREDITS.txt").write_text("\n".join(credits) + "\n")


if __name__ == "__main__":
    main()

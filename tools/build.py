"""Build the C/C++ physics core.

    .venv/bin/python tools/build.py          # public/physics.wasm (browser) + build/libphysics.<ext> (tests)

Uses the Zig toolchain from the `ziglang` pip package (clang + wasm-ld bundled), so no system LLVM is needed.
C files (vehicle, radar, spray) and C++ files (track, trace) are compiled to objects and linked into one module.
The wasm is a WASI "reactor" with no imports, exporting every EXPORT(...) function and its memory.
"""
import pathlib, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = sorted((ROOT / "physics").glob("*.c")) + sorted((ROOT / "physics").glob("*.cpp"))
ZIG = [sys.executable, "-m", "ziglang"]
CXXFLAGS = ["-std=c++17", "-fno-exceptions", "-fno-rtti"]


def run(tool, args):
    print("zig " + tool + " " + " ".join(str(a).replace(str(ROOT) + "/", "") for a in args))
    subprocess.run(ZIG + [tool] + [str(a) for a in args], check=True)


def build(tag, target, extra, out, link):
    objdir = ROOT / "build" / tag
    objdir.mkdir(parents=True, exist_ok=True)
    objs = []
    for src in SRC:
        obj = objdir / (src.stem + ".o")
        cpp = src.suffix == ".cpp"
        run("c++" if cpp else "cc", target + ["-O2", "-c"] + extra + (CXXFLAGS if cpp else []) + [src, "-o", obj])
        objs.append(obj)
    run("c++", target + ["-O2"] + link + objs + ["-o", out])


def main():
    wasm = ["--target=wasm32-wasi"]
    build("wasm", wasm, [], ROOT / "public" / "physics.wasm",
          ["-mexec-model=reactor", "-Wl,--no-entry", "-Wl,--export-dynamic", "-Wl,--strip-all", "-fno-exceptions"])
    ext = "dylib" if sys.platform == "darwin" else "so"
    build("native", [], ["-fPIC"], ROOT / "build" / f"libphysics.{ext}", ["-shared"])


if __name__ == "__main__":
    main()

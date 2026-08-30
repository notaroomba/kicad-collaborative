#!/usr/bin/env python3
"""Package the dev build as a relocatable "KiCad Collaborative.app" + DMG.

Takes the KiCad.app produced in the build tree (which links Homebrew and
build-tree dylibs by absolute path), copies every non-system dependency into
Contents/Frameworks, rewrites all install names to @executable_path, ad-hoc
re-signs, rebrands the bundle so it installs alongside a stock KiCad, and
wraps the result in a compressed DMG.

Usage: package_macos.py <build-dir> <out-dir> [--version 10.99]
"""

import argparse
import os
import plistlib
import shutil
import subprocess
import sys

BREW_PREFIXES = ("/opt/homebrew/", "/usr/local/opt/", "/usr/local/Cellar/")

APP_NAME = "KiCad Collaborative"
BUNDLE_ID = "org.kicad-collaborative.kicad"


def run(*cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)


def is_macho(path):
    if os.path.islink(path) or not os.path.isfile(path):
        return False
    with open(path, "rb") as f:
        magic = f.read(4)
    return magic in (b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xcf\xfa\xed\xfa")


def deps_of(path):
    out = run("otool", "-L", path).stdout.splitlines()[1:]
    return [line.split()[0] for line in out if line.strip()]


def wants_relocation(dep, build_dir):
    return dep.startswith(BREW_PREFIXES) or dep.startswith(build_dir)


def resolve(dep, referrer):
    """Resolve @rpath/@loader_path deps well enough to find the file."""
    if dep.startswith("@loader_path/"):
        return os.path.normpath(os.path.join(os.path.dirname(referrer), dep[13:]))
    if dep.startswith("@rpath/"):
        name = dep[7:]
        for root in (os.path.dirname(referrer), "/opt/homebrew/lib"):
            cand = os.path.join(root, name)
            if os.path.exists(cand):
                return cand
        return None
    return dep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("build_dir")
    ap.add_argument("out_dir")
    default_version = "1.0.0"
    version_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "VERSION")
    if os.path.exists(version_file):
        default_version = open(version_file).read().strip() or default_version
    ap.add_argument("--version", default=default_version)
    args = ap.parse_args()

    build_dir = os.path.realpath(args.build_dir)
    src_app = os.path.join(build_dir, "kicad", "KiCad.app")
    if not os.path.isdir(src_app):
        sys.exit(f"no app bundle at {src_app} — build the 'kicad' target first")

    out_dir = os.path.realpath(args.out_dir)
    staging = os.path.join(out_dir, "staging")
    app = os.path.join(staging, f"{APP_NAME}.app")
    shutil.rmtree(staging, ignore_errors=True)
    os.makedirs(staging)
    print(f"copying {src_app} …")
    run("ditto", src_app, app)

    contents = os.path.join(app, "Contents")
    fw_dir = os.path.join(contents, "Frameworks")
    os.makedirs(fw_dir, exist_ok=True)
    fw_ref = "@executable_path/../Frameworks/"

    # Every Mach-O we ship: executables, kifaces, plugins, frameworks.
    def shipped_machos():
        for root, _dirs, files in os.walk(contents):
            for f in files:
                p = os.path.join(root, f)
                if is_macho(p):
                    yield p

    # Breadth-first over dependencies: copy externals into Frameworks and
    # queue them so their own dependencies get pulled in too.
    queue = list(shipped_machos())
    copied = {}   # original dep path -> bundled basename
    by_name = {}  # any alias basename (e.g. libicudata.78.dylib) -> bundled basename
    seen = set()
    while queue:
        macho = queue.pop()
        if macho in seen:
            continue
        seen.add(macho)
        changes = []
        for dep in deps_of(macho):
            real = resolve(dep, macho)
            if real is None or not wants_relocation(real, build_dir):
                # Copied dylibs can reference siblings by an alias name
                # (@loader_path/libicudata.78.dylib vs the shipped 78.3).
                base = os.path.basename(dep)
                if dep.startswith(("@loader_path/", "@rpath/")) and base in by_name:
                    changes.append((dep, fw_ref + by_name[base]))
                continue
            if real.startswith(build_dir):
                # Build-tree Frameworks reference: same file already shipped.
                changes.append((dep, fw_ref + os.path.basename(real)))
                continue
            name = os.path.basename(os.path.realpath(real))
            if real not in copied:
                dst = os.path.join(fw_dir, name)
                if not os.path.exists(dst):
                    shutil.copy2(os.path.realpath(real), dst)
                    os.chmod(dst, 0o755)
                    queue.append(dst)
                copied[real] = name
                by_name[name] = name
                by_name[os.path.basename(real)] = name
            changes.append((dep, fw_ref + copied[real]))
        if changes:
            cmd = ["install_name_tool"]
            for old, new in changes:
                cmd += ["-change", old, new]
            if macho.startswith(fw_dir):
                cmd += ["-id", fw_ref + os.path.basename(macho)]
            cmd.append(macho)
            run(*cmd)

    print(f"bundled {len(copied)} external dylibs")

    # A second full pass catches references between freshly copied dylibs
    # (a copy queued late can still point at a brew path bundled earlier).
    for macho in shipped_machos():
        changes = []
        for dep in deps_of(macho):
            real = resolve(dep, macho)
            if real in copied:
                changes.append((dep, fw_ref + copied[real]))
            elif (
                dep.startswith(("@loader_path/", "@rpath/"))
                and (real is None or not os.path.exists(real))
                and os.path.basename(dep) in by_name
            ):
                changes.append((dep, fw_ref + by_name[os.path.basename(dep)]))
        if changes:
            cmd = ["install_name_tool"]
            for old, new in changes:
                cmd += ["-change", old, new]
            run(*cmd, macho)

    leftovers = sorted(
        {
            dep
            for macho in shipped_machos()
            for dep in deps_of(macho)
            if wants_relocation(resolve(dep, macho) or dep, build_dir)
        }
    )
    if leftovers:
        sys.exit("unrelocated dependencies remain:\n  " + "\n  ".join(leftovers))

    # Rebrand: distinct name + bundle id so LaunchServices, Dock and Spotlight
    # treat it as its own app next to a stock KiCad.  KiCad's own settings dir
    # is not derived from the bundle id, so projects and prefs behave normally.
    plist_path = os.path.join(contents, "Info.plist")
    with open(plist_path, "rb") as f:
        plist = plistlib.load(f)
    plist["CFBundleName"] = APP_NAME
    plist["CFBundleDisplayName"] = APP_NAME
    plist["CFBundleIdentifier"] = BUNDLE_ID
    plist["CFBundleShortVersionString"] = args.version
    with open(plist_path, "wb") as f:
        plistlib.dump(plist, f)

    # install_name_tool invalidates signatures; arm64 refuses to run unsigned.
    print("re-signing …")
    for macho in shipped_machos():
        run("codesign", "--force", "--sign", "-", macho)
    run("codesign", "--force", "--sign", "-", app)

    os.symlink("/Applications", os.path.join(staging, "Applications"))
    with open(os.path.join(staging, "READ ME.txt"), "w") as f:
        f.write(
            f"{APP_NAME} {args.version}\n"
            "\n"
            "Drag the app into Applications.  It installs alongside a normal\n"
            "KiCad and opens the same project files.  It never creates or\n"
            "modifies KiCad's .lck lock files, so a project can stay open in\n"
            "stock KiCad on another machine while you collaborate on it here —\n"
            "live sessions are coordinated by the collaboration server.\n"
            "\n"
            "First launch: right-click the app and choose Open (the build is\n"
            "not notarized).  Symbol/footprint libraries are not bundled; on\n"
            "first run, point the library tables at an existing KiCad\n"
            "installation's libraries or your own.\n"
        )

    dmg = os.path.join(out_dir, f"KiCad-Collaborative-{args.version}-macos.dmg")
    if os.path.exists(dmg):
        os.remove(dmg)
    print("building DMG …")
    run(
        "hdiutil", "create", "-srcfolder", staging, "-volname", APP_NAME,
        "-fs", "HFS+", "-format", "UDZO", "-imagekey", "zlib-level=9", dmg,
    )
    print(f"done: {dmg} ({os.path.getsize(dmg) // (1024 * 1024)} MB)")


if __name__ == "__main__":
    main()

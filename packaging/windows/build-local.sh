#!/usr/bin/env bash
# One-command local Windows build of the KiCad Collaborative installer.
#
# Run ON A WINDOWS MACHINE inside an MSYS2 UCRT64 shell
# (https://www.msys2.org — open "MSYS2 UCRT64" from the Start Menu):
#
#   ./packaging/windows/build-local.sh
#
# Mirrors .github/workflows/windows-installer.yml exactly; incremental
# rebuilds reuse the build/ dir and ccache, so iteration is fast.
set -euo pipefail

if [ "${MSYSTEM:-}" != "UCRT64" ]; then
    echo "Run this from an MSYS2 UCRT64 shell (not MINGW64/MSYS)." >&2
    exit 1
fi

cd "$(dirname "$0")/../.."

pacman -S --needed --noconfirm \
    git zip \
    mingw-w64-ucrt-x86_64-cmake \
    mingw-w64-ucrt-x86_64-ninja \
    mingw-w64-ucrt-x86_64-gcc \
    mingw-w64-ucrt-x86_64-ccache \
    mingw-w64-ucrt-x86_64-pkgconf \
    mingw-w64-ucrt-x86_64-abseil-cpp \
    mingw-w64-ucrt-x86_64-boost \
    mingw-w64-ucrt-x86_64-cairo \
    mingw-w64-ucrt-x86_64-curl \
    mingw-w64-ucrt-x86_64-freeglut \
    mingw-w64-ucrt-x86_64-glew \
    mingw-w64-ucrt-x86_64-glm \
    mingw-w64-ucrt-x86_64-libgit2 \
    mingw-w64-ucrt-x86_64-ngspice \
    mingw-w64-ucrt-x86_64-nng \
    mingw-w64-ucrt-x86_64-opencascade \
    mingw-w64-ucrt-x86_64-openssl \
    mingw-w64-ucrt-x86_64-protobuf \
    mingw-w64-ucrt-x86_64-python \
    mingw-w64-ucrt-x86_64-swig \
    mingw-w64-ucrt-x86_64-wxwidgets3.2-msw \
    mingw-w64-ucrt-x86_64-zlib \
    mingw-w64-ucrt-x86_64-zstd \
    mingw-w64-ucrt-x86_64-nsis

# The collaboration client talks WebSockets through libcurl.
curl-config --protocols | grep -qiE "^WSS?$" \
    || { echo "MSYS2 curl lacks WebSocket support" >&2; exit 1; }

cmake -S . -B build -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_COMPILER_LAUNCHER=ccache \
    -DCMAKE_CXX_COMPILER_LAUNCHER=ccache \
    -DCMAKE_INSTALL_PREFIX="$PWD/stage" \
    -DCMAKE_PREFIX_PATH=/ucrt64 \
    -DwxWidgets_CONFIG_EXECUTABLE=/ucrt64/bin/wx-config-3.2 \
    -DOCC_INCLUDE_DIR=/ucrt64/include/opencascade \
    -DOCC_LIBRARY_DIR=/ucrt64/lib \
    -DNGSPICE_ROOT_DIR=/ucrt64 \
    -DPYTHON_EXECUTABLE=/ucrt64/bin/python.exe \
    -DKICAD_SCRIPTING_WXPYTHON=OFF \
    -DKICAD_BUILD_I18N=OFF \
    -DKICAD_BUILD_QA_TESTS=OFF \
    -DKICAD_UPDATE_CHECK=OFF \
    -DKICAD_USE_PCH=ON \
    -DKICAD_INSTALL_DEMOS=OFF

cmake --build build
rm -rf stage
cmake --install build

# Bundle every MinGW DLL the shipped binaries load, so the installer works
# on a machine without MSYS2.
copied=1
while [ $copied -eq 1 ]; do
    copied=0
    for f in stage/bin/*.exe stage/bin/*.dll; do
        [ -f "$f" ] || continue
        for dep in $(ldd "$f" | awk '/\/ucrt64\//{print $3}'); do
            base=$(basename "$dep")
            if [ ! -f "stage/bin/$base" ]; then
                cp "$dep" stage/bin/
                copied=1
            fi
        done
    done
done

VERSION=$(tr -d '[:space:]' < packaging/VERSION)
makensis -DVERSION="$VERSION" -DSTAGEDIR="$(cygpath -w "$PWD/stage")" \
    packaging/windows/installer.nsi

echo
echo "Installer ready: KiCad-Collaborative-${VERSION}-windows-x64.exe"

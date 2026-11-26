# syntax=docker/dockerfile:1
# Isolated Reproducible FFmpeg.wasm Build for Gravipress
# Toolchain: Emscripten 3.1.40 (Pinned Digest) | Target: FFmpeg 6.1.6 LTS (Single-thread ESM)

FROM emscripten/emsdk:3.1.40@sha256:c1e807a6e03ac5bd5b37bae2ace3c46c08579e2ddeb951037a3b8dac7067f2cc AS build-env

ENV DEBIAN_FRONTEND=noninteractive
ENV PREFIX=/opt/ffmpeg-wasm
ENV PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig:$EMSDK/upstream/emscripten/system/lib/pkgconfig"
ENV CFLAGS="-I$PREFIX/include -O3 -fPIC"
ENV CXXFLAGS="$CFLAGS"
ENV LDFLAGS="-L$PREFIX/lib"

RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config autoconf automake libtool make cmake git curl xz-utils ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p $PREFIX /sources /build /dist

WORKDIR /sources

# -----------------------------------------------------------------------------
# 1. Download & Verify All Pinned Source Tarballs via SHA-256 Checksums
# -----------------------------------------------------------------------------
COPY sources.env bind.c post.js /sources/

RUN curl -fsSL -o /sources/lame.tar.gz https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz && \
    curl -fsSL -o /sources/libogg.tar.gz https://downloads.xiph.org/releases/ogg/libogg-1.3.5.tar.gz && \
    curl -fsSL -o /sources/libvorbis.tar.gz https://downloads.xiph.org/releases/vorbis/libvorbis-1.3.7.tar.gz && \
    curl -fsSL -o /sources/libopus.tar.gz https://downloads.xiph.org/releases/opus/opus-1.4.tar.gz && \
    echo "ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e  /sources/lame.tar.gz" > /sources/checksums.txt && \
    echo "0eb4b4b9420a0f51db142ba3f9c64b333f826532dc0f48c6410ae51f4799b664  /sources/libogg.tar.gz" >> /sources/checksums.txt && \
    echo "0e982409a9c3fc82ee06e08205b1355e5c6aa4c36bca58146ef399621b0ce5ab  /sources/libvorbis.tar.gz" >> /sources/checksums.txt && \
    echo "c9b32b4253be5ae63d1ff16eea06b94b5f0f2951b7a02aceef58e3a3ce49c51f  /sources/libopus.tar.gz" >> /sources/checksums.txt && \
    sha256sum -c /sources/checksums.txt

# Clone FFmpeg 6.1.6 LTS source (pinned tag n6.1.6)
RUN git clone --depth 1 --branch n6.1.6 https://github.com/FFmpeg/FFmpeg.git /sources/ffmpeg

# Clone x264 from verified GitHub mirror and checkout exact pinned commit
RUN git clone https://github.com/ffmpegwasm/x264.git /sources/x264 && \
    cd /sources/x264 && git checkout baee400fa9ced6f5481a728138fed6e867b0ff7f

# Clone libvpx source (pinned tag v1.14.0)
RUN git clone --depth 1 --branch v1.14.0 https://github.com/webmproject/libvpx.git /sources/libvpx

# -----------------------------------------------------------------------------
# 2. Build libogg (Required by Vorbis)
# -----------------------------------------------------------------------------
RUN tar -xzf /sources/libogg.tar.gz -C /build && \
    cd /build/libogg-1.3.5 && \
    emconfigure ./configure --prefix=$PREFIX --disable-shared --enable-static && \
    emmake make -j$(nproc) && \
    emmake make install

# -----------------------------------------------------------------------------
# 3. Build libvorbis (Ogg Vorbis Audio Codec)
# -----------------------------------------------------------------------------
RUN tar -xzf /sources/libvorbis.tar.gz -C /build && \
    cd /build/libvorbis-1.3.7 && \
    sed -i 's/-mno-ieee-fp//g' configure && \
    touch configure Makefile.in */Makefile.in && \
    emconfigure ./configure \
      --prefix=$PREFIX \
      --host=i686-linux \
      --enable-shared=no \
      --enable-static \
      --with-ogg=$PREFIX \
      --disable-docs \
      --disable-examples \
      --disable-oggtest && \
    sed -i 's/-mno-ieee-fp//g' lib/Makefile && \
    emmake make -j$(nproc) && \
    emmake make install

# -----------------------------------------------------------------------------
# 4. Build libopus (Opus Audio Codec)
# -----------------------------------------------------------------------------
RUN tar -xzf /sources/libopus.tar.gz -C /build && \
    cd /build/opus-1.4 && \
    emconfigure ./configure \
      --prefix=$PREFIX \
      --host=i686-none \
      --enable-shared=no \
      --enable-static \
      --disable-asm \
      --disable-rtcd \
      --disable-intrinsics \
      --disable-doc \
      --disable-extra-programs \
      --disable-stack-protector && \
    emmake make -j$(nproc) && \
    emmake make install

# -----------------------------------------------------------------------------
# 5. Build libmp3lame (MP3 Audio Codec)
# -----------------------------------------------------------------------------
RUN tar -xzf /sources/lame.tar.gz -C /build && \
    cd /build/lame-3.100 && \
    emconfigure ./configure \
      --prefix=$PREFIX \
      --host=i686-linux \
      --disable-shared \
      --enable-static \
      --disable-frontend \
      --disable-analyzer-hooks \
      --disable-dependency-tracking && \
    emmake make -j$(nproc) && \
    emmake make install

# -----------------------------------------------------------------------------
# 6. Build libvpx (VP8/VP9 Video Codecs)
# -----------------------------------------------------------------------------
RUN cd /sources/libvpx && \
    CROSS=x86-linux emconfigure ./configure \
      --prefix=$PREFIX \
      --target=generic-gnu \
      --disable-shared \
      --enable-static \
      --disable-install-bins \
      --disable-examples \
      --disable-tools \
      --disable-docs \
      --disable-unit-tests \
      --disable-dependency-tracking \
      --disable-multithread \
      --extra-cflags="$CFLAGS" \
      --extra-cxxflags="$CXXFLAGS" && \
    emmake make -j$(nproc) && \
    emmake make install && \
    emranlib $PREFIX/lib/libvpx.a

# -----------------------------------------------------------------------------
# 7. Build x264 (H.264 Video Codec - GPL)
# -----------------------------------------------------------------------------
RUN cd /sources/x264 && \
    emconfigure ./configure \
      --prefix=$PREFIX \
      --host=x86-gnu \
      --enable-static \
      --disable-cli \
      --disable-asm \
      --disable-thread \
      --extra-cflags="$CFLAGS" && \
    emmake make -j$(nproc) install-lib-static

# -----------------------------------------------------------------------------
# 8. Configure & Build FFmpeg 6.1.6
# -----------------------------------------------------------------------------
RUN cd /sources/ffmpeg && \
    emconfigure ./configure \
      --prefix=$PREFIX \
      --target-os=none \
      --arch=x86_32 \
      --enable-cross-compile \
      --disable-asm \
      --disable-inline-asm \
      --disable-stripping \
      --disable-programs \
      --disable-doc \
      --disable-debug \
      --disable-runtime-cpudetect \
      --disable-autodetect \
      --disable-pthreads \
      --disable-w32threads \
      --disable-os2threads \
      --nm=emnm \
      --ar=emar \
      --ranlib=emranlib \
      --cc=emcc \
      --cxx=em++ \
      --objcc=emcc \
      --dep-cc=emcc \
      --disable-all \
      --enable-avcodec \
      --enable-avformat \
      --enable-avfilter \
      --enable-swresample \
      --enable-swscale \
      --enable-gpl \
      --enable-libx264 \
      --enable-libvpx \
      --enable-libmp3lame \
      --enable-libvorbis \
      --enable-libopus \
      --enable-encoder=libx264,libvpx_vp8,libvpx_vp9,libmp3lame,libvorbis,libopus,aac,flac,pcm_s16le,pcm_s24le,pcm_s32le \
      --enable-decoder=h264,vp8,vp9,mp3,vorbis,opus,aac,flac,pcm_s16le,pcm_s24le,pcm_s32le \
      --enable-muxer=mp4,webm,matroska,mp3,ogg,opus,flac,wav \
      --enable-demuxer=mov,mp4,m4a,matroska,webm,mp3,ogg,flac,wav \
      --enable-parser=h264,vp8,vp9,mpegaudio,vorbis,opus,aac,flac \
      --enable-protocol=file \
      --enable-filter=aresample,scale \
      --extra-cflags="$CFLAGS" \
      --extra-cxxflags="$CXXFLAGS" \
      --extra-ldflags="$LDFLAGS" && \
    emmake make -j$(nproc)

# -----------------------------------------------------------------------------
# 9. Link Single-Thread ESM WebAssembly Core with API Bindings & Post-JS Glue
# -----------------------------------------------------------------------------
RUN cd /sources/ffmpeg && \
    emcc -O3 -c /sources/bind.c -o /build/bind.o && \
    emcc \
      -O3 \
      /build/bind.o \
      fftools/cmdutils.c fftools/ffmpeg.c fftools/ffmpeg_filter.c fftools/ffmpeg_hw.c fftools/ffmpeg_mux.c fftools/ffmpeg_opt.c fftools/opt_common.c \
      -I. \
      -I./fftools \
      -I$PREFIX/include \
      -Llibavcodec -Llibavformat -Llibavfilter -Llibswscale -Llibswresample -Llibavutil -L$PREFIX/lib \
      -lavformat -lavcodec -lavfilter -lswscale -lswresample -lavutil \
      -lx264 -lvpx -lmp3lame -lvorbisenc -lvorbis -logg -lopus \
      -sWASM=1 \
      -sSTACK_SIZE=5MB \
      -sINITIAL_MEMORY=32MB \
      -sALLOW_MEMORY_GROWTH=1 \
      -sMAXIMUM_MEMORY=2147483648 \
      -sEXPORT_ES6=1 \
      -sMODULARIZE=1 \
      -sEXPORT_NAME=createFFmpegCore \
      -sEXPORTED_FUNCTIONS="['_ffmpeg', '_ffprobe', '_main', '_malloc', '_free']" \
      -sEXPORTED_RUNTIME_METHODS="['FS', 'cwrap', 'setValue', 'getValue', 'UTF8ToString', 'stringToUTF8', 'lengthBytesUTF8']" \
      -sINVOKE_RUN=0 \
      -sEXIT_RUNTIME=0 \
      --post-js /sources/post.js \
      -lnodefs.js \
      -lworkerfs.js \
      -o /dist/ffmpeg-core.js

# -----------------------------------------------------------------------------
# 10. Package Manifest, License Notices & Corresponding Source Archive
# -----------------------------------------------------------------------------
RUN cat <<'EOF' > /dist/THIRD_PARTY_LICENSES.txt
Gravipress Custom Multimedia Engine (FFmpeg 6.1.6 Core)
License: GNU General Public License v2.0 or later (GPL-2.0-or-later)

This binary package incorporates software developed by:
- FFmpeg Project (FFmpeg 6.1.6, GPL-2.0-or-later, https://ffmpeg.org)
- VideoLAN / x264 contributors (x264 baee400fa9ced6, GPL-2.0-or-later, https://www.videolan.org/developers/x264.html)
- WebM Project / Google LLC (libvpx 1.14.0, BSD-3-Clause, https://www.webmproject.org/)
- LAME Project (LAME 3.100, LGPL-2.0-or-later, https://lame.sourceforge.io/)
- Xiph.Org Foundation (libogg 1.3.5, libvorbis 1.3.7, BSD-3-Clause, https://xiph.org/)
- Xiph.Org, Skype, Mozilla (libopus 1.4, BSD-3-Clause, https://opus-codec.org/)

Full corresponding source code and build recipes are archived in:
ffmpeg-corresponding-source-6.1.6.tar.gz
EOF

RUN cat <<'EOF' > /dist/manifest.json
{
  "name": "gravipress-ffmpeg-core",
  "version": "6.1.6",
  "ffmpegVersion": "n6.1.6",
  "threading": "single-thread",
  "license": "GPL-2.0-or-later",
  "emscriptenVersion": "3.1.40",
  "buildDate": "2026-11-26",
  "enabledCodecs": [
    "h264 (libx264)",
    "vp8 (libvpx)",
    "vp9 (libvpx)",
    "mp3 (libmp3lame)",
    "aac (native)",
    "vorbis (libvorbis)",
    "opus (libopus)",
    "flac (native)",
    "pcm_s16le",
    "pcm_s24le",
    "pcm_s32le"
  ],
  "apis": [
    "exec",
    "ffprobe",
    "reset",
    "setLogger",
    "setTimeout",
    "setProgress",
    "FS"
  ]
}
EOF

# Package corresponding source archive
RUN tar -czf /dist/ffmpeg-corresponding-source-6.1.6.tar.gz -C /sources .

# Compute Cryptographic SHA-256 Checksums
WORKDIR /dist
RUN sha256sum ffmpeg-core.js ffmpeg-core.wasm manifest.json THIRD_PARTY_LICENSES.txt ffmpeg-corresponding-source-6.1.6.tar.gz > SHA256SUMS.txt

# Final Scratch Stage for Docker Buildx export
FROM scratch AS export
COPY --from=build-env /dist /

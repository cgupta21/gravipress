#include <emscripten.h>

// Forward declaration of FFmpeg's CLI entrypoint
int main(int argc, char **argv);

EMSCRIPTEN_KEEPALIVE
int ffmpeg(int argc, char **argv) {
    int ret = main(argc, argv);
    EM_ASM({
        Module["ret"] = $0;
    }, ret);
    return ret;
}

EMSCRIPTEN_KEEPALIVE
int ffprobe(int argc, char **argv) {
    return 0;
}

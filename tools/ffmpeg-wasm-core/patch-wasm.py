#!/usr/bin/env python3
"""
Patch FFmpeg 5.1.10 frontend sources for WebAssembly execution:
1. cmdutils.c: Hook exit_program to uninit_opts, set Module.ret, Module._cleanExit, and abort() cleanly.
2. ffprobe.c: Avoid duplicate symbols (program_name_ffprobe), reset state in ffprobe_cleanup(), export int ffprobe(int argc, char **argv).
3. ffmpeg.c: Export int ffmpeg(int argc, char **argv), add init_globals() for re-entrancy, hook send_progress() and check_timeout().
"""
import os
import sys

ffmpeg_dir = sys.argv[1] if len(sys.argv) > 1 else "/sources/ffmpeg"
fftools = os.path.join(ffmpeg_dir, "fftools")

# 1. Patch cmdutils.c
cmd_path = os.path.join(fftools, "cmdutils.c")
with open(cmd_path, "r", encoding="utf-8") as f:
    cmd = f.read().replace("\r\n", "\n")

old_exit = """void exit_program(int ret)
{
    if (program_exit)
        program_exit(ret);

    exit(ret);
}"""

new_exit = """#include <emscripten.h>
void exit_program(int ret)
{
    if (program_exit)
        program_exit(ret);

    uninit_opts();
    program_exit = NULL;

    EM_ASM({
        Module.ret = $0;
        Module._cleanExit = true;
    }, ret);
    abort();
}"""

if old_exit in cmd:
    cmd = cmd.replace(old_exit, new_exit)
    with open(cmd_path, "w", encoding="utf-8") as f:
        f.write(cmd)
    print("cmdutils.c patched successfully")
else:
    print("WARNING: old_exit pattern not found in cmdutils.c")

# 2. Patch ffprobe.c
probe_path = os.path.join(fftools, "ffprobe.c")
with open(probe_path, "r", encoding="utf-8") as f:
    probe = f.read().replace("\r\n", "\n")

probe = probe.replace('const char program_name[] = "ffprobe";', '#include <emscripten.h>\nconst char program_name_ffprobe[] = "ffprobe";')
probe = probe.replace('const int program_birth_year = 2007;', 'const int program_birth_year_ffprobe = 2007;')
probe = probe.replace('program_name,', 'program_name_ffprobe,')
probe = probe.replace('program_name ', 'program_name_ffprobe ')
probe = probe.replace('program_name;', 'program_name_ffprobe;')
probe = probe.replace('program_name)', 'program_name_ffprobe)')
probe = probe.replace('program_birth_year,', 'program_birth_year_ffprobe,')
probe = probe.replace('program_birth_year ', 'program_birth_year_ffprobe ')
probe = probe.replace('program_birth_year)', 'program_birth_year_ffprobe)')

old_cleanup = """static void ffprobe_cleanup(int ret)
{
    int i;
    for (i = 0; i < FF_ARRAY_ELEMS(sections); i++)
        av_dict_free(&(sections[i].entries_to_show));

#if HAVE_THREADS
    pthread_mutex_destroy(&log_mutex);
#endif
}"""

new_cleanup = """static void ffprobe_cleanup(int ret)
{
    int i;
    for (i = 0; i < FF_ARRAY_ELEMS(sections); i++)
        av_dict_free(&(sections[i].entries_to_show));

    av_freep(&print_format);
    av_freep(&read_intervals);
    read_intervals_nb = 0;
    av_hash_freep(&hash);
    av_freep(&nb_streams_packets);
    av_freep(&nb_streams_frames);
    av_freep(&selected_streams);
    input_filename = NULL;
    print_input_filename = NULL;
    output_filename = NULL;
    iformat = NULL;
    nb_streams = 0;

    do_bitexact = 0;
    do_count_frames = 0;
    do_count_packets = 0;
    do_read_frames = 0;
    do_read_packets = 0;
    do_show_chapters = 0;
    do_show_error = 0;
    do_show_format = 0;
    do_show_frames = 0;
    do_show_packets = 0;
    do_show_programs = 0;
    do_show_streams = 0;
    do_show_stream_disposition = 0;
    do_show_data = 0;
    do_show_program_version = 0;
    do_show_library_versions = 0;
    do_show_pixel_formats = 0;
    do_show_pixel_format_flags = 0;
    do_show_pixel_format_components = 0;
    do_show_log = 0;
    do_show_chapter_tags = 0;
    do_show_format_tags = 0;
    do_show_frame_tags = 0;
    do_show_program_tags = 0;
    do_show_stream_tags = 0;
    do_show_packet_tags = 0;
    show_value_unit = 0;
    use_value_prefix = 0;
    use_byte_value_binary_prefix = 0;
    use_value_sexagesimal_format = 0;
    show_private_data = 1;
    show_optional_fields = -1;
    stream_specifier = NULL;
    show_data_hash = NULL;
    find_stream_info = 1;

#if HAVE_THREADS
    pthread_mutex_destroy(&log_mutex);
#endif
}"""

if old_cleanup in probe:
    probe = probe.replace(old_cleanup, new_cleanup)
else:
    print("WARNING: old_cleanup pattern not found in ffprobe.c")

old_probe_main = 'int main(int argc, char **argv)\n{'
new_probe_main = """int ffprobe(int argc, char **argv)
{
    ffprobe_cleanup(0);"""

if old_probe_main in probe:
    probe = probe.replace(old_probe_main, new_probe_main)

with open(probe_path, "w", encoding="utf-8") as f:
    f.write(probe)
print("ffprobe.c patched successfully")

# 3. Patch ffmpeg.c
ff_path = os.path.join(fftools, "ffmpeg.c")
with open(ff_path, "r", encoding="utf-8") as f:
    ff = f.read().replace("\r\n", "\n")

old_ff_main = 'int main(int argc, char **argv)\n{'
new_ff_main = """#include <emscripten.h>

EM_JS(void, send_progress, (double progress, double time), {
    Module.receiveProgress(progress, time);
});

EM_JS(int, check_timeout, (void), {
    if (typeof Module.timeout === "number" && Module.timeout > 0 && typeof Module._execStartTime === "number") {
        if ((Date.now() - Module._execStartTime) >= Module.timeout) {
            return 1;
        }
    }
    return 0;
});

void init_globals(void) {
  nb_frames_dup = 0;
  dup_warning = 1000;
  nb_frames_drop = 0;
  decode_error_stat[0] = 0;
  decode_error_stat[1] = 0;
  nb_output_dumped = 0;
  want_sdp = 1;

  current_time.real_usec = 0;
  current_time.user_usec = 0;
  current_time.sys_usec = 0;

  progress_avio = NULL;
  vstats_file = NULL;
  subtitle_out = NULL;

  input_streams = NULL;
  nb_input_streams = 0;
  input_files = NULL;
  nb_input_files = 0;

  output_streams = NULL;
  nb_output_streams = 0;
  output_files = NULL;
  nb_output_files = 0;

  filtergraphs = NULL;
  nb_filtergraphs = 0;

  received_sigterm = 0;
  received_nb_signals = 0;
  transcode_init_done = ATOMIC_VAR_INIT(0);
  ffmpeg_exited = 0;
  main_return_code = 0;
  copy_ts_first_pts = AV_NOPTS_VALUE;
}

int ffmpeg(int argc, char **argv)
{
    init_globals();"""

if old_ff_main in ff:
    ff = ff.replace(old_ff_main, new_ff_main)

old_report = """    if (is_last_report)
        print_final_stats(total_size);"""

new_report = """    if (check_timeout()) {
        av_log(NULL, AV_LOG_ERROR, "Processing timed out (execution limit exceeded).\\n");
        received_sigterm = 1;
    }

    int64_t duration = -1;
    for (int i = 0; i < nb_input_files; i++) {
        if (input_files[i] && input_files[i]->ctx) {
            int64_t file_duration = input_files[i]->ctx->duration;
            if (file_duration > duration) {
                duration = file_duration;
            }
        }
    }

    if (pts != AV_NOPTS_VALUE && pts >= 0) {
        int64_t pts_abs = pts;
        if (duration > 0) {
            double p = (double)pts_abs / (double)duration;
            if (p > 0.99 && !is_last_report) {
                p = 0.99;
            } else if (p < 0.0) {
                p = 0.0;
            }
            send_progress(p, (double)pts_abs);
        } else {
            send_progress(0.0, (double)pts_abs);
        }
    }

    if (is_last_report) {
        if (!received_sigterm && main_return_code == 0) {
            int64_t final_time = duration > 0 ? duration : (pts != AV_NOPTS_VALUE && pts > 0 ? pts : 0);
            send_progress(1.0, (double)final_time);
        }
        print_final_stats(total_size);
    }"""

if old_report in ff:
    ff = ff.replace(old_report, new_report)

with open(ff_path, "w", encoding="utf-8") as f:
    f.write(ff)
print("ffmpeg.c patched successfully")

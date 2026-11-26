// post.js - Emscripten post-module glue for @ffmpeg/ffmpeg wrapper compatibility

const DEFAULT_ARGS = ["./ffmpeg", "-nostdin", "-y"];
const DEFAULT_ARGS_FFPROBE = ["./ffprobe"];

Module["DEFAULT_ARGS"] = DEFAULT_ARGS;
Module["DEFAULT_ARGS_FFPROBE"] = DEFAULT_ARGS_FFPROBE;
Module["ret"] = -1;
Module["timeout"] = -1;
Module["logger"] = () => {};
Module["progress"] = () => {};

function stringToPtr(str) {
  const len = Module["lengthBytesUTF8"](str) + 1;
  const ptr = Module["_malloc"](len);
  Module["stringToUTF8"](str, ptr, len);
  return ptr;
}

function stringsToPtr(strs) {
  const len = strs.length;
  const ptr = Module["_malloc"](len * 4);
  for (let i = 0; i < len; i++) {
    Module["setValue"](ptr + 4 * i, stringToPtr(strs[i]), "i32");
  }
  return ptr;
}

function print(message) {
  Module["logger"]({ type: "stdout", message: message });
}

function printErr(message) {
  if (!message.startsWith("Aborted(native code called abort())")) {
    Module["logger"]({ type: "stderr", message: message });
  }
}

function exec(..._args) {
  const args = [...Module["DEFAULT_ARGS"], ..._args];
  try {
    Module["_ffmpeg"](args.length, stringsToPtr(args));
  } catch (e) {
    if (!e.message.startsWith("Aborted")) {
      throw e;
    }
  }
  return Module["ret"];
}

function ffprobe(..._args) {
  const args = [...Module["DEFAULT_ARGS_FFPROBE"], ..._args];
  try {
    if (Module["_ffprobe"]) {
      Module["_ffprobe"](args.length, stringsToPtr(args));
    }
  } catch (e) {
    if (!e.message.startsWith("Aborted")) {
      throw e;
    }
  }
  return Module["ret"];
}

function setLogger(logger) {
  Module["logger"] = logger;
}

function setTimeout(timeout) {
  Module["timeout"] = timeout;
}

function setProgress(handler) {
  Module["progress"] = handler;
}

function receiveProgress(progress, time) {
  Module["progress"]({ progress: progress, time: time });
}

function reset() {
  Module["ret"] = -1;
  Module["timeout"] = -1;
}

function _locateFile(path, prefix) {
  const mainScriptUrlOrBlob = Module["mainScriptUrlOrBlob"];
  if (mainScriptUrlOrBlob) {
    try {
      const { wasmURL, workerURL } = JSON.parse(
        atob(mainScriptUrlOrBlob.slice(mainScriptUrlOrBlob.lastIndexOf("#") + 1))
      );
      if (path.endsWith(".wasm")) return wasmURL;
      if (path.endsWith(".worker.js")) return workerURL;
    } catch (e) {
      // ignore
    }
  }
  return prefix + path;
}

Module["stringToPtr"] = stringToPtr;
Module["stringsToPtr"] = stringsToPtr;
Module["print"] = print;
Module["printErr"] = printErr;
Module["locateFile"] = _locateFile;
Module["exec"] = exec;
Module["ffprobe"] = ffprobe;
Module["setLogger"] = setLogger;
Module["setTimeout"] = setTimeout;
Module["setProgress"] = setProgress;
Module["reset"] = reset;
Module["receiveProgress"] = receiveProgress;

// post.js - Emscripten post-module glue for @ffmpeg/ffmpeg wrapper compatibility

const DEFAULT_ARGS = ["./ffmpeg", "-nostdin", "-y"];
const DEFAULT_ARGS_FFPROBE = ["./ffprobe"];

Module["DEFAULT_ARGS"] = DEFAULT_ARGS;
Module["DEFAULT_ARGS_FFPROBE"] = DEFAULT_ARGS_FFPROBE;
Module["ret"] = -1;
Module["timeout"] = -1;
Module["logger"] = null;
Module["progress"] = () => {};
Module["_corrupted"] = false;
Module["_cleanExit"] = false;
Module["_timedOut"] = false;
Module["_execStartTime"] = 0;

let lastProgressTime = 0;

function stringToPtr(str, allocated) {
  const len = Module["lengthBytesUTF8"](str) + 1;
  const ptr = Module["_malloc"](len);
  if (!ptr) {
    throw new Error("FFmpeg WASM: Out of memory allocating string argument: " + str);
  }
  Module["stringToUTF8"](str, ptr, len);
  if (allocated) allocated.push(ptr);
  return ptr;
}

function stringsToPtr(strs, allocated) {
  const len = strs.length;
  const ptr = Module["_malloc"](len * 4);
  if (!ptr) {
    throw new Error("FFmpeg WASM: Out of memory allocating argv pointer array");
  }
  if (allocated) allocated.push(ptr);
  for (let i = 0; i < len; i++) {
    Module["setValue"](ptr + 4 * i, stringToPtr(strs[i], allocated), "i32");
  }
  return ptr;
}

function freePtrs(allocated) {
  if (!allocated) return;
  for (let i = 0; i < allocated.length; i++) {
    try {
      Module["_free"](allocated[i]);
    } catch (_) {}
  }
}

function exec(..._args) {
  if (Module["_corrupted"]) {
    throw new Error(
      "FFmpeg WASM instance is in a corrupted state from a prior fatal failure and cannot be reused. A fresh instance must be created."
    );
  }
  const args = [...Module["DEFAULT_ARGS"], ..._args];
  Module["ret"] = -1;
  Module["_cleanExit"] = false;
  Module["_timedOut"] = false;
  Module["_execStartTime"] = Date.now();
  lastProgressTime = 0;
  const allocated = [];
  const stack = typeof Module["stackSave"] === "function" ? Module["stackSave"]() : 0;
  try {
    const ptr = stringsToPtr(args, allocated);
    const ret = Module["_ffmpeg"](args.length, ptr);
    if (typeof ret === "number") {
      Module["ret"] = ret;
    }
  } catch (e) {
    if (e && (e.name === "ExitStatus" || typeof e.status === "number")) {
      Module["ret"] = typeof e.status === "number" ? e.status : 0;
    } else if (
      e &&
      e.message &&
      (e.message.startsWith("Aborted(native code called abort())") ||
        e.message.startsWith("Aborted()"))
    ) {
      if (!Module["_cleanExit"]) {
        Module["_corrupted"] = true;
        Module["ret"] = 1;
        throw new Error("FFmpeg WASM runtime aborted unexpectedly: " + e.message);
      }
    } else {
      Module["_corrupted"] = true;
      Module["ret"] = 1;
      throw e;
    }
  } finally {
    if (stack && typeof Module["stackRestore"] === "function") {
      try {
        Module["stackRestore"](stack);
      } catch (_) {}
    }
    freePtrs(allocated);
  }

  // Force non-zero exit code if timeout occurred
  if (Module["_timedOut"]) {
    Module["ret"] = 1;
  }

  // Emit exactly one final 1.0 progress event upon verified successful completion
  if (Module["ret"] === 0 && !Module["_timedOut"] && !Module["_corrupted"]) {
    try {
      Module["progress"]({ progress: 1.0, time: lastProgressTime });
    } catch (_) {}
  }

  return Module["ret"];
}

function ffprobe(..._args) {
  if (Module["_corrupted"]) {
    throw new Error(
      "FFmpeg WASM instance is in a corrupted state from a prior fatal failure and cannot be reused. A fresh instance must be created."
    );
  }
  const args = [...Module["DEFAULT_ARGS_FFPROBE"], ..._args];
  Module["ret"] = -1;
  Module["_cleanExit"] = false;
  Module["_timedOut"] = false;
  Module["_execStartTime"] = Date.now();
  const allocated = [];
  const stack = typeof Module["stackSave"] === "function" ? Module["stackSave"]() : 0;
  try {
    const ptr = stringsToPtr(args, allocated);
    if (typeof Module["_ffprobe"] === "function") {
      const ret = Module["_ffprobe"](args.length, ptr);
      if (typeof ret === "number") {
        Module["ret"] = ret;
      }
    } else {
      throw new Error("FFmpeg WASM: _ffprobe symbol not found in WebAssembly module");
    }
  } catch (e) {
    if (e && (e.name === "ExitStatus" || typeof e.status === "number")) {
      Module["ret"] = typeof e.status === "number" ? e.status : 0;
    } else if (
      e &&
      e.message &&
      (e.message.startsWith("Aborted(native code called abort())") ||
        e.message.startsWith("Aborted()"))
    ) {
      if (!Module["_cleanExit"]) {
        Module["_corrupted"] = true;
        Module["ret"] = 1;
        throw new Error("FFprobe WASM runtime aborted unexpectedly: " + e.message);
      }
    } else {
      Module["_corrupted"] = true;
      Module["ret"] = 1;
      throw e;
    }
  } finally {
    if (stack && typeof Module["stackRestore"] === "function") {
      try {
        Module["stackRestore"](stack);
      } catch (_) {}
    }
    freePtrs(allocated);
  }
  return Module["ret"];
}

function setLogger(logger) {
  Module["logger"] = typeof logger === "function" ? logger : null;
}

function setTimeout(timeout) {
  Module["timeout"] = typeof timeout === "number" && timeout > 0 ? timeout : -1;
}

function setProgress(handler) {
  Module["progress"] = typeof handler === "function" ? handler : () => {};
}

function receiveProgress(progress, time) {
  if (typeof progress === "number" && !isNaN(progress) && isFinite(progress)) {
    // Intermediate encoding progress is strictly kept at or below 0.99
    const clampedProgress = Math.max(0, Math.min(0.99, progress));
    const validTime =
      typeof time === "number" && !isNaN(time) && isFinite(time) && time >= 0
        ? time
        : 0;
    // Maintain non-decreasing timestamps
    if (validTime >= lastProgressTime) {
      lastProgressTime = validTime;
    }
    try {
      Module["progress"]({ progress: clampedProgress, time: lastProgressTime });
    } catch (_) {}
  }
}

function reset() {
  Module["ret"] = -1;
  Module["timeout"] = -1;
  Module["_cleanExit"] = false;
  Module["_timedOut"] = false;
  lastProgressTime = 0;
}

function isCorrupted() {
  return !!Module["_corrupted"];
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
Module["locateFile"] = _locateFile;
Module["exec"] = exec;
Module["ffprobe"] = ffprobe;
Module["setLogger"] = setLogger;
Module["setTimeout"] = setTimeout;
Module["setProgress"] = setProgress;
Module["reset"] = reset;
Module["receiveProgress"] = receiveProgress;
Module["isCorrupted"] = isCorrupted;

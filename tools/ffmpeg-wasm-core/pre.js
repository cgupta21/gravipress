// pre.js - Emscripten pre-module hooks for logger and clean abort handling

Module["logger"] = Module["logger"] || null;
Module["_cleanExit"] = false;
Module["_timedOut"] = false;

const defaultPrint = Module["print"];
const defaultPrintErr = Module["printErr"];

Module["print"] = function (message) {
  if (typeof Module["logger"] === "function") {
    try {
      Module["logger"]({ type: "stdout", message: message });
      return;
    } catch (_) {}
  }
  if (typeof defaultPrint === "function") {
    defaultPrint(message);
  } else if (typeof console !== "undefined" && console.log) {
    console.log(message);
  }
};

Module["printErr"] = function (message) {
  // Prevent misleading Aborted() messages during controlled termination without hiding genuine runtime errors
  if (
    Module["_cleanExit"] &&
    (message === "Aborted()" ||
      message.startsWith("Aborted(native code called abort())") ||
      message.startsWith("Aborted()"))
  ) {
    return;
  }
  if (typeof Module["logger"] === "function") {
    try {
      Module["logger"]({ type: "stderr", message: message });
      return;
    } catch (_) {}
  }
  if (typeof defaultPrintErr === "function") {
    defaultPrintErr(message);
  } else if (typeof console !== "undefined" && console.error) {
    console.error(message);
  }
};

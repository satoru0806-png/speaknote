const { uIOhook, UiohookKey } = require("uiohook-napi");

console.log("Listening for keyboard events... Press Alt to test, Ctrl+C to quit.");

uIOhook.on("keydown", (e) => {
  console.log("keydown:", e.keycode, e.keycode === UiohookKey.Alt ? "= ALT" : "");
});

uIOhook.on("keyup", (e) => {
  console.log("keyup:", e.keycode, e.keycode === UiohookKey.Alt ? "= ALT" : "");
});

uIOhook.start();

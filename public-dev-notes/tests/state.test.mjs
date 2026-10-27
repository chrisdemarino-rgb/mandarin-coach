import assert from "node:assert/strict";
import { createMachine } from "../../public/js/state.js";
const m = createMachine();
assert.equal(m.state, "idle");
assert.equal(m.send("STOP"), false); // invalid ignored
assert.ok(m.send("START")); assert.equal(m.state, "prompting");
assert.ok(m.send("PROMPT_DONE")); assert.equal(m.state, "listening");
assert.ok(m.send("PAUSE")); assert.equal(m.state, "paused");
assert.ok(m.send("RESUME")); assert.equal(m.state, "listening");
assert.ok(m.send("STOP")); assert.equal(m.state, "processing");
assert.equal(m.send("PAUSE"), false);
assert.ok(m.send("RESULT")); assert.equal(m.state, "result");
assert.ok(m.send("PLAY")); assert.equal(m.state, "playback");
assert.ok(m.send("PAUSE")); assert.ok(m.send("RESUME")); assert.equal(m.state, "result");
assert.ok(m.send("NEXT")); assert.equal(m.state, "prompting");
assert.ok(m.send("FINISH")); assert.equal(m.state, "finished");
assert.ok(m.send("RESET")); assert.equal(m.state, "idle");
console.log("state machine tests passed");

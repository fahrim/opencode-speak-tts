import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SPEED_OPTIONS,
  DEFAULT_SPEED,
  isSpeed,
  resolveSpeed,
  speedLabel,
  rateForSpeed,
  resumeOffset,
} from "../lib/speed.ts";

test("offers the steps the picker shows, with normal among them", () => {
  assert.deepEqual([...SPEED_OPTIONS], ["0.5", "0.75", "1", "1.25", "1.5", "2"]);
  assert.equal(DEFAULT_SPEED, "1");
});

test("an unknown speed falls back to normal rather than throwing", () => {
  assert.equal(resolveSpeed("1.5"), "1.5");
  assert.equal(resolveSpeed("1.7"), "1");
  assert.equal(resolveSpeed(undefined), "1");
  assert.equal(resolveSpeed(""), "1");
  // A durable record written before this setting existed carries no value.
  assert.equal(resolveSpeed(2), "1");
});

test("a step is accepted only when the picker could have produced it", () => {
  for (const speed of SPEED_OPTIONS) assert.equal(isSpeed(speed), true, speed);
  for (const bad of ["1.1", "3", "", "fast", 1.5, null, undefined]) {
    assert.equal(isSpeed(bad), false, String(bad));
  }
});

test("the label reads as a multiplier", () => {
  assert.equal(speedLabel("1"), "1x");
  assert.equal(speedLabel("1.5"), "1.5x");
  assert.equal(speedLabel("0.5"), "0.5x");
  assert.equal(speedLabel("nonsense"), "1x");
});

test("a speed becomes a signed rate, with 1x written as +0%", () => {
  // Absolute, not omitted: a summary's speed is set on its own, so 1x means the
  // voice's normal pace rather than "inherit whatever the voice is set to".
  assert.equal(rateForSpeed("1"), "+0%");
  assert.equal(rateForSpeed("1.25"), "+25%");
  assert.equal(rateForSpeed("1.5"), "+50%");
  assert.equal(rateForSpeed("2"), "+100%");
  assert.equal(rateForSpeed("0.75"), "-25%");
  assert.equal(rateForSpeed("0.5"), "-50%");
  assert.equal(rateForSpeed("bogus"), "+0%");
});

test("resuming after a speed change lands on the same words", () => {
  // Six seconds in at the old pace: the same words take half the seconds at
  // double speed, and twice the seconds at half speed. No audio length needed.
  assert.equal(resumeOffset(6, "1", "1"), 6);
  assert.equal(resumeOffset(6, "1", "2"), 3);
  assert.equal(resumeOffset(6, "2", "1"), 12);
  assert.equal(resumeOffset(6, "1", "0.5"), 12);
  assert.equal(resumeOffset(6, "1.5", "2"), 4.5);
});

test("resuming with nothing played, or an unknown speed, starts at the top", () => {
  assert.equal(resumeOffset(0, "1", "2"), 0);
  assert.equal(resumeOffset(-3, "1", "2"), 0);
  // An unknown speed resolves to normal, not to zero or NaN.
  assert.equal(resumeOffset(6, "bogus", "2"), 3);
  assert.equal(resumeOffset(6, "1", "bogus"), 6);
});

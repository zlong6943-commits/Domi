import assert from "node:assert/strict";
import { easeInOut, recordSamePlaceClick } from "../src/main/petPlay";
import type { TimedClick } from "../src/main/petPlay";

function click(x: number, y: number, timestamp: number): TimedClick {
  return { x, y, timestamp };
}

export const tests = [
  {
    name: "same-place rapid clicks trigger on the third click",
    run(): void {
      let sequence: TimedClick[] = [];
      let result = recordSamePlaceClick(sequence, click(100, 100, 1_000));
      sequence = result.clicks;
      result = recordSamePlaceClick(sequence, click(108, 96, 1_360));
      sequence = result.clicks;
      result = recordSamePlaceClick(sequence, click(95, 107, 1_720));
      assert.equal(result.tripleClick, true);
      assert.deepEqual(result.clicks, []);
    }
  },
  {
    name: "slow or distant clicks restart the triple-click sequence",
    run(): void {
      let result = recordSamePlaceClick([], click(100, 100, 1_000));
      result = recordSamePlaceClick(result.clicks, click(100, 100, 1_800));
      assert.equal(result.clicks.length, 1);
      result = recordSamePlaceClick(result.clicks, click(190, 100, 1_900));
      assert.equal(result.clicks.length, 1);
      assert.equal(result.tripleClick, false);
    }
  },
  {
    name: "ambient movement easing stays bounded",
    run(): void {
      assert.equal(easeInOut(-1), 0);
      assert.equal(easeInOut(0.5), 0.5);
      assert.equal(easeInOut(2), 1);
    }
  }
];

import test from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { isAlreadyPaidError, describeError } from "../src/chain.js";

// Bentuk error yang beneran dilempar ethers v6 waktu revert kejadian di tahap
// estimateGas: data mentah nyempil di e.info.error.data, bukan di e.data.
const revertWith = (sig) => ({ info: { error: { data: ethers.id(sig).slice(0, 10) } } });

test("AlreadyPaid dikenali sebagai 'udah bayar', bukan kegagalan", () => {
  assert.equal(isAlreadyPaidError(revertWith("AlreadyPaid()")), true);
});

test("custom error kontrak yang lain TIDAK dianggap AlreadyPaid", () => {
  for (const sig of ["NotMember()", "GroupClosed()", "RoundNotFunded()", "TransferFailed()"]) {
    assert.equal(isAlreadyPaidError(revertWith(sig)), false, `${sig} bocor jadi AlreadyPaid`);
  }
});

test("error jaringan biasa TIDAK dianggap AlreadyPaid", () => {
  assert.equal(isAlreadyPaidError(new Error("could not detect network")), false);
  assert.equal(isAlreadyPaidError({ reason: "insufficient funds" }), false);
  assert.equal(isAlreadyPaidError(undefined), false);
});

test("describeError tetap jabarin AlreadyPaid apa adanya", () => {
  assert.match(describeError(revertWith("AlreadyPaid()")), /^AlreadyPaid/);
});

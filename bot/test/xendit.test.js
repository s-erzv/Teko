import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePayoutCallback,
  verifyCallbackToken,
  isPaid,
  paidAmount,
  resolveChannelCode,
} from "../src/xendit.js";

test("verifyCallbackToken nolak token salah, kosong, dan beda panjang", () => {
  assert.equal(verifyCallbackToken("token-rahasia-test"), true);
  assert.equal(verifyCallbackToken("token-rahasia-lain"), false);
  assert.equal(verifyCallbackToken("pendek"), false);
  assert.equal(verifyCallbackToken(""), false);
  assert.equal(verifyCallbackToken(undefined), false);
});

test("isPaid cuma untuk PAID (Invoice API tidak punya 'settlement')", () => {
  assert.equal(isPaid({ status: "PAID" }), true);
  assert.equal(isPaid({ status: "PENDING" }), false);
  assert.equal(isPaid({ status: "EXPIRED" }), false);
  assert.equal(isPaid({ status: "SETTLED" }), false);
});

test("paidAmount pakai paid_amount, jatuh ke amount kalau tidak ada", () => {
  assert.equal(paidAmount({ amount: 100, paid_amount: 120 }), 120);
  assert.equal(paidAmount({ amount: 100 }), 100);
  assert.equal(paidAmount({ amount: 100, paid_amount: 0 }), 0);
});

test("parsePayoutCallback: bentuk {event, data} Payouts v2", () => {
  assert.deepEqual(
    parsePayoutCallback({
      event: "payout.succeeded",
      data: { id: "disb_1", reference_id: "teko-payout-g1-r1-u5-abc", status: "SUCCEEDED" },
    }),
    { referenceId: "teko-payout-g1-r1-u5-abc", status: "succeeded", failureCode: null, xenditId: "disb_1" }
  );

  assert.deepEqual(
    parsePayoutCallback({
      event: "payout.failed",
      data: {
        id: "disb_2",
        reference_id: "teko-payout-g1-r2-u5-def",
        status: "FAILED",
        failure_code: "INVALID_DESTINATION",
      },
    }),
    {
      referenceId: "teko-payout-g1-r2-u5-def",
      status: "failed",
      failureCode: "INVALID_DESTINATION",
      xenditId: "disb_2",
    }
  );
});

test("parsePayoutCallback: bentuk rata di root juga diterima", () => {
  const r = parsePayoutCallback({ id: "disb_3", reference_id: "ref-x", status: "SUCCEEDED" });
  assert.equal(r.status, "succeeded");
  assert.equal(r.referenceId, "ref-x");
});

test("parsePayoutCallback: status belum final -> null, jangan dianggap tuntas", () => {
  assert.equal(parsePayoutCallback({ data: { reference_id: "ref-y", status: "ACCEPTED" } }).status, null);
  assert.equal(parsePayoutCallback({}).status, null);
  assert.equal(parsePayoutCallback({}).referenceId, null);
});

test("resolveChannelCode tahan spasi & huruf besar-kecil", () => {
  assert.equal(resolveChannelCode("GoPay"), "ID_GOPAY");
  assert.equal(resolveChannelCode("shopee pay"), "ID_SHOPEEPAY");
  assert.equal(resolveChannelCode("bca"), "ID_BCA");
  assert.equal(resolveChannelCode("Bank Jago"), null);
  assert.equal(resolveChannelCode(""), null);
});

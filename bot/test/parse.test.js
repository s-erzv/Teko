import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRupiah, parseCycleAnswer, parseDrawModeAnswer, parseInt10 } from "../src/parse.js";

test("parseRupiah: satuan nempel ke angka", () => {
  assert.equal(parseRupiah("200rb"), 200_000);
  assert.equal(parseRupiah("200 ribu"), 200_000);
  assert.equal(parseRupiah("200k"), 200_000);
  assert.equal(parseRupiah("2jt"), 2_000_000);
  assert.equal(parseRupiah("3 juta"), 3_000_000);
});

test("parseRupiah: titik/koma jadi desimal kalau ADA satuan", () => {
  assert.equal(parseRupiah("1.5jt"), 1_500_000);
  assert.equal(parseRupiah("1,5jt"), 1_500_000);
  assert.equal(parseRupiah("2.5rb"), 2_500);
});

test("parseRupiah: titik/koma jadi pemisah ribuan kalau TANPA satuan", () => {
  assert.equal(parseRupiah("1.000.000"), 1_000_000);
  assert.equal(parseRupiah("200.000"), 200_000);
  assert.equal(parseRupiah("50000"), 50_000);
});

test("parseRupiah: kalimat utuh, bukan cuma angka telanjang", () => {
  assert.equal(parseRupiah("setorannya 200rb aja ya"), 200_000);
  assert.equal(parseRupiah("gatau"), null);
});

test("parseCycleAnswer", () => {
  assert.equal(parseCycleAnswer("mingguan"), 7);
  assert.equal(parseCycleAnswer("tiap bulan"), 30);
  assert.equal(parseCycleAnswer("default"), "default");
  assert.equal(parseCycleAnswer("terserah"), "default");
  assert.equal(parseCycleAnswer("14"), 14);
  assert.equal(parseCycleAnswer("hah"), null);
});

test("parseDrawModeAnswer: apa pun selain kata kunci upfront = percycle", () => {
  assert.equal(parseDrawModeAnswer("upfront"), "upfront");
  assert.equal(parseDrawModeAnswer("ditentukan di awal"), "upfront");
  assert.equal(parseDrawModeAnswer("biasa"), "percycle");
  assert.equal(parseDrawModeAnswer(""), "percycle");
});

test("parseInt10", () => {
  assert.equal(parseInt10("5 orang"), 5);
  assert.equal(parseInt10("orang"), null);
});

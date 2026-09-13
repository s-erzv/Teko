import test from "node:test";
import assert from "node:assert/strict";
import * as store from "../src/store.js";
import { isGroupAdmin } from "../src/service.js";

// Admin PER GRUP: pembuat arisan boleh /denda /draw /tutup_paksa /eksekusi
// buat arisannya sendiri, tanpa perlu didaftarin ke ADMIN_USER_IDS (yang
// tetap dicek terpisah, duluan, di index.js). Lihat migration 002.

test("pembuat arisan adalah admin buat grupnya sendiri", async () => {
  const gid = 201;
  await store.saveGroup({ groupId: gid, chatId: "-201", size: 2, contributionIdr: 1000, adminUserId: 111 });
  assert.equal(await isGroupAdmin({ chatId: "-201", userId: 111 }), true);
});

test("anggota lain di grup yang sama BUKAN admin", async () => {
  const gid = 202;
  await store.saveGroup({ groupId: gid, chatId: "-202", size: 2, contributionIdr: 1000, adminUserId: 111 });
  assert.equal(await isGroupAdmin({ chatId: "-202", userId: 222 }), false);
});

test("grup lama tanpa admin_user_id (dibuat sebelum migration 002) -> bukan siapa-siapa", async () => {
  const gid = 203;
  await store.saveGroup({ groupId: gid, chatId: "-203", size: 2, contributionIdr: 1000 }); // adminUserId diomit
  assert.equal(await isGroupAdmin({ chatId: "-203", userId: 111 }), false);
});

test("chat tanpa arisan aktif -> false, bukan error", async () => {
  assert.equal(await isGroupAdmin({ chatId: "-tidak-ada", userId: 111 }), false);
});

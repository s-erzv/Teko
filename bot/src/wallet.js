import crypto from "node:crypto";
import { ethers } from "ethers";
import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from "@aws-sdk/client-kms";
import { config } from "./config.js";
import { IDRX_ABI } from "./abi.js";
import * as store from "./store.js";

/**
 * Wallet custodial: SETIAP user dapet private key RANDOM sendiri-sendiri
 * (bukan diturunkan dari 1 master mnemonic seperti versi awal) — bocor 1 baris
 * database (1 user punya) tidak pernah membocorkan address user lain. Private
 * key disimpan di store terenkripsi lewat AWS KMS envelope encryption: data
 * key AES-256 sekali pakai per wallet, di-generate & dibungkus oleh KMS, lalu
 * dipakai untuk enkripsi private key secara lokal — plaintext data key dan
 * plaintext private key tidak pernah disimpan di mana pun, cuma numpang lewat
 * memori sesaat.
 *
 * Ini menutup skenario "1 file/backup bocor = semua user kena" dari model HD-
 * derive lama, tapi TIDAK menghilangkan risiko "server yang lagi jalan
 * disusupi" (selama proses hidup, dia memang berwenang minta KMS men-decrypt
 * atas nama user) — lihat juga sweepToTreasury() yang meminimalkan window
 * dana beneran nongkrong di wallet ini.
 */
const kms = new KMSClient({
  region: config.aws.region,
  credentials: {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  },
});

async function encryptPrivateKey(privateKeyHex) {
  const { Plaintext, CiphertextBlob } = await kms.send(
    new GenerateDataKeyCommand({ KeyId: config.aws.kmsKeyId, KeySpec: "AES_256" })
  );
  const dataKey = Buffer.from(Plaintext);
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", dataKey, iv);
    const raw = Buffer.from(privateKeyHex.replace(/^0x/, ""), "hex");
    const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      encryptedDataKey: Buffer.from(CiphertextBlob).toString("base64"),
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      authTag: authTag.toString("base64"),
    };
  } finally {
    dataKey.fill(0); // jangan biarkan plaintext data key nongkrong lebih lama dari perlu
  }
}

async function decryptPrivateKey(encrypted) {
  const { Plaintext } = await kms.send(
    new DecryptCommand({ CiphertextBlob: Buffer.from(encrypted.encryptedDataKey, "base64") })
  );
  const dataKey = Buffer.from(Plaintext);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", dataKey, Buffer.from(encrypted.iv, "base64"));
    decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
      decipher.final(),
    ]);
    return "0x" + plain.toString("hex");
  } finally {
    dataKey.fill(0);
  }
}

async function createCustodialWallet(telegramUserId) {
  const w = ethers.Wallet.createRandom();
  const encryptedKey = await encryptPrivateKey(w.privateKey);
  await store.saveWallet({ telegramUserId, address: w.address, encryptedKey });
  return w.address;
}

/** Alamat on-chain user (dibuat otomatis kalau belum ada). */
export async function custodialAddress(telegramUserId) {
  const row = await store.getWallet(telegramUserId);
  if (row) return row.address;
  return createCustodialWallet(telegramUserId);
}

/** Wallet ber-signer, HANYA dipakai sesaat (mis. sweepToTreasury). Private key
 *  didekripsi ke memori, dipakai, lalu dibuang begitu fungsi ini selesai — tidak
 *  pernah ditulis ke disk/log dalam bentuk plaintext. */
async function custodialSigner(telegramUserId, provider) {
  const row = await store.getWallet(telegramUserId);
  if (!row) throw new Error(`Wallet custodial tidak ditemukan untuk user ${telegramUserId}`);
  const pk = await decryptPrivateKey(row.encrypted_key ?? row.encryptedKey);
  return new ethers.Wallet(pk, provider);
}

/**
 * Sapu saldo IDRX dari wallet custodial pemenang balik ke Treasury, sesegera
 * mungkin setelah event RoundDrawn (VRF fulfillment) — meminimalkan berapa
 * lama hadiah beneran "nongkrong" di wallet yang key-nya dipegang server,
 * sebelum akhirnya dicairkan jadi Rupiah asli lewat Xendit Payout (lihat
 * service.handleRoundDrawn).
 *
 * Wallet custodial tidak pernah pegang BNB sendiri, jadi Treasury nyuntik gas
 * secukupnya dulu (sekali pakai) sebelum wallet itu bisa menandatangani
 * transfer IDRX-nya sendiri.
 */
export async function sweepToTreasury(telegramUserId, amountUnits, provider, treasurySigner) {
  const custodial = await custodialSigner(telegramUserId, provider);

  const bal = await provider.getBalance(custodial.address);
  if (bal < config.chain.sweepGasTopupWei) {
    const topupTx = await treasurySigner.sendTransaction({
      to: custodial.address,
      value: config.chain.sweepGasTopupWei - bal,
    });
    await topupTx.wait();
  }

  const idrx = new ethers.Contract(config.chain.idrx, IDRX_ABI, custodial);
  const tx = await idrx.transfer(treasurySigner.address, amountUnits);
  const receipt = await tx.wait();
  return { txHash: receipt.hash };
}

/**
 * Sapu saldo IDRX dari wallet custodial ke address EKSTERNAL yang didaftarkan
 * member sendiri (opsi self-custody) — dana langsung ke wallet yang benar-
 * benar mereka kendalikan, server tidak pernah menahannya lebih lama.
 */
export async function sweepToExternal(telegramUserId, externalAddress, amountUnits, provider, treasurySigner) {
  const custodial = await custodialSigner(telegramUserId, provider);

  const bal = await provider.getBalance(custodial.address);
  if (bal < config.chain.sweepGasTopupWei) {
    const topupTx = await treasurySigner.sendTransaction({
      to: custodial.address,
      value: config.chain.sweepGasTopupWei - bal,
    });
    await topupTx.wait();
  }

  const idrx = new ethers.Contract(config.chain.idrx, IDRX_ABI, custodial);
  const tx = await idrx.transfer(externalAddress, amountUnits);
  const receipt = await tx.wait();
  return { txHash: receipt.hash };
}

/**
 * Z.AI (chat.z.ai) captcha solver.
 *
 * chat.z.ai gates POST /api/v2/chat/completions behind an Aliyun
 * "CaptchaVerifyParam". The value is minted by a three-step chain that was
 * reverse-engineered from the frontend bundle and verified bit-for-bit against
 * the live service:
 *
 *   1. InitCaptchaV3   -> CertifyId
 *   2. build the captcha `data` blob from a synthetic Track payload
 *      (aliHash + zlib + custom stream cipher)
 *   3. VerifyCaptchaV3 -> {securityToken, certifyId}
 *      -> base64({certifyId, isSign, sceneId, securityToken}) = the param
 *
 * Step 3 additionally requires a "deviceToken" produced by Aliyun FeiLin, an
 * anti-bot script that only runs in a real browser engine. That token — and the
 * resulting param — are SINGLE USE: one completion needs one fresh pair. The
 * browser-side harvest lives in `zaiDeviceToken.js`.
 *
 * The Aliyun RPC credentials and cipher tables below are public constants
 * shipped in the site's own frontend bundle.
 */

import crypto from "node:crypto";
import zlib from "node:zlib";

export const CAPTCHA_REGION = "sgp";
export const CAPTCHA_PREFIX = "no8xfe";
export const CAPTCHA_SCENE_ID = "didk33e0";

const ACCESS_KEY = "LTAI5tSEBwYMwVKAQGpxmvTd";
const SECRET_KEY = "YSKfst7GaVkXwZYvVihJsKF9r89koz";

const INIT_URL = `https://${CAPTCHA_PREFIX}.captcha-open-southeast.aliyuncs.com/`;
const VERIFY_URL = `https://${CAPTCHA_PREFIX}-verify.captcha-open-southeast.aliyuncs.com/`;

// Permutation table + keys for the custom stream cipher (from the bundle).
const PERM_TABLE = [
  32, 50, 10, 51, 6, 44, 37, 16, 46, 11, 62, 19, 43, 25, 23, 30,
  60, 33, 53, 34, 7, 26, 12, 48, 5, 2, 20, 4, 61, 13, 47, 49,
  18, 29, 27, 22, 1, 17, 39, 56, 41, 38, 55, 31, 15, 58, 52, 40,
  8, 57, 45, 35, 59, 36, 42, 54, 63, 3, 24, 28, 14, 9, 0, 21,
];
const ARG_KEY = "4xrihv8zb8tf1mfj";
const ENCRYPT_KEY = "3e627e1b4c63f913";

const HEX_LOWER = "0123456789abcdef";

// RFC3986 unreserved set — matches the frontend's encoder.
const SAFE_CHARS = new Set(
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_.~"
);

export function urlEncode(value) {
  let out = "";
  for (const byte of Buffer.from(String(value), "utf8")) {
    const ch = String.fromCharCode(byte);
    out += SAFE_CHARS.has(ch)
      ? ch
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function hexValue(code) {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 65 + 10;
  if (code >= 97 && code <= 102) return code - 97 + 10;
  return 0;
}

/** Aliyun RPC signature: HMAC-SHA1 over the canonical query, base64 encoded. */
export function signAliyunParams(params, secret) {
  const keys = Object.keys(params).sort();
  const canonical = keys
    .map((k, i) => `${i ? "&" : ""}${urlEncode(k)}=${urlEncode(params[k])}`)
    .join("");
  const stringToSign = `POST&${urlEncode("/")}&${urlEncode(canonical)}`;
  return crypto
    .createHmac("sha1", `${secret}&`)
    .update(stringToSign)
    .digest("base64");
}

function buildQuery(params) {
  return Object.keys(params)
    .sort()
    .map((k) => `${urlEncode(k)}=${urlEncode(params[k])}`)
    .join("&");
}

function isoTimestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function aliyunPost(url, body, extraHeaders = {}) {
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      ...extraHeaders,
    },
    body,
  });
  return resp.text();
}

/** Custom stream cipher (RC4-like) over a 64-entry permutation table. */
function streamCipher(input, key) {
  const state = PERM_TABLE.slice();
  const size = state.length;

  for (let i = 0, j = 0; i < size; i++) {
    j = (((i + j + state[i] + state[j]) >> 1) + key.charCodeAt(i % key.length)) & (size - 1);
    if (i !== j) [state[i], state[j]] = [state[j], state[i]];
  }

  const out = Buffer.alloc(input.length);
  for (let e = 0, a = 0, idx = 0; idx < input.length; idx++) {
    a = ((e ^ a) + (state[e] ^ state[a])) & (size - 1);
    if (e !== a) [state[e], state[a]] = [state[a], state[e]];
    let m = input[idx];
    m = m + e + state[e] - a - state[a];
    m ^= state[e] + state[a];
    m ^= state[(state[e] + state[a]) & (size - 1)];
    out[idx] = m & 255;
    e = (e + 1) & (size - 1);
  }
  return out;
}

function generateArg(certifyId) {
  const encoded = urlEncode(certifyId);
  const bytes = [];
  for (let i = 0; i < encoded.length; ) {
    if (encoded[i] === "%" && i + 2 < encoded.length) {
      bytes.push((hexValue(encoded.charCodeAt(i + 1)) << 4) | hexValue(encoded.charCodeAt(i + 2)));
      i += 3;
    } else {
      bytes.push(encoded.charCodeAt(i));
      i++;
    }
  }
  return streamCipher(Buffer.from(bytes), ARG_KEY).toString("base64");
}

function encrypt(plaintext) {
  return streamCipher(Buffer.from(plaintext), ENCRYPT_KEY).toString("base64");
}

/** 16-byte-state hash used to prefix the Track payload. */
export function aliHash(input, salt) {
  const data = Buffer.from(input, "utf8");
  const key = Buffer.from(salt, "utf8");
  const state = new Array(16);
  for (let i = 0; i < 16; i++) state[i] = (i << 4) + (i % 16);

  for (let i = 0, j = 0; i < 16; i++) {
    j = (((i + j + state[i] + state[j]) >> 1) + key[i % key.length]) & 15;
    [state[i], state[j]] = [state[j], state[i]];
  }

  for (let idx = 0, p = 0, q = 0; idx < data.length; idx++) {
    q = ((p ^ q) + (state[p] ^ state[q])) & 15;
    [state[p], state[q]] = [state[q], state[p]];
    let c = data[idx];
    c = (c + p + q) ^ state[p] ^ state[q];
    c &= 255;
    state[p] = c;
    p = (p + 1) & 15;
  }

  for (let step = 0; step < 32; step++) {
    const pos = step % 16;
    if (pos !== 0) state[pos] ^= state[pos - 1];
    else state[0] ^= state[15];
  }

  return state.map((b) => HEX_LOWER[(b >> 4) & 15] + HEX_LOWER[b & 15]).join("");
}

async function initCaptcha() {
  const params = {
    AccessKeyId: ACCESS_KEY,
    Action: "InitCaptchaV3",
    Format: "JSON",
    Language: "en",
    Mode: "popup",
    SceneId: CAPTCHA_SCENE_ID,
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: "1.0",
    Timestamp: isoTimestamp(),
    UpLang: "true",
    Version: "2023-03-05",
  };
  params.Signature = signAliyunParams(params, SECRET_KEY);
  const body = await aliyunPost(INIT_URL, buildQuery(params));
  const json = JSON.parse(body);
  if (!json.CertifyId) throw new Error(`InitCaptchaV3 returned no CertifyId: ${body.slice(0, 200)}`);
  return json.CertifyId;
}

async function verifyCaptcha(certifyId, dataValue, deviceToken) {
  const cvp = JSON.stringify({
    certifyId,
    data: dataValue,
    deviceToken,
    sceneId: CAPTCHA_SCENE_ID,
  });
  const params = {
    AccessKeyId: ACCESS_KEY,
    Action: "VerifyCaptchaV3",
    Format: "JSON",
    SignatureMethod: "HMAC-SHA1",
    SignatureVersion: "1.0",
    Timestamp: isoTimestamp(),
    Version: "2023-03-05",
    SceneId: CAPTCHA_SCENE_ID,
    CertifyId: certifyId,
    CaptchaVerifyParam: cvp,
    SignatureNonce: crypto.randomUUID(),
  };
  params.Signature = signAliyunParams(params, SECRET_KEY);
  const body = await aliyunPost(VERIFY_URL, buildQuery(params), { Referer: "" });
  const json = JSON.parse(body);

  if (json.Success && json.Result?.VerifyResult) {
    const securityToken = json.Result.securityToken;
    const certify = json.Result.certifyId;
    if (securityToken && certify) {
      return Buffer.from(
        JSON.stringify({
          certifyId: certify,
          isSign: true,
          sceneId: CAPTCHA_SCENE_ID,
          securityToken,
        })
      ).toString("base64");
    }
  }
  // F001 == device token rejected/consumed; the caller retries with a new one.
  return null;
}

/**
 * Mint one captcha_verify_param from a single-use device token.
 * Returns null when the device token is rejected (already consumed).
 */
export async function computeCaptchaVerifyParam(deviceToken) {
  if (!deviceToken) return null;
  const certifyId = await initCaptcha();
  const now = Date.now();
  const track = {
    TrackList: { fi: "", ks: "", mc: "", mp: "", mu: "", startTime: now, tc: "", te: "", tmv: "" },
    TrackStartTime: now,
    VerifyTime: now + 300,
    arg: generateArg(certifyId),
  };
  const trackJson = JSON.stringify(track);
  const payload = aliHash(trackJson, "0000") + trackJson;
  const compressed = zlib.deflateSync(Buffer.from(payload, "utf8"));
  const finalValue = encrypt(compressed.toString("base64"));
  return verifyCaptcha(certifyId, finalValue, deviceToken);
}

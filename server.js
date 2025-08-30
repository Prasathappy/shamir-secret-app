const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(express.static("public"));
app.use(express.json());

/* -------------------- BigInt helpers -------------------- */

// Parse an arbitrary-base string into BigInt (supports up to base 36)
function parseBigIntFromBase(str, base) {
  const b = BigInt(base);
  let res = 0n;
  for (const ch of str.trim().toLowerCase()) {
    let digit;
    if (ch >= '0' && ch <= '9') digit = BigInt(ch.charCodeAt(0) - '0'.charCodeAt(0));
    else if (ch >= 'a' && ch <= 'z') digit = BigInt(10 + ch.charCodeAt(0) - 'a'.charCodeAt(0));
    else throw new Error(`Invalid digit '${ch}' for base ${base}`);
    if (digit >= b) throw new Error(`Digit '${ch}' out of range for base ${base}`);
    res = res * b + digit;
  }
  return res;
}

function absBigInt(a) { return a >= 0n ? a : -a; }
function gcdBigInt(a, b) {
  a = absBigInt(a); b = absBigInt(b);
  while (b !== 0n) { const t = a % b; a = b; b = t; }
  return a;
}

/* -------------------- Fraction (BigInt) -------------------- */

class Fraction {
  constructor(num, den = 1n) {
    if (den === 0n) throw new Error("Division by zero");
    // normalize sign to denominator positive
    if (den < 0n) { num = -num; den = -den; }
    const g = gcdBigInt(num, den);
    this.num = num / g;
    this.den = den / g;
  }
  static fromBigInt(x) { return new Fraction(x, 1n); }
  add(other) { return new Fraction(this.num * other.den + other.num * this.den, this.den * other.den); }
  sub(other) { return new Fraction(this.num * other.den - other.num * this.den, this.den * other.den); }
  mul(other) { return new Fraction(this.num * other.num, this.den * other.den); }
  div(other) {
    if (other.num === 0n) throw new Error("Division by zero (fraction)");
    return new Fraction(this.num * other.den, this.den * other.num);
  }
  toBigIntExact() {
    if (this.den !== 1n) throw new Error(`Fraction is not an integer: ${this.num}/${this.den}`);
    return this.num;
  }
}

/* -------------------- Lagrange interpolation at x=0 -------------------- */
/**
 * Given k points (x_i, y_i) with BigInt coordinates, compute P(0) exactly:
 * P(0) = sum_{i=1..k} y_i * Π_{j≠i} (-x_j) / (x_i - x_j)
 * Result is a BigInt (for valid SSS-style inputs).
 */
function interpolateAtZero(points) {
  const k = points.length;
  let acc = new Fraction(0n, 1n);

  for (let i = 0; i < k; i++) {
    const xi = BigInt(points[i][0]);
    const yi = BigInt(points[i][1]);

    let num = new Fraction(yi, 1n); // start with y_i
    let den = new Fraction(1n, 1n);

    for (let j = 0; j < k; j++) {
      if (i === j) continue;
      const xj = BigInt(points[j][0]);
      // multiply numerator by (-x_j)
      num = num.mul(new Fraction(-xj, 1n));
      // multiply denominator by (x_i - x_j)
      den = den.mul(new Fraction(xi - xj, 1n));
    }

    const term = num.div(den); // y_i * Π(-x_j)/(x_i - x_j)
    acc = acc.add(term);
  }

  return acc.toBigIntExact(); // should be integer for well-formed inputs
}

/* -------------------- Wrong-share detection -------------------- */
/**
 * 1) Compute secrets for all C(n,k) subsets; tally the most frequent "majority secret".
 * 2) Pick any one subset that yields the majority secret (consider it an "inlier core").
 * 3) For each remaining share s:
 *      compute secret using s + (k-1) shares from the inlier core.
 *      If it matches majority secret -> valid, else -> wrong.
 */
function combinationsIndices(n, k) {
  // yields arrays of indices (0..n-1 choose k)
  const result = [];
  const comb = Array.from({ length: k }, (_, i) => i);
  const last = n - 1;

  while (true) {
    result.push(comb.slice());
    // next combination
    let i = k - 1;
    while (i >= 0 && comb[i] === last - (k - 1 - i)) i--;
    if (i < 0) break;
    comb[i]++;
    for (let j = i + 1; j < k; j++) comb[j] = comb[j - 1] + 1;
  }
  return result;
}

function detectWrongShares(allPoints, k) {
  const n = allPoints.length;
  if (k > n) throw new Error("k cannot be greater than number of shares");

  // 1) Tally secrets over all k-combinations
  const idxCombos = combinationsIndices(n, k);
  const secretCount = new Map();
  const subsetBySecret = new Map(); // store one representative subset for each secret

  for (const idxs of idxCombos) {
    const subset = idxs.map(i => allPoints[i].slice(0, 2)); // [x,y]
    try {
      const sec = interpolateAtZero(subset).toString();
      const count = (secretCount.get(sec) || 0) + 1;
      secretCount.set(sec, count);
      if (!subsetBySecret.has(sec)) subsetBySecret.set(sec, idxs);
    } catch {
      // ignore (non-integer or degenerate)
    }
  }

  if (secretCount.size === 0) throw new Error("Unable to compute any consistent secret from given shares.");

  // Majority secret
  let majoritySecret = null;
  let maxCount = -1;
  for (const [sec, cnt] of secretCount.entries()) {
    if (cnt > maxCount) { maxCount = cnt; majoritySecret = sec; }
  }

  // 2) Inlier core (one k-subset that yields majority secret)
  const coreIdxs = subsetBySecret.get(majoritySecret);
  const core = coreIdxs.map(i => allPoints[i]);

  // 3) Validate others against core
  const wrong = [];
  const valid = new Set(coreIdxs); // mark core as valid

  for (let i = 0; i < n; i++) {
    if (valid.has(i)) continue;
    // build subset: this share + (k-1) from core
    const subset = [[allPoints[i][0], allPoints[i][1]]];
    for (let j = 0; j < core.length && subset.length < k; j++) {
      subset.push([core[j][0], core[j][1]]);
    }
    // compute secret with this subset
    let sec;
    try { sec = interpolateAtZero(subset).toString(); }
    catch { sec = null; }
    if (sec === majoritySecret) {
      // it's consistent -> valid
      valid.add(i);
    } else {
      wrong.push(i); // index
    }
  }

  const wrongIds = wrong.map(i => allPoints[i][2]);  // original IDs
  const inlierIds = Array.from(valid).map(i => allPoints[i][2]);

  return {
    secret: majoritySecret,
    wrongShareIds: wrongIds,
    inlierShareIds: inlierIds
  };
}

/* -------------------- Route -------------------- */

app.post("/upload", upload.single("jsonfile"), (req, res) => {
  try {
    const filePath = path.join(__dirname, req.file.path);
    const rawData = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(rawData);

    const n = data.keys?.n;
    const k = data.keys?.k;
    if (!Number.isInteger(n) || !Number.isInteger(k)) {
      throw new Error("Invalid or missing keys.n / keys.k");
    }

    // Build points: x = numeric key (ID), y = parsed BigInt value
    const points = [];
    for (const [key, val] of Object.entries(data)) {
      if (key === "keys") continue;
      if (!val || typeof val.base === "undefined" || typeof val.value === "undefined") {
        throw new Error(`Invalid share format for id ${key}`);
      }
      const base = Number(val.base);
      if (!Number.isInteger(base) || base < 2 || base > 36) {
        throw new Error(`Unsupported base for id ${key}: ${val.base}`);
      }
      const y = parseBigIntFromBase(String(val.value), base);
      const x = BigInt(key);            // share ID as x
      points.push([x, y, key]);         // [x, y, "id"]
    }

    if (points.length !== n) {
      // allow, but warn—some JSONs might not match exactly
      // we proceed anyway; detection uses actual points.length
    }

    // Detect wrong shares & get secret
    const { secret, wrongShareIds, inlierShareIds } = detectWrongShares(points, k);

    // Response payload (also return numeric values for plotting)
    const payload = {
      secret,
      totalShares: points.length,
      minShares: k,
      wrongShares: wrongShareIds,
      inlierShares: inlierShareIds,
      points: points.map(([x, y, id]) => ({ id, x: x.toString(), y: y.toString() }))
    };

    // cleanup uploaded file
    fs.unlink(filePath, () => {});

    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message || "Invalid file format or processing error." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));

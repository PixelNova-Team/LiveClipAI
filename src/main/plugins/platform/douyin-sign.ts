/**
 * Douyin a_bogus signature generator.
 * Ported from DouyinLiveRecorder (https://github.com/ihmily/DouyinLiveRecorder)
 * Original author: Hmily. License: Apache-2.0
 */

function rc4Encrypt(plaintext: string, key: string): string {
  const s = Array.from({ length: 256 }, (_, i) => i)
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key.charCodeAt(i % key.length)) % 256
    ;[s[i], s[j]] = [s[j], s[i]]
  }

  let ii = 0
  j = 0
  const result: string[] = []
  for (const char of plaintext) {
    ii = (ii + 1) % 256
    j = (j + s[ii]) % 256
    ;[s[ii], s[j]] = [s[j], s[ii]]
    const t = (s[ii] + s[j]) % 256
    result.push(String.fromCharCode(s[t] ^ char.charCodeAt(0)))
  }
  return result.join('')
}

function leftRotate(x: number, n: number): number {
  n %= 32
  return ((x << n) | (x >>> (32 - n))) >>> 0
}

function getTj(j: number): number {
  return j < 16 ? 2043430169 : 2055708042
}

function ffJ(j: number, x: number, y: number, z: number): number {
  if (j < 16) return (x ^ y ^ z) >>> 0
  return ((x & y) | (x & z) | (y & z)) >>> 0
}

function ggJ(j: number, x: number, y: number, z: number): number {
  if (j < 16) return (x ^ y ^ z) >>> 0
  return ((x & y) | (~x & z)) >>> 0
}

class SM3 {
  private reg: number[] = []
  private chunk: number[] = []
  private size = 0

  constructor() {
    this.reset()
  }

  reset(): void {
    this.reg = [1937774191, 1226093241, 388252375, 3666478592, 2842636476, 372324522, 3817729613, 2969243214]
    this.chunk = []
    this.size = 0
  }

  write(data: string | number[]): void {
    const a = typeof data === 'string'
      ? Array.from(Buffer.from(data, 'utf-8'))
      : data
    this.size += a.length
    const f = 64 - this.chunk.length
    if (a.length < f) {
      this.chunk.push(...a)
    } else {
      this.chunk.push(...a.slice(0, f))
      let offset = f
      while (this.chunk.length >= 64) {
        this.compress(this.chunk)
        if (offset < a.length) {
          this.chunk = a.slice(offset, Math.min(offset + 64, a.length))
        } else {
          this.chunk = []
        }
        offset += 64
      }
    }
  }

  private fill(): void {
    const bitLength = 8 * this.size
    this.chunk.push(0x80)
    let paddingPos = this.chunk.length % 64
    if (64 - paddingPos < 8) {
      while (this.chunk.length % 64 !== 0) this.chunk.push(0)
    }
    while (this.chunk.length % 64 !== 56) this.chunk.push(0)
    const highBits = Math.floor(bitLength / 4294967296)
    for (let i = 0; i < 4; i++) this.chunk.push((highBits >>> (8 * (3 - i))) & 0xFF)
    for (let i = 0; i < 4; i++) this.chunk.push((bitLength >>> (8 * (3 - i))) & 0xFF)
  }

  private compress(data: number[]): void {
    const w: number[] = new Array(132).fill(0)
    for (let t = 0; t < 16; t++) {
      w[t] = ((data[4 * t] << 24) | (data[4 * t + 1] << 16) | (data[4 * t + 2] << 8) | data[4 * t + 3]) >>> 0
    }
    for (let j = 16; j < 68; j++) {
      let a = (w[j - 16] ^ w[j - 9] ^ leftRotate(w[j - 3], 15)) >>> 0
      a = (a ^ leftRotate(a, 15) ^ leftRotate(a, 23)) >>> 0
      w[j] = (a ^ leftRotate(w[j - 13], 7) ^ w[j - 6]) >>> 0
    }
    for (let j = 0; j < 64; j++) {
      w[j + 68] = (w[j] ^ w[j + 4]) >>> 0
    }

    let [a, b, c, d, e, f, g, h] = this.reg
    for (let j = 0; j < 64; j++) {
      const ss1 = leftRotate(((leftRotate(a, 12) + e + leftRotate(getTj(j), j)) >>> 0), 7)
      const ss2 = (ss1 ^ leftRotate(a, 12)) >>> 0
      const tt1 = ((ffJ(j, a, b, c) + d + ss2 + w[j + 68]) >>> 0)
      const tt2 = ((ggJ(j, e, f, g) + h + ss1 + w[j]) >>> 0)
      d = c
      c = leftRotate(b, 9)
      b = a
      a = tt1
      h = g
      g = leftRotate(f, 19)
      f = e
      e = (tt2 ^ leftRotate(tt2, 9) ^ leftRotate(tt2, 17)) >>> 0
    }

    this.reg[0] = (this.reg[0] ^ a) >>> 0
    this.reg[1] = (this.reg[1] ^ b) >>> 0
    this.reg[2] = (this.reg[2] ^ c) >>> 0
    this.reg[3] = (this.reg[3] ^ d) >>> 0
    this.reg[4] = (this.reg[4] ^ e) >>> 0
    this.reg[5] = (this.reg[5] ^ f) >>> 0
    this.reg[6] = (this.reg[6] ^ g) >>> 0
    this.reg[7] = (this.reg[7] ^ h) >>> 0
  }

  sum(data?: string | number[]): number[] {
    if (data !== undefined) {
      this.reset()
      this.write(data)
    }
    this.fill()
    for (let f = 0; f < this.chunk.length; f += 64) {
      this.compress(this.chunk.slice(f, f + 64))
    }
    const result: number[] = []
    for (let f = 0; f < 8; f++) {
      const c = this.reg[f]
      result.push((c >>> 24) & 0xFF, (c >>> 16) & 0xFF, (c >>> 8) & 0xFF, c & 0xFF)
    }
    this.reset()
    return result
  }
}

const ENCODING_TABLES: Record<string, string> = {
  s3: 'ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe',
  s4: 'Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe',
}

function getLongInt(roundNum: number, longStr: string): number {
  const rn = roundNum * 3
  const c1 = rn < longStr.length ? longStr.charCodeAt(rn) : 0
  const c2 = rn + 1 < longStr.length ? longStr.charCodeAt(rn + 1) : 0
  const c3 = rn + 2 < longStr.length ? longStr.charCodeAt(rn + 2) : 0
  return (c1 << 16) | (c2 << 8) | c3
}

function resultEncrypt(longStr: string, tableKey: string): string {
  const masks = [16515072, 258048, 4032, 63]
  const shifts = [18, 12, 6, 0]
  const table = ENCODING_TABLES[tableKey]
  const result: string[] = []
  let roundNum = 0
  let longInt = getLongInt(0, longStr)
  const total = Math.ceil(longStr.length / 3 * 4)
  for (let i = 0; i < total; i++) {
    if (Math.floor(i / 4) !== roundNum) {
      roundNum++
      longInt = getLongInt(roundNum, longStr)
    }
    const idx = i % 4
    const charIndex = (longInt & masks[idx]) >> shifts[idx]
    result.push(table[charIndex])
  }
  return result.join('')
}

function generRandom(randomNum: number, option: [number, number]): number[] {
  const b1 = randomNum & 255
  const b2 = (randomNum >> 8) & 255
  return [
    (b1 & 170) | (option[0] & 85),
    (b1 & 85) | (option[0] & 170),
    (b2 & 170) | (option[1] & 85),
    (b2 & 85) | (option[1] & 170),
  ]
}

function generateRandomStr(): string {
  const randomValues = [0.123456789, 0.987654321, 0.555555555]
  const randomBytes: number[] = []
  randomBytes.push(...generRandom(Math.floor(randomValues[0] * 10000), [3, 45]))
  randomBytes.push(...generRandom(Math.floor(randomValues[1] * 10000), [1, 0]))
  randomBytes.push(...generRandom(Math.floor(randomValues[2] * 10000), [1, 5]))
  return randomBytes.map(b => String.fromCharCode(b)).join('')
}

function splitToBytes(num: number): number[] {
  return [(num >>> 24) & 255, (num >>> 16) & 255, (num >>> 8) & 255, num & 255]
}

function generateRc4BbStr(urlParams: string, userAgent: string, windowEnv: string): string {
  const sm3 = new SM3()
  const startTime = Math.floor(Date.now())

  const urlHash = sm3.sum(sm3.sum(urlParams + 'cus'))
  const cusHash = sm3.sum(sm3.sum('cus'))
  const uaKey = '\0\x01\x0e'
  const uaHash = sm3.sum(resultEncrypt(rc4Encrypt(userAgent, uaKey), 's3'))

  const endTime = startTime + 100
  const pageId = 110624
  const aid = 6383

  const b: Record<number, number> = {}
  b[18] = 44

  const stb = splitToBytes(startTime & 0xFFFFFFFF)
  b[20] = stb[0]; b[21] = stb[1]; b[22] = stb[2]; b[23] = stb[3]
  b[24] = Math.floor(startTime / 256 / 256 / 256 / 256) & 255
  b[25] = Math.floor(startTime / 256 / 256 / 256 / 256 / 256) & 255

  const a0b = splitToBytes(0)
  b[26] = a0b[0]; b[27] = a0b[1]; b[28] = a0b[2]; b[29] = a0b[3]
  b[30] = Math.floor(1 / 256) & 255
  b[31] = 1 & 255
  const a1b = splitToBytes(1)
  b[32] = a1b[0]; b[33] = a1b[1]
  const a2b = splitToBytes(14)
  b[34] = a2b[0]; b[35] = a2b[1]; b[36] = a2b[2]; b[37] = a2b[3]

  b[38] = urlHash[21]; b[39] = urlHash[22]
  b[40] = cusHash[21]; b[41] = cusHash[22]
  b[42] = uaHash[23]; b[43] = uaHash[24]

  const etb = splitToBytes(endTime & 0xFFFFFFFF)
  b[44] = etb[0]; b[45] = etb[1]; b[46] = etb[2]; b[47] = etb[3]
  b[48] = 3
  b[49] = Math.floor(endTime / 256 / 256 / 256 / 256) & 255
  b[50] = Math.floor(endTime / 256 / 256 / 256 / 256 / 256) & 255

  b[51] = pageId
  const pidb = splitToBytes(pageId)
  b[52] = pidb[0]; b[53] = pidb[1]; b[54] = pidb[2]; b[55] = pidb[3]
  b[56] = aid
  b[57] = aid & 255
  b[58] = (aid >> 8) & 255
  b[59] = (aid >> 16) & 255
  b[60] = (aid >> 24) & 255

  const wenv = Array.from(windowEnv).map(c => c.charCodeAt(0))
  b[64] = wenv.length
  b[65] = b[64] & 255
  b[66] = (b[64] >> 8) & 255
  b[69] = 0; b[70] = 0; b[71] = 0

  b[72] = (
    b[18] ^ b[20] ^ b[26] ^ b[30] ^ b[38] ^ b[40] ^ b[42]
    ^ b[21] ^ b[27] ^ b[31] ^ b[35] ^ b[39] ^ b[41] ^ b[43]
    ^ b[22] ^ b[28] ^ b[32] ^ b[36] ^ b[23] ^ b[29] ^ b[33]
    ^ b[37] ^ b[44] ^ b[45] ^ b[46] ^ b[47] ^ b[48] ^ b[49]
    ^ b[50] ^ b[24] ^ b[25] ^ b[52] ^ b[53] ^ b[54] ^ b[55]
    ^ b[57] ^ b[58] ^ b[59] ^ b[60] ^ b[65] ^ b[66] ^ b[70] ^ b[71]
  )

  const bb = [
    b[18], b[20], b[52], b[26], b[30], b[34], b[58], b[38], b[40], b[53],
    b[42], b[21], b[27], b[54], b[55], b[31], b[35], b[57], b[39], b[41],
    b[43], b[22], b[28], b[32], b[60], b[36], b[23], b[29], b[33], b[37],
    b[44], b[45], b[59], b[46], b[47], b[48], b[49], b[50], b[24], b[25],
    b[65], b[66], b[70], b[71],
  ]
  bb.push(...wenv)
  bb.push(b[72])

  return rc4Encrypt(bb.map(x => String.fromCharCode(x)).join(''), String.fromCharCode(121))
}

export function abSign(urlSearchParams: string, userAgent: string): string {
  const windowEnv = '1920|1080|1920|1040|0|30|0|0|1872|92|1920|1040|1857|92|1|24|Win32'
  return resultEncrypt(
    generateRandomStr() + generateRc4BbStr(urlSearchParams, userAgent, windowEnv),
    's4',
  ) + '='
}

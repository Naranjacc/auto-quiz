/**
 * API client for fengchuanba.com / fengxueba.com quiz platform.
 *
 * Replaces browser automation with direct HTTP API calls.
 *
 * Protocol reverse-engineered from WeChat Fiddler capture (111.saz):
 *   1. POST getSecretBoxBaseConfig  →  get `i` value (no sign needed)
 *   2. POST startExplore            →  first question + exploreDetail
 *   3. POST nextCheckPoint          →  submit answer, get next question
 *
 * Sign algorithm (verified against captured sessions):
 *   prefix  = AES-CBC(secretBoxBaseConfig.i, secretKey[8:24], secretKey[12:28])
 *   suffix  = prefix[1:3] + secretBoxCode[3:7]
 *   sign    = MD5(prefix + "&" + sorted(params) + "=" + suffix)
 *
 * @module api/client
 */

// WeChat App ID — 通过环境变量 WECHAT_APPID 设置，或写入 ~/.auto-quiz.json
const WECHAT_APPID = process.env.WECHAT_APPID || '';

import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Crypto helpers (pure Node.js — no dependency needed)
// ---------------------------------------------------------------------------

/**
 * AES-128-CBC decrypt (PKCS7 padding).
 * Matches CryptoJS.AES.decrypt in the browser app.
 */
function aesDecrypt(encryptedBase64, keyStr, ivStr) {
  const key = Buffer.from(keyStr, 'utf8');       // 16 bytes
  const iv = Buffer.from(ivStr, 'utf8');          // 16 bytes
  const encrypted = Buffer.from(encryptedBase64, 'base64');

  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(true); // PKCS7

  let decrypted = decipher.update(encrypted);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * MD5 hash (returns 32-char lowercase hex string).
 */
function md5(data) {
  return crypto.createHash('md5').update(data, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Sign generation
// ---------------------------------------------------------------------------

/**
 * Build the `sign` parameter for authenticated API requests.
 *
 * @param {object} params     - Key-value pairs for the request body
 * @param {string} secretKey  - 32-char secretKey from URL hash
 * @param {string} secretBoxCode - box code from URL hash
 * @param {string} prefix     - Decrypted `i` value from getSecretBoxBaseConfig
 * @param {number} tsMs       - Current time in milliseconds (Date.now())
 * @returns {object} { sign, ts, tsy }
 */
export function buildSign(params, secretKey, secretBoxCode, prefix, tsMs) {
  // 1. Sort params alphabetically as "key=value" pairs
  const sorted = Object.keys(params)
    .sort()
    .map(k => `${k}=${params[k] ?? ''}`);

  // 2. Append ts in seconds
  const tsSec = Math.floor(tsMs / 1000);
  sorted.push(`ts=${tsSec}`);

  // 3. Build suffix: prefix[1:3] + secretBoxCode[3:7]
  const suffix = prefix.substring(1, 3) + secretBoxCode.substring(3, 7);

  // 4. sign = MD5(prefix + "&" + sorted.join("&") + "=" + suffix)
  const sign = md5(`${prefix}&${sorted.join('&')}=${suffix}`);

  return { sign, ts: tsMs, tsy: -996 };
}

// ---------------------------------------------------------------------------
// API Client
// ---------------------------------------------------------------------------

/**
 * Create a quiz API client bound to one quiz box.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl      - e.g. "https://x21854901.fengxueba.com"
 * @param {string} opts.secretBoxCode - from URL hash (before the dash)
 * @param {string} opts.secretKey     - from URL hash (after the dash, before _/code/followid)
 * @param {string} opts.userId        - visitor ID (from getVisitor or prior session)
 * @param {string} opts.uuid          - WeChat openid (from getVisitor)
 * @param {string} opts.wxc           - WeChat OAuth code (from URL after OAuth redirect)
 */
export function createApiClient(opts) {
  const { baseUrl, secretBoxCode, secretKey, userId, uuid, wxc } = opts;

  /** Decrypted `i` from getSecretBoxBaseConfig (lazily fetched). */
  let _prefix = null;

  /**
   * POST helper — sends form-urlencoded data and returns parsed JSON.
   */
  async function post(path, data, { sign: needsSign = true } = {}) {
    let body = data;

    if (needsSign) {
      if (!_prefix) {
        // Fetch base config first (this request does NOT need sign)
        const cfg = await post('/service/explore2/getSecretBoxBaseConfig', {
          secretBoxCode,
          secretKey,
        }, { sign: false });

        if (cfg.status !== 1) {
          throw new Error(`getSecretBoxBaseConfig failed: status=${cfg.status}`);
        }

        // Decrypt the `i` field to get the prefix
        _prefix = aesDecrypt(
          cfg.config.i,
          secretKey.substring(8, 24),
          secretKey.substring(12, 28),
        );
      }

      const now = Date.now();
      const { sign, ts, tsy } = buildSign(data, secretKey, secretBoxCode, _prefix, now);
      // Encode the body as form-urlencoded with sign/ts/tsy appended
      const params = new URLSearchParams(data);
      params.set('sign', sign);
      params.set('ts', ts);
      params.set('tsy', tsy);
      body = params.toString();
    } else {
      body = new URLSearchParams(data).toString();
    }

    const url = `${baseUrl}${path}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781 WindowsWechat',
        'Accept': '*/*',
        'Origin': baseUrl,
      },
      body,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`API ${path} returned ${res.status}: ${text.slice(0, 200)}`);
    }

    const text = await res.text();
    if (!text || text.trim().length === 0) {
      throw new Error(
        `API ${path} returned empty body — session credentials (wxc/uuid) may have expired. ` +
        'Re-capture fresh credentials via WeChat + Fiddler, or upload a new SAZ file.'
      );
    }

    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`API ${path} returned invalid JSON (${text.slice(0, 150)}...)`);
    }
  }

  /**
   * Start a quiz session — returns the first question.
   *
   * @returns {Promise<object>} { question, exploreDetail, playChance, status }
   */
  async function startExplore() {
    const data = await post('/service/explore2/startExplore', {
      secretBoxCode,
      secretKey,
      uuid,
      userId,
      preUserId: '0',
      degree: '0',
      isReged: '1',
      ll: '',
      exploreId: '0',
      type: '',
      wxc,
    });

    if (data.status !== 1) {
      throw new Error(`startExplore returned status=${data.status} (quiz may be closed or out of chances)`);
    }

    return data;
  }

  /**
   * Submit an answer and get the next question.
   *
   * @param {object} exploreDetail  - The exploreDetail from the previous response
   * @param {string|number} answer   - The chosen tag value (1-indexed from choiceList)
   * @param {object} [more={}]       - Extra params (passMode, answerStatus, etc.)
   * @returns {Promise<object>} { result, question, exploreDetail, status }
   */
  async function nextCheckPoint(exploreDetail, answer, more = {}) {
    const data = await post('/service/explore2/nextCheckPoint', {
      userId,
      secretBoxCode,
      secretKey,
      passMode: more.passMode ?? '1',
      checkPointSeq: exploreDetail.checkPointSeq,
      questionId: more.questionId ?? '0',
      answer: String(answer),
      answerStatus: more.answerStatus ?? '0',
      answerValue: more.answerValue ?? '',
      exploreId: exploreDetail.exploreId,
      exploreDetailId: exploreDetail.id,
      errorTime: more.errorTime ?? '0',
      reason: more.reason ?? '',
      gs: more.gs ?? '0',
      verifyCode: more.verifyCode ?? '',
    });

    return data;
  }

  /**
   * Exchange WeChat OAuth code for openId (uuid) and visitorId.
   *
   * @param {string} code - WeChat OAuth code from redirect URL
   * @returns {Promise<{openId: string, visitorId: number}>}
   */
  async function getVisitor(code) {
    const url = `${baseUrl}/wechat/getVisitor?appId=${WECHAT_APPID}&code=${encodeURIComponent(code)}&actCode=${secretBoxCode}&desc=box`;
    const res = await fetch(url, {
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781 WindowsWechat',
        'Accept': '*/*',
      },
    });

    if (!res.ok) {
      throw new Error(`getVisitor returned ${res.status}`);
    }

    const data = await res.json();
    if (data.status !== 1) {
      throw new Error(`getVisitor failed: status=${data.status}. Code may be expired.`);
    }

    return { openId: data.openId, visitorId: data.visitorId };
  }

  /**
   * Get quiz configuration and user registration info.
   * Uses the sign prefix from getSecretBoxBaseConfig (fetched lazily).
   *
   * @param {string} [useUuid] - OpenId to use (defaults to this client's uuid)
   * @returns {Promise<object>} Full secret box response with registerInfo + secretBox
   */
  async function getSecretBoxFromWeChat(useUuid) {
    const uid = useUuid || uuid;
    const data = await post('/service/explore2/getSecretBoxFromWeChat', {
      secretBoxCode,
      secretKey,
      uuid: uid,
      preUserId: '0',
      degree: '0',
    });

    if (data.status !== 1) {
      throw new Error(`getSecretBoxFromWeChat returned status=${data.status}`);
    }

    return data;
  }

  /** Refresh the sign prefix (useful if the prefix expired between calls). */
  async function refreshPrefix() {
    _prefix = null;
    await post('/service/explore2/getSecretBoxBaseConfig', {
      secretBoxCode,
      secretKey,
    }, { sign: false });
  }

  // Public API
  return {
    post,
    startExplore,
    nextCheckPoint,
    getVisitor,
    getSecretBoxFromWeChat,
    refreshPrefix,
    get baseUrl() { return baseUrl; },
    get secretBoxCode() { return secretBoxCode; },
    get secretKey() { return secretKey; },
  };
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

/**
 * Parse a fengchuanba/fengxueba quiz URL into client options.
 *
 * URL format (without OAuth code):
 *   https://x{hostCode}.fengxueba.com/index.html#{secretBoxCode}-{secretKey}_{preUserId}_{degree}...
 *
 * URL format (after OAuth redirect, code embedded in hash):
 *   https://x{hostCode}.fengxueba.com/index.html#{secretBoxCode}-{secretKey}code{oauthCode}
 *
 * @param {string} url  - Full quiz URL (with hash)
 * @param {object} [session={}]  - Cached session values { userId, uuid, wxc }
 * @returns {object} { baseUrl, secretBoxCode, secretKey, userId, uuid, wxc }
 */
export function parseQuizUrl(url, session = {}) {
  const u = new URL(url);

  // baseUrl = protocol + host (no path/hash)
  const baseUrl = `${u.protocol}//${u.host}`;

  // Parse hash: secretBoxCode-secretKey[codeXXX][_...]
  const hash = (u.hash || '').replace(/^#/, '');

  // Attempt to extract wxc code embedded after secretKey (before first '_' or end)
  // Pattern: ...-secretKeycodeCODEVALUE_...  or  ...-secretKeycodeCODEVALUE
  let secretBoxCode, secretKey, wxcFromHash = '';
  const codeIdx = hash.indexOf('code');

  if (codeIdx > 0) {
    // Code is embedded after secretKey
    const beforeCode = hash.substring(0, codeIdx);
    const afterCode = hash.substring(codeIdx + 4); // skip "code"

    const [box, key] = beforeCode.split('-');
    secretBoxCode = box;
    secretKey = key;

    // wxc code is between "code" and the next '_' or end
    const nextUnderscore = afterCode.indexOf('_');
    wxcFromHash = nextUnderscore > 0 ? afterCode.substring(0, nextUnderscore) : afterCode;
  } else {
    // No code embedded — standard format
    const [boxAndKey, ...rest] = hash.split('_');
    const [box, key] = boxAndKey.split('-');
    secretBoxCode = box;
    secretKey = key;
  }

  if (!secretBoxCode || !secretKey) {
    throw new Error(`Cannot parse secretBoxCode/secretKey from URL hash: "${hash}"`);
  }

  return {
    baseUrl,
    secretBoxCode,
    secretKey,
    userId: session.userId || '',
    uuid: session.uuid || '',
    wxc: wxcFromHash || session.wxc || '',
  };
}

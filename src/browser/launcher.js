/**
 * Browser launcher — creates a Playwright Chromium instance with
 * anti-detection measures suitable for quiz / exam platforms.
 *
 * Exports:
 *   launchBrowser(config) → { browser, page }
 *
 * config keys used:
 *   - headless  (boolean, default true)
 *   - timeout   (number,  default 30000 – passed as default page timeout)
 */

import { chromium } from 'playwright';

/** Realistic Chrome 130 on Windows 11 – avoids the headless/automation fingerprint. */
const REALISTIC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/**
 * Launch a Chromium browser with anti-detection measures and return
 * the browser handle plus a ready-to-use page.
 *
 * @param {object} config
 * @param {boolean} [config.headless=true]
 * @param {number}  [config.timeout=30000]  Default timeout in ms for all page operations
 * @returns {Promise<{ browser: import('playwright').Browser, page: import('playwright').Page }>}
 */
export async function launchBrowser(config = {}) {
  const { headless = true, timeout = 30000 } = config;

  console.log('[launcher] Starting Chromium (headless=%s, timeout=%d ms)', headless, timeout);

  const browser = await chromium.launch({
    headless,
    channel: 'chrome',  // use system Chrome (better anti-detection, no download needed)
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  });

  const isWeChat = config.wechat !== false;  // default true for WeChat platforms
  const context = await browser.newContext({
    viewport: isWeChat ? { width: 414, height: 896 } : { width: 1920, height: 1080 },
    userAgent: isWeChat
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.47(0x18002f2e) NetType/WIFI Language/zh_CN'
      : REALISTIC_UA,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });

  const page = await context.newPage();
  page.setDefaultTimeout(timeout);

  // Strip the `webdriver` property that Playwright sets on the navigator object
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
  });

  // Mock WeChat JS Bridge (for platforms that require WeChat environment)
  if (isWeChat) {
    await page.addInitScript(() => {
      window.WeixinJSBridge = {
        invoke: (api, params, cb) => cb && cb({ err_msg: api + ':ok' }),
        on: (event, cb) => { if (event === 'WeixinJSBridgeReady') cb && cb(); },
        call: (api, params, cb) => cb && cb({ err_msg: api + ':ok' }),
      };
      window.__wxjs_environment = 'browser';
      // Fire the ready event after a short delay
      setTimeout(() => {
        const ev = new Event('WeixinJSBridgeReady');
        document.dispatchEvent(ev);
      }, 100);
    });
  }

  console.log('[launcher] Browser ready');

  return { browser, page };
}

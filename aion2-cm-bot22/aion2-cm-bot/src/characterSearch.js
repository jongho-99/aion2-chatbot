const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { resolveServer } = require('./servers');

/**
 * aion2tool.com 캐릭터 검색 → 상세 페이지에서 무기/가더 + 세트 효과 추출
 *
 * 흐름
 *  1) https://aion2tool.com/ 접속 → #character-keyword 입력 → #search-button 클릭
 *  2) 결과 카드(a.character-search-card) 중 data-nickname/data-server-id 가 정확히 일치하는 카드 선택
 *  3) 카드 링크(상세 페이지)로 이동
 *  4) div.equipment-item 들에서
 *     - 무기/가더 카드: 이름 등 정보 + 웹페이지에 보이는 카드 그대로 스크린샷
 *     - "OO의 시련 (N피스 보유, N세트 활성)" 세트 뱃지 목록
 *
 * 참고: 각 .equipment-item 에는 data-item-data 속성에 장비 정보가 JSON으로 통째로 들어있다.
 *       (name, enhance_level, exceed_level, soul_bind_rate, main_stats, sub_stats, slot_pos_name ...)
 *       화면 글자를 긁는 것보다 이 JSON을 읽는 쪽이 사이트 디자인이 바뀌어도 훨씬 덜 깨진다.
 */

const BASE_URL = 'https://aion2tool.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const SEL = {
  keywordInput: '#character-keyword',
  searchButton: '#search-button',
  resultCard: 'a.character-search-card',
  equipmentItem: 'div.equipment-item',
};

// 세트 뱃지 문구: "군단장의 시련 (8피스 보유, 8세트 활성)"
const SET_REGEX_SOURCE = '^(.+?)\\s*\\((\\d+)\\s*피스 보유,\\s*(\\d+)\\s*세트 활성\\)$';
// 출력 순서 (여기 없는 세트는 뒤에 붙음)
const SET_ORDER = ['군단장', '천부장', '백부장'];

// 브라우저 화면 크기
const VIEWPORT = { width: 1280, height: 1800, deviceScaleFactor: 1 };

// 페이지에서 필요한 요소가 나타날 때까지 기다리는 최대 시간
const NAV_TIMEOUT = 60000;
// 오류가 나면 그 순간의 화면/HTML 을 여기 저장 (원인 파악용)
const DEBUG_DIR = path.join(__dirname, '..', 'debug');

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

/** 사용자에게 그대로 보여줘도 되는 오류 (서버명 오타, 캐릭터 없음 등) */
class SearchError extends Error {}

// ─── 브라우저 1개 재사용 ───
let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] })
      .then((b) => {
        b.on('disconnected', () => { browserPromise = null; });
        return b;
      })
      .catch((err) => { browserPromise = null; throw err; });
  }
  return browserPromise;
}

async function closeBrowser() {
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  browserPromise = null;
  if (b) await b.close().catch(() => {});
}

// ─── 검색 요청은 한 번에 하나씩 ───
let queue = Promise.resolve();
let queueSize = 0; // 실행 중 + 대기 중인 작업 수
function enqueue(task) {
  queueSize++;
  const run = queue.then(task, task).finally(() => { queueSize--; });
  queue = run.catch(() => {});
  return run;
}

/**
 * 광고/분석 스크립트 도메인. 이 사이트는 광고 스크립트(venatus 등)가 많아서
 * 이것들 때문에 페이지 로딩이 60초 넘게 걸렸다 → 전부 차단 (화면 표시와 무관)
 */
/**
 * 차단할 주소 패턴 (광고/분석 + 이미지/폰트/영상).
 * 필요한 건 글자와 data-* 값뿐이고, 이미지 src 속성값은 차단해도 그대로 읽힌다.
 *
 * ⚠️ 예전엔 page.setRequestInterception(true) 로 막았는데, 이 방식은
 *   ① 브라우저 캐시를 꺼버려서 페이지를 열 때마다 사이트 JS 를 전부 새로 받고
 *   ② 모든 요청이 Node 를 한 번씩 거쳐 가서 느려진다.
 *   → 크롬 자체 기능(Network.setBlockedURLs)으로 바꿔서 캐시를 살리고 요청도 크롬 안에서 바로 차단.
 */
const BLOCKED_URL_PATTERNS = [
  '*googletagmanager*', '*google-analytics*', '*googlesyndication*', '*doubleclick*', '*adservice.google*',
  '*atmtd.com*', '*venatus*', '*adsystem*', '*criteo*', '*pubmatic*', '*rubiconproject*', '*adnxs*',
  '*openx*', '*casalemedia*', '*taboola*', '*outbrain*', '*facebook.net*', '*hotjar*', '*clarity.ms*',
  '*scorecardresearch*', '*quantserve*', '*moatads*', '*id5-sync*', '*prebid*', '*btloader*',
  '*cloudflareinsights*', '*3lift.com*', '*mman.kr*', '*get_ad*', '*teads*', '*smartadserver*',
  '*sharethrough*', '*33across*', '*yieldmo*', '*gumgum*', '*media.net*', '*adform*', '*dable.io*',
  '*.png*', '*.jpg*', '*.jpeg*', '*.gif*', '*.webp*', '*.woff*', '*.ttf*', '*.mp4*', '*profileimg.plaync.com*',
];

async function newPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport(VIEWPORT);
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: BLOCKED_URL_PATTERNS });
  return page;
}

function log(msg) {
  console.log(`[캐릭터검색] ${msg}`);
}

/**
 * page.goto 의 "로딩 완료"를 기다리지 않고, 필요한 요소가 화면에 나타나는 즉시 다음 단계로 간다.
 * (로딩 신호는 늦게 오는 스크립트 하나 때문에 한참 밀릴 수 있음)
 */
async function gotoAndWait(page, url, selector, label, timeout = NAV_TIMEOUT) {
  const t0 = Date.now();
  const nav = page
    .goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })
    .then(() => null)
    .catch((err) => err);

  const ok = await page
    .waitForSelector(selector, { timeout })
    .then(() => true)
    .catch(() => false);

  if (!ok) {
    // 접속 자체가 실패했는지(DNS 오류 등)만 최대 2초 확인하고 넘어간다
    const err = await Promise.race([nav, new Promise((r) => setTimeout(() => r(null), 2000))]);
    if (err && err.name !== 'TimeoutError') throw err;
  }
  log(`${label}: ${ok ? '성공' : '요소 없음'} (${((Date.now() - t0) / 1000).toFixed(1)}초, ${page.url()})`);
  return ok;
}

/**
 * 검색창에 닉네임을 넣고 검색 버튼을 누른다.
 * 마우스 클릭(page.click)은 광고 오버레이 등에 가려지면 "not clickable" 오류가 나므로
 * 페이지 안에서 자바스크립트로 직접 값 입력 + 버튼 click() 을 호출한다.
 */
async function submitSearch(page, nickname) {
  await page.evaluate(
    (inputSel, btnSel, nick) => {
      const input = document.querySelector(inputSel);
      const btn = document.querySelector(btnSel);
      if (!input || !btn) throw new Error('검색창/검색 버튼 없음');
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, nick);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      btn.click();
    },
    SEL.keywordInput, SEL.searchButton, nickname
  );
}

async function dumpDebug(page, tag) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const base = path.join(DEBUG_DIR, `last-error-${tag}`);
    await page.screenshot({ path: `${base}.png`, fullPage: false }).catch(() => {});
    fs.writeFileSync(`${base}.html`, await page.content().catch(() => ''), 'utf-8');
    log(`디버그 저장: ${base}.png / .html  (당시 URL: ${page.url()})`);
  } catch (_) { /* 디버그 저장 실패는 무시 */ }
}

/**
 * @param {string} nickname    예) '강아징'
 * @param {string} serverInput 예) '티아마트' 또는 '티아'
 */
/**
 * @param {string} nickname    예) '강아징'
 * @param {string} serverInput 예) '티아마트' 또는 '티아'
 */
/**
 * @param {{ onProgress?: (stage: 'queued'|'search'|'detail'|'refresh'|'collect') => void }} [opts]
 *   진행 단계가 바뀔 때마다 호출됨 (디스코드 메시지에 진행 상황 표시용)
 */
async function searchCharacter(nickname, serverInput, opts = {}) {
  const server = resolveServer(serverInput);
  if (!server) throw new SearchError(`'${serverInput}' 서버를 찾을 수 없어요. 서버명을 확인해주세요.`);

  // 방금 갱신한 캐릭터는 5분 동안 캐시로 바로 응답 (갱신 버튼 연타 방지 겸)
  const cacheKey = `${server.id}:${nickname}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.data, fromCache: true };

  const progress = (stage) => { try { opts.onProgress?.(stage); } catch { /* 표시 실패는 무시 */ } };
  if (queueSize > 0) progress('queued'); // 앞에 다른 검색(또는 워밍업)이 돌고 있음
  const data = await enqueue(() => scrape(nickname, server, progress));
  cache.set(cacheKey, { at: Date.now(), data });
  return data;
}

// 상세 페이지에서 장비 카드가 뜰 때까지 기다리는 최대 시간
const DETAIL_TIMEOUT = 20000;
// 갱신하기 버튼을 누른 뒤 사이트가 최신 데이터를 받아올 때까지 기다리는 최대 시간
const REFRESH_TIMEOUT = 20000;
// .env 에 DEBUG_NETWORK=1 을 넣으면 상세 페이지가 어떤 API 를 몇 초 걸려 부르는지 로그로 출력
const DEBUG_NETWORK = process.env.DEBUG_NETWORK === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 전체 흐름
 *  1) 검색 페이지에서 캐릭터 검색 → 해당 서버 카드 찾기
 *  2) 상세 페이지 이동 (장비 카드가 뜰 때까지 대기)
 *  3) 곧바로 '갱신하기' 클릭 → 사이트가 아이온2 서버에서 최신 데이터를 받아올 때까지 대기
 *  4) 최신화된 페이지에서 한 번만 크롤링 → 결과 반환 (디스코드 메시지는 이 결과로 1번만 전송)
 *
 * ※ 상세 페이지 주소로 바로 들어가면 장비 정보가 안 뜨고, 검색을 거친 뒤에만 뜬다. → 반드시 검색부터.
 */
async function scrape(nickname, server, progress = () => {}) {
  const browser = await getBrowser();
  const page = await newPage(browser);
  const t0 = Date.now();
  if (DEBUG_NETWORK) attachNetworkLogger(page, t0);

  try {
    // ── 1) 검색 ──
    progress('search');
    const found = await searchCard(page, nickname, server);
    if (!found.card) {
      const hint = found.otherServers.length ? `\n같은 닉네임이 있는 서버: ${found.otherServers.join(', ')}` : '';
      throw new SearchError(`${server.name} 서버에서 '${nickname}' 캐릭터를 찾지 못했어요.${hint}`);
    }
    const card = found.card;

    // 상세 페이지 진입 전부터 사이트 요청을 추적 (갱신 요청이 끝났는지 판단용)
    const tracker = startTracking(page);

    try {
      // ── 2) 상세 페이지 ──
      const detailUrl = `${BASE_URL}/char/serverid=${server.id}/${encodeURIComponent(nickname)}`;
      progress('detail');
      let hasEquip = await gotoAndWait(page, detailUrl, SEL.equipmentItem, '상세 페이지', DETAIL_TIMEOUT);
      if (!hasEquip) {
        hasEquip = await gotoAndWait(page, card.href, SEL.equipmentItem, '상세 페이지(카드 링크)', DETAIL_TIMEOUT);
      }
      if (!hasEquip) {
        await dumpDebug(page, 'detail');
        throw new SearchError('상세 페이지를 불러오지 못했어요. 잠시 후 다시 시도해주세요.');
      }

      // ── 3) 바로 갱신 ──
      progress('refresh');
      const refresh = await clickRefreshAndWait(page, tracker);

      // ── 4) 최신 페이지에서 크롤링 ──
      progress('collect');
      const data = await collect(page, nickname, server, card);
      log(`완료: 갱신 ${refresh} (총 ${((Date.now() - t0) / 1000).toFixed(1)}초)`);
      return { ...data, refresh };
    } finally {
      tracker.stop();
    }
  } catch (err) {
    if (!(err instanceof SearchError)) await dumpDebug(page, 'search');
    throw err;
  } finally {
    await page.close().catch(() => {});
  }
}

/** 현재 상세 페이지에서 결과 객체를 만든다 */
async function collect(page, nickname, server, card) {
  const equipment = await page.evaluate(extractEquipment, SEL.equipmentItem, SET_REGEX_SOURCE);
  if (!equipment.seals.length) log(`인장을 못 찾음. 장비 카드 목록: ${equipment.slotInfo.join(' | ')}`);
  const profile = await page.evaluate(extractProfile, ['아이템 레벨', '전투력']);
  equipment.sets.sort((a, b) => rank(a.name) - rank(b.name));

  return {
    nickname,
    server,
    url: page.url(),
    image: profile.image || card?.image || null,
    // 검색 카드 값을 기본으로, 상세 페이지에서 찾은 값이 있으면 덮어씀
    stats: { ...(card?.stats || {}), ...profile.stats },
    weapon: equipment.weapon,
    guarder: equipment.guarder,
    seals: equipment.seals,
    sets: equipment.sets,
  };
}

/**
 * 페이지의 aion2tool.com 요청(xhr/fetch)을 계속 기록한다.
 * 갱신 버튼을 누른 "이후"에 시작된 요청만 골라서 끝났는지 보기 위함.
 */
function startTracking(page) {
  const origin = new URL(BASE_URL).hostname; // aion2tool.com
  const pending = new Set();
  const t = { pending, afterClick: null, lastActivity: Date.now() };

  // ⚠️ 광고 요청은 주소 뒤쪽(파라미터)에 "현재 페이지 주소=aion2tool.com" 을 달고 다니기 때문에
  //    url.includes('aion2tool.com') 으로 거르면 광고까지 잡혀서 영원히 안 끝났다.
  //    → 요청 "호스트"가 aion2tool.com 인 것만 추적한다.
  const isApi = (req) => {
    if (!['xhr', 'fetch', 'document'].includes(req.resourceType())) return false;
    try {
      const host = new URL(req.url()).hostname;
      return host === origin || host.endsWith(`.${origin}`);
    } catch { return false; }
  };
  const onReq = (req) => {
    if (!isApi(req)) return;
    pending.add(req);
    if (t.afterClick) { t.afterClick.set(req, `${req.method()} ${req.url().split('?')[0]}`); t.lastActivity = Date.now(); }
  };
  const onDone = (req) => {
    if (!pending.delete(req)) return;
    if (t.afterClick && t.afterClick.has(req)) t.lastActivity = Date.now();
  };
  page.on('request', onReq);
  page.on('requestfinished', onDone);
  page.on('requestfailed', onDone);

  t.stop = () => {
    page.off('request', onReq);
    page.off('requestfinished', onDone);
    page.off('requestfailed', onDone);
  };
  return t;
}

/**
 * '갱신하기' 버튼을 바로 누르고, 캐릭터 데이터를 담은 핵심 응답 2개만 기다린다.
 * @returns {'done'|'notfound'|'cooldown'|'timeout'}
 *
 * 버튼을 누르면 사이트가 화면 전체를 다시 그리느라 랭킹/백분위/점수 등 API 를 10개 가까이 부르는데,
 * 우리가 필요한 장비·세트 정보와 관련된 건 아래 2개뿐이다.
 *   - POST /api/character/update-info : 아이온2 서버에서 최신 정보로 갱신
 *   - POST /api/character/search      : 캐릭터 정보(장비 포함) 조회
 * 나머지(랭킹 등)는 기다리지 않는다.
 */
const KEY_APIS = {
  search: /\/api\/character\/search(\?|$)/,
  update: /\/api\/character\/update-info(\?|$)/,
};

async function clickRefreshAndWait(page, tracker) {
  const btn = await page.evaluate(() => {
    const cands = [...document.querySelectorAll('button, a, [role="button"]')];
    const el = cands.find((e) => /갱신/.test(e.textContent || '') && e.offsetParent !== null)
      || cands.find((e) => /갱신/.test(e.textContent || ''));
    if (!el) return { found: false };
    const text = el.textContent.replace(/\s+/g, ' ').trim();
    const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('disabled');
    if (!disabled) el.setAttribute('data-bot-refresh', '1');
    return { found: true, disabled, text };
  });

  // 사이트가 갱신 직후 일정 시간 버튼을 잠가둠 → 이미 최근에 갱신된 데이터라 그대로 사용
  if (!btn.found) { log('갱신 버튼을 찾지 못함 → 현재 정보로 응답'); return 'notfound'; }
  if (btn.disabled) { log(`갱신 버튼 비활성("${btn.text}") → 최근 갱신된 정보로 응답`); return 'cooldown'; }

  // 클릭 "전에" 응답 대기를 걸어둬야 놓치지 않는다
  const done = { search: 0, update: 0 };
  const watch = (key) =>
    page
      .waitForResponse((r) => KEY_APIS[key].test(r.url()) && r.request().method() === 'POST', { timeout: REFRESH_TIMEOUT })
      .then(() => { done[key] = Date.now(); })
      .catch(() => {});
  watch('search');
  watch('update');

  tracker.afterClick = new Map();
  const t0 = Date.now();
  await page.evaluate(() => document.querySelector('[data-bot-refresh="1"]')?.click());
  log(`갱신 버튼 클릭("${btn.text}")`);

  let result = 'timeout';
  while (Date.now() - t0 < REFRESH_TIMEOUT) {
    await sleep(100);
    // 둘 다 받음 → 완료
    if (done.search && done.update) { result = 'done'; break; }
    // 조회 응답은 왔는데 갱신 API 는 안 부르는 경우 대비: 조회 후 2초 기다려도 안 오면 완료로 봄
    if (done.search && Date.now() - done.search > 2000) { result = 'done'; break; }
    // 클릭 후 3초 동안 사이트 요청이 하나도 없으면 갱신이 막힌 상태로 판단
    if (tracker.afterClick.size === 0 && Date.now() - t0 > 3000) { result = 'cooldown'; break; }
  }

  // 응답을 받은 뒤 화면에 다시 그려질 시간
  await sleep(700);
  const ok = await page.waitForSelector(SEL.equipmentItem, { timeout: 10000 }).then(() => true).catch(() => false);
  log(`갱신 대기 ${((Date.now() - t0) / 1000).toFixed(1)}초 → ${result} (조회 ${done.search ? 'O' : 'X'}, 갱신 ${done.update ? 'O' : 'X'})`);
  return ok ? result : 'timeout';
}

/** (디버그용) 상세 페이지가 부르는 API 목록과 걸린 시간을 출력 */
function attachNetworkLogger(page, t0) {
  const started = new Map();
  page.on('request', (req) => started.set(req, Date.now()));
  page.on('requestfinished', (req) => {
    if (!['xhr', 'fetch', 'document'].includes(req.resourceType())) return;
    const took = Date.now() - (started.get(req) || Date.now());
    log(`[net] +${((Date.now() - t0) / 1000).toFixed(1)}s ${req.method()} ${req.url().slice(0, 150)} (${took}ms)`);
  });
  page.on('response', async (res) => {
    const url = res.url();
    if (!/aion2tool\.com\/api\/character\/(search|update-info)/.test(url)) return;
    const body = await res.text().catch(() => '');
    log(`[api] ${res.request().method()} ${url}\n  요청: ${(res.request().postData() || '').slice(0, 300)}\n  응답(${res.status()}): ${body.slice(0, 500)}`);
  });
}

/** 검색 페이지에서 해당 서버의 캐릭터 카드를 찾는다 */
async function searchCard(page, nickname, server) {
  const ready = await gotoAndWait(page, `${BASE_URL}/`, SEL.keywordInput, '검색 페이지');
  if (!ready) throw new Error('검색 페이지에서 검색창(#character-keyword)을 찾지 못함');

  // 사이트 스크립트가 검색 버튼 동작을 붙일 시간을 잠깐 준다 (바로 누르면 무시됨)
  await new Promise((r) => setTimeout(r, 1500));

  const t0 = Date.now();
  for (let attempt = 1; attempt <= 3; attempt++) {
    await submitSearch(page, nickname);
    const hit = await page
      .waitForFunction(
        (sel, nick, sid) =>
          [...document.querySelectorAll(sel)].some((c) => c.dataset.nickname === nick && c.dataset.serverId === sid),
        { timeout: 10000 },
        SEL.resultCard, nickname, server.id
      )
      .then(() => true)
      .catch(() => false);
    if (hit || (await page.$(SEL.resultCard))) break;
    log(`검색 결과 대기 중... (${attempt}/3)`);
  }
  log(`검색 소요 ${((Date.now() - t0) / 1000).toFixed(1)}초`);

  return page.evaluate(
    (sel, nick, sid) => {
      const cards = [...document.querySelectorAll(sel)];
      const card = cards.find((c) => c.dataset.nickname === nick && c.dataset.serverId === sid);
      const otherServers = cards
        .filter((c) => c.dataset.nickname === nick)
        .map((c) => c.querySelector('span')?.textContent.trim())
        .filter(Boolean);
      if (!card) return { card: null, otherServers };
      const stats = {};
      card.querySelectorAll('div').forEach((d) => {
        const spans = d.querySelectorAll(':scope > span');
        if (spans.length === 2) stats[spans[0].textContent.trim()] = spans[1].textContent.trim();
      });
      return {
        card: { href: card.href, image: card.querySelector('img')?.getAttribute('src') || null, stats },
        otherServers,
      };
    },
    SEL.resultCard, nickname, server.id
  );
}

/**
 * ⚠️ 브라우저 안에서 실행됨.
 * 상세 페이지의 프로필 이미지와 "아이템 레벨", "전투력" 숫자를 찾는다.
 * (정확한 선택자를 몰라서, 라벨 글자 바로 옆에 있는 숫자를 찾는 방식)
 */
function extractProfile(labels) {
  const image = document.querySelector('img[src*="profileimg.plaync.com"]')?.getAttribute('src') || null;
  const stats = {};
  const leaves = [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0);
  for (const label of labels) {
    for (const el of leaves) {
      if (el.textContent.trim() !== label) continue;
      const candidates = [
        el.nextElementSibling?.textContent,
        el.parentElement?.nextElementSibling?.textContent,
        el.parentElement?.textContent.replace(label, ''),
      ];
      const value = candidates.map((v) => (v || '').trim()).find((v) => /^[\d,]+$/.test(v));
      if (value) { stats[label] = value; break; }
    }
  }
  return { image, stats };
}

function rank(setName) {
  const i = SET_ORDER.findIndex((k) => setName.includes(k));
  return i === -1 ? SET_ORDER.length : i;
}

/**
 * ⚠️ 이 함수는 브라우저(페이지) 안에서 실행된다. 바깥 변수를 쓸 수 없고 인자로만 받는다.
 */
function extractEquipment(itemSelector, setRegexSource) {
  // 좌측 장비 목록(#equipment-container) 안의 카드만 사용. 구조가 바뀌면 페이지 전체에서 찾음
  const root = document.querySelector('#equipment-container') || document;
  const items = [...root.querySelectorAll(itemSelector)];

  const parsed = items.map((el) => {
    let data = null;
    try {
      data = JSON.parse(el.getAttribute('data-item-data') || 'null');
    } catch (_) { /* JSON 이 깨져 있으면 화면 글자로 대체 */ }
    return { el, data };
  });

  // 무기 = MainHand, 가더 = SubHand. 슬롯 정보가 없으면 순서(1번째, 2번째)로 대체
  const bySlot = (name) => parsed.find((p) => p.data && p.data.slot_pos_name === name);
  const weapon = bySlot('MainHand') || parsed[0];
  const guarder = bySlot('SubHand') || parsed.find((p) => p !== weapon && parsed.indexOf(p) < 2);

  // 인장: 슬롯 이름이 Seal1, Seal2 로 확인됨 (예: 델트라스의 빛나는 인장 / 순례자의 인장)
  // 슬롯 정보가 없을 때만 이름에 '인장'이 들어간 카드로 대체
  const isSealByName = (p) =>
    /인장/.test(p.data?.name || p.el.querySelector('.equipment-item-name')?.textContent || '');
  let seals = ['Seal1', 'Seal2'].map(bySlot).filter(Boolean);
  if (!seals.length) seals = parsed.filter((p) => p !== weapon && p !== guarder && isSealByName(p)).slice(0, 2);

  const summarize = (p) => {
    if (!p) return null;
    const d = p.data || {};
    const nameText = p.el.querySelector('.equipment-item-name')?.textContent.trim();
    return {
      // 화면에 보이는 이름("+20 빛나는 창룡왕의 활")을 우선 사용
      name: nameText || (d.enhance_level ? `+${d.enhance_level} ${d.name}` : d.name) || '(이름 없음)',
      exceed: d.exceed_level || 0,
      grade: d.grade || null,
      soulBindRate: d.soul_bind_rate || null,
      mainStats: (d.main_stats || []).map((s) => `${s.name} ${s.value}`),
      subStats: (d.sub_stats || []).map((s) => `${s.name} ${s.value}`),
      icon: d.icon_url || null,
    };
  };

  // 세트 뱃지: 페이지 전체에서 "(N피스 보유, N세트 활성)" 문구를 찾는다.
  // 같은 세트가 장비마다 반복 표시되므로 이름 기준으로 중복 제거.
  const re = new RegExp(setRegexSource);
  const sets = new Map();
  // ⚠️ 천부장/백부장 세트는 좌측 장비 목록이 아니라 다른 영역(장신구 등)에 표시되므로
  //    페이지 전체에서 찾는다. 문구 형식이 고정이라 다른 글자와 섞일 일은 없음.
  document.querySelectorAll('span').forEach((s) => {
    const m = s.textContent.replace(/\s+/g, ' ').trim().match(re);
    if (!m) return;
    const [, name, pieces, active] = m;
    const prev = sets.get(name);
    if (!prev || Number(pieces) > prev.pieces) sets.set(name, { name, pieces: Number(pieces), active: Number(active) });
  });

  return {
    weapon: summarize(weapon),
    guarder: summarize(guarder),
    seals: seals.map(summarize),
    sets: [...sets.values()],
    // 인장을 못 찾았을 때 원인 확인용: 각 장비 카드의 슬롯/이름
    slotInfo: parsed.map((p) => `${p.data?.slot_pos_name || '?'}:${p.data?.name || '?'}`),
  };
}

/**
 * 봇 시작 시 크롬을 미리 띄우고 aion2tool.com 메인을 한 번 열어둔다.
 *  - 첫 검색 때 크롬 실행 + 사이트 첫 접속(스크립트 다운로드, 쿠키 발급) 비용을 미리 치름
 *  - 쿠키/캐시는 같은 브라우저의 다른 탭에서도 공유되므로 이후 상세 페이지가 빨라진다
 */
function warmUp() {
  return enqueue(warmUpInner);
}

async function warmUpInner() {
  const t0 = Date.now();
  const browser = await getBrowser();
  const page = await newPage(browser);
  try {
    const ok = await gotoAndWait(page, `${BASE_URL}/`, SEL.keywordInput, '워밍업');
    await new Promise((r) => setTimeout(r, 2000)); // 사이트 스크립트가 쿠키 등을 마저 설정할 시간
    log(`워밍업 ${ok ? '완료' : '실패'} (${((Date.now() - t0) / 1000).toFixed(1)}초)`);
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { searchCharacter, closeBrowser, warmUp, SearchError };

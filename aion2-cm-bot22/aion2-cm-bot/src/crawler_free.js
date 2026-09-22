const puppeteer = require('puppeteer');

/**
 * 목록 페이지를 렌더링해서 게시물 [{title, url}] 배열을 반환한다.
 *
 * 이 사이트는 게시판마다 목록 마크업이 다르다. 확인된 두 가지 패턴을 모두 지원한다.
 *
 * [패턴 A] CM아지트 등 - 제목 자체가 링크
 *   <a href="/ko-kr/board/cm_story/view?articleId=..." class="title">제목</a>
 *
 * [패턴 B] 자유게시판 - 피드형, 링크가 따로 없고 컨테이너에 data-articleid만 있음
 *   <section class="article-view ..." data-articleid="6ab1d762628e957dc7782fd7">
 *     ...
 *     <h2 class="view-title">제목</h2>
 *     ...
 *   </section>
 *   → 이 경우 URL은 "/board/<게시판>/view?articleId=<data-articleid>" 형태로 직접 조립해야 한다.
 *
 * 참고로 이 사이트(AION2-NC)는 자바스크립트로 목록을 그려주는 SPA라서,
 * 단순 fetch/axios + cheerio 로는 빈 페이지만 받아지고, 반드시 Puppeteer 같은
 * 헤드리스 브라우저로 "그려진 이후"의 DOM을 읽어야 한다.
 */

const TITLE_LINK_SELECTOR = 'a.title'; // 패턴 A
const FEED_SECTION_SELECTOR = 'section[data-articleid]'; // 패턴 B
const FEED_TITLE_SELECTOR = 'h2.view-title, .view-title'; // 패턴 B 안의 제목

async function fetchArticleList(targetUrl) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
    );

    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // SPA가 목록을 그릴 시간을 벌어준다. (둘 중 뭐가 나오든 상관없이 기다림)
    await page
      .waitForSelector(`${TITLE_LINK_SELECTOR}, ${FEED_SECTION_SELECTOR}`, { timeout: 15000 })
      .catch(() => null);
    await new Promise((r) => setTimeout(r, 1500));

    const articles = await page.evaluate(
      ({ titleLinkSelector, feedSectionSelector, feedTitleSelector }) => {
        // 패턴 A 먼저 시도
        const links = Array.from(document.querySelectorAll(titleLinkSelector));
        if (links.length) {
          return links
            .map((el) => {
              const title = el.textContent.trim();
              const href = el.getAttribute('href');
              if (!title || !href) return null;
              return { title, url: new URL(href, location.origin).href };
            })
            .filter(Boolean);
        }

        // 패턴 B: 피드형 (data-articleid + h2.view-title)
        const sections = Array.from(document.querySelectorAll(feedSectionSelector));
        if (sections.length) {
          // 현재 목록 페이지 경로(/ko-kr/board/free/list)에서 "/list"를 "/view"로 바꿔
          // 게시물 상세 URL 형식을 만든다.
          const viewPath = location.pathname.replace(/\/list\/?$/, '/view');
          return sections
            .map((sec) => {
              const articleId = sec.getAttribute('data-articleid');
              const titleEl = sec.querySelector(feedTitleSelector);
              const title = titleEl ? titleEl.textContent.trim() : '';
              if (!articleId || !title) return null;
              return {
                title,
                url: `${location.origin}${viewPath}?articleId=${articleId}`,
              };
            })
            .filter(Boolean);
        }

        return [];
      },
      {
        titleLinkSelector: TITLE_LINK_SELECTOR,
        feedSectionSelector: FEED_SECTION_SELECTOR,
        feedTitleSelector: FEED_TITLE_SELECTOR,
      }
    );

    return articles;
  } finally {
    await browser.close();
  }
}

module.exports = { fetchArticleList };

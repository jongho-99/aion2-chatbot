const puppeteer = require('puppeteer');

/**
 * CM아지트 목록 페이지를 렌더링해서 게시물 [{title, url, imageUrl}] 배열을 반환한다.
 *
 * 실제 목록 마크업 확인 결과:
 *   <li class="board-items" data-articleid="..." data-board="cm_story_ko">
 *     <div class="thumb"><a href="..."><img src="썸네일 URL" loading="lazy"></a></div>
 *     <div class="board">
 *       <div class="wrap-title"><a href="/ko-kr/board/cm_story/view?articleId=..." class="title">제목</a></div>
 *       ...
 *     </div>
 *   </li>
 * → 게시물 하나가 li.board-items 하나이고, 그 안에 제목 링크(a.title)와
 *   썸네일 이미지(.thumb img)가 같이 들어있다.
 *
 * 참고로 이 사이트(AION2-NC)는 자바스크립트로 목록을 그려주는 SPA라서,
 * 단순 fetch/axios + cheerio 로는 빈 페이지만 받아지고, 반드시 Puppeteer 같은
 * 헤드리스 브라우저로 "그려진 이후"의 DOM을 읽어야 한다.
 */

const LIST_ITEM_SELECTOR = 'li.board-items';
const TITLE_LINK_SELECTOR = 'a.title';
const THUMB_IMG_SELECTOR = '.thumb img';

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

    // SPA가 목록을 그릴 시간을 벌어준다. (필요시 늘리세요)
    await page.waitForSelector(LIST_ITEM_SELECTOR, { timeout: 15000 }).catch(() => null);
    await new Promise((r) => setTimeout(r, 1500));

    const articles = await page.evaluate(
      ({ itemSelector, titleSelector, thumbSelector }) => {
        const items = Array.from(document.querySelectorAll(itemSelector));
        return items
          .map((li) => {
            const titleEl = li.querySelector(titleSelector);
            if (!titleEl) return null;

            const title = titleEl.textContent.trim();
            const href = titleEl.getAttribute('href');
            if (!title || !href) return null;

            const imgEl = li.querySelector(thumbSelector);
            const imageUrl = imgEl ? imgEl.getAttribute('src') : null;

            return {
              title,
              url: href.startsWith('http') ? href : `https://aion2.plaync.com${href}`,
              imageUrl: imageUrl && imageUrl.startsWith('http') ? imageUrl : null,
            };
          })
          .filter(Boolean);
      },
      {
        itemSelector: LIST_ITEM_SELECTOR,
        titleSelector: TITLE_LINK_SELECTOR,
        thumbSelector: THUMB_IMG_SELECTOR,
      }
    );

    return articles;
  } finally {
    await browser.close();
  }
}

module.exports = { fetchArticleList };

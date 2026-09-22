# AION2 CM아지트 알림 봇

매주 화요일 19:00~21:00 사이, 1분 간격으로 CM아지트 게시판을 확인해서
이번 주차("N월 N주차") 업데이트 뉴스 글이 새로 올라오면 디스코드 채널에 알려주는 봇입니다.

---

## 0. 준비물

- Node.js 18 이상 (https://nodejs.org 에서 설치)
- 디스코드 계정 & 봇을 등록할 서버(길드)에 대한 관리 권한

---

## 1. 디스코드 봇 생성 & 토큰 발급

1. https://discord.com/developers/applications 접속 후 로그인
2. 오른쪽 위 **New Application** 클릭 → 이름 입력(예: `AION2 알림봇`) → Create
3. 왼쪽 메뉴에서 **Bot** 탭 클릭
4. **Reset Token** (처음이면 바로 토큰이 보이거나 "Reset Token" 버튼) 클릭 → 표시되는 토큰을 복사
   - ⚠️ 이 토큰은 이 화면을 벗어나면 다시 볼 수 없습니다(재발급은 가능). 외부에 절대 노출하지 마세요.
   - GitHub 같은 공개 저장소에 올리지 말 것 — `.env` 파일은 반드시 `.gitignore`에 포함
5. 같은 Bot 탭에서 아래 옵션은 이번 봇 용도(메시지 전송만)에는 **켤 필요 없습니다**:
   - Presence Intent / Server Members Intent / Message Content Intent → 모두 꺼둔 채로 진행 가능

---

## 2. 서버(길드)에 봇 초대하기

1. 왼쪽 메뉴 **OAuth2 → URL Generator** 이동
2. **SCOPES**에서 `bot` 체크
3. 아래에 나타나는 **BOT PERMISSIONS**에서 체크:
   - `Send Messages`
   - `Embed Links`
4. 하단에 생성된 URL을 복사해서 브라우저 주소창에 붙여넣기
5. 봇을 추가하고 싶은 디스코드 서버를 선택 → 권한 확인 → **승인(Authorize)**
6. 해당 서버 채널 목록에 봇이 (오프라인 상태로) 추가된 걸 확인

---

## 3. 알림 보낼 채널 ID 확인

1. 디스코드 앱에서 **설정 → 고급(Advanced) → 개발자 모드** 켜기
2. 알림을 받을 채널 우클릭 → **ID 복사**

---

## 4. 프로젝트 설정

```bash
cd aion2-cm-bot
npm install
cp env.example.txt .env
```

(다운로드받은 파일명이 `env.example.txt`인 이유는 점(`.`)으로 시작하는 파일이
다운로드 중 깨지는 경우가 있어서입니다. 위 명령대로 `.env`로 복사해서 쓰면 됩니다.)

`.env` 파일을 열어 아래 값을 채워 넣습니다.

```
DISCORD_TOKEN=1번 단계에서 복사한 봇 토큰
DISCORD_CHANNEL_ID=3번 단계에서 복사한 채널 ID
TARGET_URL=https://aion2.plaync.com/ko-kr/board/cm_story/list
```

---

## 5. ⚠️ 실행 전 반드시 할 일: 게시글 목록 선택자(selector) 확인

이 사이트는 자바스크립트로 목록을 그려주는 SPA라서, 저는 실제 게시물 목록이 어떤
HTML 구조(class명 등)로 렌더링되는지 직접 확인할 수 없었습니다. 그래서
`src/crawler.js`의 선택자는 추정값이 들어있습니다. 실행 전 아래처럼 한 번만
직접 확인해서 고쳐주세요.

1. 크롬으로 https://aion2.plaync.com/ko-kr/board/cm_story/list 접속
2. `F12` → **Elements** 탭
3. 게시물 목록에서 글 제목 하나를 마우스로 가리키고 우클릭 → **검사(Inspect)**
4. 제목을 감싸고 있는 `<a>` 태그(또는 `<li>` 태그)의 class 이름을 확인
5. `src/crawler.js` 안의 이 줄을 실제 값으로 교체:
   ```js
   const LIST_ITEM_SELECTOR = 'ul li a, .board-list li a, .list-item a'; // TODO: 실제 구조로 교체
   ```
   예를 들어 실제 구조가 `<a class="board-item__link">제목</a>` 라면:
   ```js
   const LIST_ITEM_SELECTOR = 'a.board-item__link';
   ```

**더 가벼운 방법(선택):** F12 → **Network** 탭 → XHR/Fetch 필터 → 페이지 새로고침 시
게시물 목록을 응답으로 주는 JSON API 요청이 보이면, 그 URL을 그대로
`axios`로 호출하도록 `crawler.js`를 바꾸면 Puppeteer(무거운 헤드리스 브라우저) 없이도
훨씬 빠르고 가볍게 동작합니다. API가 있다면 이 방식을 추천합니다.

---

## 6. 주차 계산 방식 검증

`src/weekUtil.js`는 "이번 달 들어 오늘이 몇 번째 화요일인가"로 N주차를 계산합니다.
최근 게시물 제목 몇 개(예: 9월 3주차 글의 실제 게시일)와 비교해서 이 계산 방식이
실제 NC소프트의 표기와 맞는지 꼭 확인하세요. 다르면 `weekUtil.js`의
`getWeekOfMonth` 함수만 수정하면 됩니다.

---

## 7. 실행

```bash
npm start
```

콘솔에 아래처럼 뜨면 정상 동작 중입니다.

```
로그인 완료: AION2알림봇#1234
스케줄 등록 완료: 매주 화요일 19:00~21:00, 1분 간격 체크
```

화요일 19:00~21:00 사이에는 1분마다 콘솔에 체크 로그가 찍히고,
이번 주차 제목의 글이 새로 올라오면 지정한 채널에 임베드 메시지로 알려줍니다.
같은 글에 대해 중복 알림은 보내지 않습니다(`state.json`에 기록 저장).

---

## 7-1. 화요일 저녁 전에 지금 바로 테스트해보기

CM아지트는 화요일 저녁에만 올라오니 바로 테스트하기 어렵습니다. 대신 글이 자주 올라오는
**자유게시판**을 감시하는 테스트 스크립트를 따로 만들어뒀습니다. 요일/시간 제한 없이
20초마다 체크하고, "새 글이 생기면 무조건" 알림을 보냅니다(주차 매칭 로직 없음).

```bash
npm run test:watch
```

동작 방식:
1. 처음 실행하면 현재 자유게시판에 있는 글들을 "기준선"으로만 저장합니다(알림 없음).
   콘솔에 `[초기화] 현재 게시물 N개를 기준선으로 저장했습니다.` 가 뜨면 준비 완료.
2. 그 상태로 켜두고, 실제로 자유게시판에 새 글을 하나 올려보세요(본인 계정으로 테스트 글 작성 가능).
3. 다음 체크 주기(최대 20초 이내)에 디스코드 채널에 알림이 오는지 확인합니다.

테스트를 다시 처음부터 하고 싶으면(기준선 초기화) 아래처럼 `state.json`을 지우고 재실행하세요.

```bash
rm -f state.json
npm run test:watch
```

⚠️ `state.json`은 운영 봇(`npm start`)과 테스트 스크립트가 같이 공유합니다. 다만 CM아지트
글과 자유게시판 글은 URL(articleId)이 달라서 서로 알림 여부에 영향을 주지 않으니
안심하고 같이 써도 됩니다.

동작이 확인되면 `TARGET_URL`을 다시 CM아지트 주소로 쓰는 `npm start`(운영 봇)로 넘어가면 됩니다.

---

## 8. 24시간 상시 구동하기 (선택)

로컬 PC를 계속 켜둘 수 없다면, 아래 중 하나를 사용하세요.

- **PM2** (가장 간단, 같은 서버에서 백그라운드 실행 + 자동 재시작)
  ```bash
  npm install -g pm2
  pm2 start src/index.js --name aion2-bot
  pm2 save
  pm2 startup   # 서버 재부팅 시 자동 시작 설정
  ```
- **클라우드 소형 서버**: Oracle Cloud 무료 티어, 가벼운 VPS 등에 올려서 PM2로 구동
- Puppeteer는 Chromium을 함께 설치하므로, 리눅스 서버에서는 아래 패키지가 추가로 필요할 수 있습니다.
  ```bash
  sudo apt-get install -y libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1
  ```

---

## 파일 구성

```
aion2-cm-bot/
├── package.json
├── env.example.txt      # 복사해서 .env로 사용
├── state.json           # 실행 시 자동 생성됨 (중복 알림 방지용)
└── src/
    ├── index.js          # 봇 진입점 + 스케줄러
    ├── testWatcher.js     # 자유게시판 즉시 테스트용 (요일/시간 제한 없음)
    ├── crawler.js         # Puppeteer 크롤러
    ├── weekUtil.js        # "N월 N주차" 계산/매칭
    └── state.js           # 알림 중복 방지 저장소
```

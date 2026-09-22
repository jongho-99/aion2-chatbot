require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const cron = require('node-cron');

const { fetchArticleList } = require('./crawler');
const { alreadyNotified, markNotified, isBoardSeeded, markBoardSeeded } = require('./state');

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const TARGET_URL = process.env.TARGET_URL || 'https://aion2.plaync.com/ko-kr/board/cm_story/list';
const BOARD_KEY = 'cm_story'; // state.json에 기준선 초기화 여부를 구분해서 저장하기 위한 키

if (!TOKEN || !CHANNEL_ID) {
  console.error('DISCORD_TOKEN 과 DISCORD_CHANNEL_ID 를 .env 파일에 설정해주세요.');
  process.exit(1);
}

// 이 봇은 메시지를 "보내기만" 하므로 별도 privileged intent(Message Content 등)는 필요 없다.
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// 이전 크롤링이 아직 끝나지 않았으면 다음 30초 틱을 건너뛰기 위한 플래그.
// (Puppeteer 크롤링이 30초보다 오래 걸릴 경우 크롬이 여러 개 겹쳐 뜨는 것을 방지)
let isChecking = false;

async function checkAndNotify() {
  if (isChecking) {
    console.log('  이전 체크가 아직 진행 중이라 이번 틱은 건너뜁니다.');
    return;
  }
  isChecking = true;

  try {
    const now = new Date();
    console.log(`[${now.toLocaleString('ko-KR')}] 체크 중...`);

    let articles;
    try {
      articles = await fetchArticleList(TARGET_URL);
    } catch (err) {
      console.error('크롤링 실패:', err.message);
      return;
    }

    if (!articles.length) {
      console.log('  게시물을 하나도 못 읽어왔습니다. (선택자 확인 필요)');
      return;
    }

    // 봇을 처음 켠 시점: 지금 있는 글들은 전부 "이미 있던 글"로 기준선만 잡고,
    // 알림은 보내지 않는다. 이 상태는 state.json에 영구 기록되므로 재시작해도
    // 다시 초기화되지 않는다 (과거 글을 뒤늦게 우르르 알림 보내는 걸 방지).
    if (!isBoardSeeded(BOARD_KEY)) {
      articles.forEach((a) => markNotified(a.url));
      markBoardSeeded(BOARD_KEY);
      console.log(`  [초기화] 현재 게시물 ${articles.length}개를 기준선으로 저장했습니다.`);
      return;
    }

    // 목록 맨 위(최신)부터 나열되므로, 아직 안 알린 글들만 골라서
    // 오래된 순으로 뒤집어 올린 순서대로 알림을 보낸다.
    const newOnes = articles.filter((a) => !alreadyNotified(a.url)).reverse();

    if (!newOnes.length) {
      console.log('  새 글 없음.');
      return;
    }

    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) {
      console.error('채널을 찾을 수 없습니다. DISCORD_CHANNEL_ID 확인 필요.');
      return;
    }

    for (const a of newOnes) {
      const embed = new EmbedBuilder()
        .setTitle('📢 CM아지트에 새 글이 올라왔어요!')
        .setDescription(`**[${a.title}](${a.url})**`)
        .setURL(a.url)
        .setColor(0x00aaff)
        .setTimestamp(now);

      // 크롤링한 게시물에 썸네일 이미지가 있으면 임베드에 큰 이미지로 붙인다.
      if (a.imageUrl) {
        embed.setImage(a.imageUrl);
      }

      await channel.send({ embeds: [embed] });
      markNotified(a.url);
      console.log('  알림 전송 완료:', a.title);
    }
  } finally {
    isChecking = false;
  }
}

client.once('ready', () => {
  console.log(`로그인 완료: ${client.user.tag}`);

  // 매주 화요일, 19:00~21:00 사이에 30초 간격으로 실행
  // cron 필드(6개짜리, 맨 앞이 초): 초 분 시 일 월 요일 (요일 2 = 화요일)
  cron.schedule(
    '*/30 * 19-21 * * 2',
    () => {
      const minute = new Date().getMinutes();
      const hour = new Date().getHours();
      // 21시는 정각(21:00)까지만 체크하고 그 이후는 건너뛴다
      if (hour === 21 && minute > 0) return;
      checkAndNotify();
    },
    { timezone: 'Asia/Seoul' }
  );

  console.log('스케줄 등록 완료: 매주 화요일 19:00~21:00, 30초 간격 체크');
});

client.login(TOKEN);

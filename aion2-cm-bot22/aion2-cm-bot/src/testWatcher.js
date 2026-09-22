require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

const { fetchArticleList } = require('./crawler_free');
const { alreadyNotified, markNotified } = require('./state');

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const FREE_BOARD_URL =
  process.env.TEST_TARGET_URL || 'https://aion2.plaync.com/ko-kr/board/free/list';

const POLL_INTERVAL_MS = 20 * 1000; // 테스트용이라 20초마다 체크 (운영 봇은 1분 간격)

if (!TOKEN || !CHANNEL_ID) {
  console.error('DISCORD_TOKEN 과 DISCORD_CHANNEL_ID 를 .env 파일에 설정해주세요.');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let initialized = false; // 처음 실행 시 "이미 있던 글"은 알림 없이 기준선만 잡는다

async function poll(channel) {
  let articles;
  try {
    articles = await fetchArticleList(FREE_BOARD_URL);
  } catch (err) {
    console.error('크롤링 실패:', err.message);
    return;
  }

  if (!articles.length) {
    console.log('게시물을 하나도 못 읽어왔습니다. 선택자(LIST_ITEM_SELECTOR)를 다시 확인해보세요.');
    return;
  }

  if (!initialized) {
    articles.forEach((a) => {
      if (!alreadyNotified(a.url)) markNotified(a.url);
    });
    initialized = true;
    console.log(`[초기화] 현재 게시물 ${articles.length}개를 기준선으로 저장했습니다.`);
    console.log('  이제부터 이 목록에 없던 "새 글"이 생기면 알림을 보냅니다.');
    return;
  }

  // 목록 맨 위(최신)부터 나열되므로, 아직 안 알린 글들만 골라서
  // 오래된 순으로 뒤집어 올린 순서대로 알림을 보낸다.
  const newOnes = articles.filter((a) => !alreadyNotified(a.url)).reverse();

  if (!newOnes.length) {
    console.log(`[${new Date().toLocaleTimeString('ko-KR')}] 새 글 없음.`);
    return;
  }

  for (const a of newOnes) {
    const embed = new EmbedBuilder()
      .setTitle('🆕 자유게시판에 새 글이 올라왔어요! (테스트)')
      .setDescription(`**${a.title}**`)
      .setURL(a.url)
      .setColor(0x33cc66)
      .setTimestamp(new Date());

    await channel.send({ embeds: [embed] });
    markNotified(a.url);
    console.log('  알림 전송:', a.title);
  }
}

client.once('ready', async () => {
  console.log(`로그인 완료: ${client.user.tag}`);
  console.log(`테스트 대상: ${FREE_BOARD_URL}`);
  console.log(`${POLL_INTERVAL_MS / 1000}초마다 체크합니다. (Ctrl+C 로 종료)`);

  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel) {
    console.error('채널을 찾을 수 없습니다. DISCORD_CHANNEL_ID 확인 필요.');
    process.exit(1);
  }

  await poll(channel); // 기준선 저장
  setInterval(() => poll(channel), POLL_INTERVAL_MS);
});

client.login(TOKEN);

/**
 * 슬래시 명령어를 디스코드에 등록하는 스크립트. 명령어 정의가 바뀔 때만 한 번 실행하면 됨.
 *   npm run deploy:commands
 * 길드(서버) 단위로 등록하므로 즉시 반영됨.
 */
require('dotenv').config();
const { REST, Routes } = require('discord.js');
const characterCommand = require('./characterCommand');

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !DISCORD_GUILD_ID) {
  console.error('.env 에 DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID 를 설정해주세요.');
  process.exit(1);
}

const rest = new REST().setToken(DISCORD_TOKEN);

(async () => {
  const body = [characterCommand.data.toJSON()];
  await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), { body });
  console.log(`슬래시 명령어 ${body.length}개 등록 완료: ${body.map((c) => '/' + c.name).join(', ')}`);
})().catch((err) => {
  console.error('등록 실패:', err);
  process.exit(1);
});

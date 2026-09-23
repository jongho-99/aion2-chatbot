const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { searchCharacter, SearchError } = require('./characterSearch');

const OPTION_NAME = '캐릭터';

const data = new SlashCommandBuilder()
  .setName('캐릭터검색')
  .setDescription('aion2tool.com에서 아이온2 캐릭터 정보를 검색합니다')
  .addStringOption((o) =>
    o.setName(OPTION_NAME).setDescription('캐릭터명[서버명]  예) 강아징[티아마트]').setRequired(true)
  );

/** '강아징[티아마트]' / '강아징 [티아]' → { nickname, server } */
function parseQuery(raw) {
  const m = String(raw).trim().match(/^(.+?)\s*\[\s*(.+?)\s*\]$/);
  if (!m) return null;
  return { nickname: m[1].trim(), server: m[2].trim() };
}

const SET_ICON = { 군단장: '🟠', 천부장: '🟣', 백부장: '🔵' };
function setLine(s) {
  const icon = Object.entries(SET_ICON).find(([k]) => s.name.includes(k))?.[1] || '⚪';
  return `${icon} **${s.name}**  —  \`${s.pieces}피스 보유 · ${s.active}세트 활성\``;
}

/** '+20 빛나는 창룡왕의 단검 [돌파 +5]' 처럼 한 줄로 (돌파가 0이면 괄호 생략) */
function itemLine(item) {
  if (!item) return '정보 없음';
  return `**${item.name}**${item.exceed ? ` [돌파 +${item.exceed}]` : ''}`;
}

const REFRESH_TEXT = {
  done: '✅ 최신 정보로 갱신됨',
  cooldown: '⏳ 최근에 갱신된 정보',
  notfound: '⚠️ 갱신 버튼을 찾지 못해 기존 정보로 표시',
  timeout: '⚠️ 갱신이 오래 걸려 기존 정보로 표시',
};

function buildReply(r) {
  const color = r.server.race === '1' ? 0x5eb3f6 : 0xff5757;
  const embeds = [];

  // 캐릭터 요약 + 무기/가더 이름 + 세트 효과 (임베드 1개)
  const main = new EmbedBuilder()
    .setTitle(`${r.nickname}  ·  ${r.server.name} (${r.server.raceName})`)
    .setURL(r.url)
    .setColor(color)
    .setFooter({
      text: ['aion2tool.com', r.fromCache ? '📦 최근 조회 결과' : REFRESH_TEXT[r.refresh]].filter(Boolean).join(' · '),
    })
    .setTimestamp(new Date());
  if (r.image) main.setThumbnail(r.image);

  const fields = Object.entries(r.stats).map(([name, value]) => ({ name, value, inline: true }));
  fields.push(
    { name: '🗡️ 무기', value: itemLine(r.weapon), inline: false },
    { name: '🛡️ 가더', value: itemLine(r.guarder), inline: false },
    ...(r.seals || []).map((seal, i) => ({ name: `🔖 인장 ${i + 1}`, value: itemLine(seal), inline: false })),
    {
      name: '✨ 세트 효과',
      value: r.sets.length ? r.sets.map(setLine).join('\n') : '활성화된 세트 없음',
      inline: false,
    }
  );
  main.addFields(fields);
  embeds.push(main);

  return { embeds };
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ allowedChannelId?: string }} opts
 */
async function execute(interaction, { allowedChannelId } = {}) {
  if (allowedChannelId && interaction.channelId !== allowedChannelId) {
    return interaction.reply({
      content: `이 명령어는 <#${allowedChannelId}> 채널에서만 사용할 수 있어요.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const parsed = parseQuery(interaction.options.getString(OPTION_NAME, true));
  if (!parsed) {
    return interaction.reply({
      content: '형식이 올바르지 않아요. `캐릭터명[서버명]` 형식으로 입력해주세요.  예) `강아징[티아마트]`',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply(); // 크롤링이 3초를 넘기므로 먼저 "생각 중..." 표시

  // ── 진행 상황을 같은 메시지에 계속 덮어써서 보여준다 ──
  // 단계 문구 뒤의 점이  .  →  ..  →  ...  으로 계속 바뀌어서 진행 중인 게 보이게 함
  const who = `**${parsed.nickname}** [${parsed.server}]`;
  const STAGE_TEXT = {
    queued: `⏳ 다른 검색이 진행 중이에요. 잠시만 기다려주세요`,
    search: `🔍 ${who} 캐릭터를 검색하는 중 (1/4)`,
    detail: `📄 ${who} 상세 정보를 불러오는 중 (2/4)`,
    refresh: `🔄 ${who} 최신 정보로 갱신하는 중 (3/4)`,
    collect: `📝 ${who} 장비·세트 정보를 정리하는 중 (4/4)`,
  };
  const DOTS = ['.', '..', '...'];
  const DOT_INTERVAL_MS = 1200; // 너무 짧으면 디스코드 수정 횟수 제한에 걸릴 수 있음

  let stageText = null;
  let dotIdx = 0;
  let stopped = false;
  let inFlight = 0; // 아직 끝나지 않은 메시지 수정 개수
  let editChain = Promise.resolve();

  // 메시지 수정은 순서대로 한 번에 하나씩
  const pushEdit = (content) => {
    inFlight++;
    editChain = editChain
      .then(() => (stopped ? null : interaction.editReply({ content })))
      .catch(() => {})
      .finally(() => { inFlight--; });
  };
  const render = () => {
    if (!stageText || stopped) return;
    pushEdit(`${stageText}${DOTS[dotIdx % DOTS.length]}`);
    dotIdx++;
  };
  // 단계가 바뀌면 즉시 표시 (점은 . 부터 다시)
  const showProgress = (stage) => {
    if (!STAGE_TEXT[stage]) return;
    stageText = STAGE_TEXT[stage];
    dotIdx = 0;
    render();
  };
  // 점 애니메이션: 앞 수정이 아직 안 끝났으면 이번 틱은 건너뜀 (수정이 밀려 쌓이지 않게)
  const timer = setInterval(() => { if (inFlight === 0) render(); }, DOT_INTERVAL_MS);

  const finish = async () => {
    stopped = true;
    clearInterval(timer);
    await editChain; // 진행 중인 수정이 끝난 뒤에 최종 메시지로 교체
  };

  try {
    const result = await searchCharacter(parsed.nickname, parsed.server, { onProgress: showProgress });
    await finish();
    await interaction.editReply({ content: '', ...buildReply(result) });
  } catch (err) {
    await finish();
    if (!(err instanceof SearchError)) console.error('[캐릭터검색] 오류:', err);
    const msg = err instanceof SearchError ? err.message : '검색 중 오류가 발생했어요. 잠시 후 다시 시도해주세요.';
    await interaction.editReply({ content: `❌ ${msg}`, embeds: [], files: [] });
  }
}

module.exports = { data, execute, parseQuery, buildReply };

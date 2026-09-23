/**
 * aion2tool.com 검색창의 <select id="server-select"> 옵션을 그대로 옮긴 서버 목록.
 *  - 1xxx = 천족(race=1), 2xxx = 마족(race=2)
 *  - 서버가 추가되면 여기에 한 줄 추가하면 됨
 */
const SERVERS = {
  // 천족
  시엘: 1001, 네자칸: 1002, 바이젤: 1003, 카이시넬: 1004, 유스티엘: 1005,
  아리엘: 1006, 프레기온: 1007, 메스람타에다: 1008, 히타니에: 1009, 나니아: 1010,
  타하바타: 1011, 루터스: 1012, 페르노스: 1013, 다미누: 1014, 카사카: 1015,
  바카르마: 1016, 챈가룽: 1017, 코치룽: 1018, 이슈타르: 1019, 티아마트: 1020,
  포에타: 1021,
  // 마족
  이스라펠: 2001, 지켈: 2002, 트리니엘: 2003, 루미엘: 2004, 마르쿠탄: 2005,
  아스펠: 2006, 에레슈키갈: 2007, 브리트라: 2008, 네몬: 2009, 하달: 2010,
  루드라: 2011, 울고른: 2012, 무닌: 2013, 오다르: 2014, 젠카카: 2015,
  크로메데: 2016, 콰이링: 2017, 바바룽: 2018, 파프니르: 2019, 인드나흐: 2020,
  이스할겐: 2021,
};

// 사이트의 [줄임말](앞 두 글자)도 받아준다. 단, '이스'처럼 두 서버가 겹치는 줄임말은 제외.
const ABBR = {};
const abbrCount = {};
for (const name of Object.keys(SERVERS)) {
  const a = name.slice(0, 2);
  abbrCount[a] = (abbrCount[a] || 0) + 1;
}
for (const name of Object.keys(SERVERS)) {
  const a = name.slice(0, 2);
  if (abbrCount[a] === 1 && a !== name) ABBR[a] = name;
}

/** '티아마트' 또는 '티아' → { id: '1020', name: '티아마트', race: '1', raceName: '천족' } / 없으면 null */
function resolveServer(input) {
  const key = String(input || '').replace(/\s+/g, '');
  const name = SERVERS[key] ? key : ABBR[key];
  if (!name) return null;
  const id = String(SERVERS[name]);
  const race = id[0];
  return { id, name, race, raceName: race === '1' ? '천족' : '마족' };
}

module.exports = { SERVERS, resolveServer };

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'state.json');

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    return {
      notifiedUrls: raw.notifiedUrls || [],
      seededBoards: raw.seededBoards || [],
    };
  } catch {
    return { notifiedUrls: [], seededBoards: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

function alreadyNotified(url) {
  const state = loadState();
  return state.notifiedUrls.includes(url);
}

function markNotified(url) {
  const state = loadState();
  if (!state.notifiedUrls.includes(url)) {
    state.notifiedUrls.push(url);
  }
  // 오래된 기록이 무한히 쌓이지 않도록 최근 200개만 유지
  state.notifiedUrls = state.notifiedUrls.slice(-200);
  saveState(state);
}

// 특정 게시판(boardKey)을 한 번이라도 "기준선 초기화" 했는지 여부.
// 재시작해도 유지되도록 state.json에 영구 기록한다.
function isBoardSeeded(boardKey) {
  const state = loadState();
  return state.seededBoards.includes(boardKey);
}

function markBoardSeeded(boardKey) {
  const state = loadState();
  if (!state.seededBoards.includes(boardKey)) {
    state.seededBoards.push(boardKey);
  }
  saveState(state);
}

module.exports = {
  alreadyNotified,
  markNotified,
  isBoardSeeded,
  markBoardSeeded,
};

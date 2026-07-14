const AppwriteSDK = window.Appwrite;

if (!AppwriteSDK) {
  throw new Error("Appwrite SDK를 불러오지 못했어. 인터넷 연결을 확인하고 다시 불러와줘.");
}

const {
  Channel,
  Client,
  ID,
  Query,
  Realtime,
  Storage,
  TablesDB,
} = AppwriteSDK;

if (!Client || !TablesDB || !Storage || !ID || !Query) {
  throw new Error("Appwrite SDK 구성요소를 불러오지 못했어. 페이지를 새로고침해줘.");
}

const CONFIG = Object.freeze({
  endpoint: "https://sgp.cloud.appwrite.io/v1",
  projectId: "6a54f05f000bc614cd40",
  databaseId: "travel-budget",
  tables: {
    trips: "trips",
    participants: "participants",
    expenses: "expenses",
  },
  bucketId: "receipts",
  tripRowId: "main-trip",
});

const ME_KEY = "travel-budget-me-id-v2";
const POLL_INTERVAL_MS = 30000;

const CATEGORIES = [
  { id: "food", label: "식비", icon: "🍽️" },
  { id: "cafe", label: "카페", icon: "☕" },
  { id: "stay", label: "숙박", icon: "🏠" },
  { id: "transport", label: "교통", icon: "🚕" },
  { id: "shopping", label: "장보기", icon: "🛒" },
  { id: "activity", label: "놀거리", icon: "🎲" },
  { id: "etc", label: "기타", icon: "🧾" },
];

const client = new Client()
  .setEndpoint(CONFIG.endpoint)
  .setProject(CONFIG.projectId);

const tablesDB = new TablesDB(client);
const storage = new Storage(client);
const realtime = Realtime ? new Realtime(client) : null;

let state = {
  trip: { id: CONFIG.tripRowId, name: "", start: "", end: "" },
  participants: [],
  expenses: [],
};

let pendingReceiptFile = null;
let pendingReceiptUrl = "";
let existingReceiptId = "";
let removeExistingReceipt = false;
let toastTimer = null;
let refreshTimer = null;
let realtimeSubscription = null;
let refreshQueued = false;
let currentRequestCount = 0;

function $(selector, root = document) {
  return root.querySelector(selector);
}

function $$(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

function formatWon(value) {
  return `${Math.round(Number(value) || 0).toLocaleString("ko-KR")}원`;
}

function formatDate(dateString) {
  if (!dateString) return "날짜 없음";
  const [year, month, day] = dateString.split("-");
  return year && month && day ? `${Number(month)}/${Number(day)}` : dateString;
}

function todayString() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function parseMoneyInput(value) {
  return Number(String(value ?? "").replace(/[^\d]/g, "")) || 0;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function categoryInfo(id) {
  return CATEGORIES.find((category) => category.id === id) || CATEGORIES.at(-1);
}

function participantName(id) {
  return state.participants.find((participant) => participant.id === id)?.name || "알 수 없음";
}

function getMeId() {
  const saved = localStorage.getItem(ME_KEY) || "";
  return state.participants.some((participant) => participant.id === saved) ? saved : "";
}

function setMeId(id) {
  if (id) localStorage.setItem(ME_KEY, id);
  else localStorage.removeItem(ME_KEY);
}

function setSyncStatus(text, status = "") {
  const element = $("#syncStatus");
  element.textContent = text;
  element.className = `sync-status${status ? ` ${status}` : ""}`;
}

function showLoading(message = "처리하는 중…") {
  currentRequestCount += 1;
  $("#loadingText").textContent = message;
  $("#loadingOverlay").classList.remove("hidden");
}

function hideLoading() {
  currentRequestCount = Math.max(0, currentRequestCount - 1);
  if (currentRequestCount === 0) {
    $("#loadingOverlay").classList.add("hidden");
  }
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 1900);
}

function readableError(error) {
  const raw = String(error?.message || error || "알 수 없는 오류");
  const code = Number(error?.code || error?.response?.code || 0);
  const type = String(error?.type || error?.response?.type || "");

  if (code === 401 || code === 403 || type.includes("unauthorized")) {
    return "Appwrite 권한 설정을 확인해줘. 세 테이블과 영수증 버킷에서 Any 역할에 Create·Read·Update·Delete가 모두 필요해.";
  }
  if (type.includes("column_unknown") || type.includes("row_invalid_structure")) {
    return "Appwrite 테이블 열 이름을 확인해줘. trips에는 name/startDate/endDate, participants에는 name, expenses에는 dataJson이 필요해.";
  }
  if (code === 404) {
    return "Appwrite 프로젝트·데이터베이스·테이블 또는 영수증 버킷 ID를 찾지 못했어. 설정값을 확인해줘.";
  }
  if (raw.includes("Failed to fetch") || raw.includes("NetworkError")) {
    return "Appwrite 연결이 차단됐어. Web platform의 Hostname이 26071617-hapjeong-trip.vercel.app인지 확인해줘.";
  }
  return raw;
}

function safeJsonParse(value, fallback = {}) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function receiptViewUrl(fileId) {
  if (!fileId) return "";
  return `${CONFIG.endpoint}/storage/buckets/${encodeURIComponent(CONFIG.bucketId)}/files/${encodeURIComponent(fileId)}/view?project=${encodeURIComponent(CONFIG.projectId)}`;
}

async function fetchTrip() {
  try {
    const row = await tablesDB.getRow({
      databaseId: CONFIG.databaseId,
      tableId: CONFIG.tables.trips,
      rowId: CONFIG.tripRowId,
    });
    return {
      id: row.$id,
      name: String(row.name || ""),
      start: String(row.startDate || ""),
      end: String(row.endDate || ""),
    };
  } catch (error) {
    if (Number(error?.code) === 404) {
      return { id: CONFIG.tripRowId, name: "", start: "", end: "" };
    }
    throw error;
  }
}

async function fetchParticipants() {
  const result = await tablesDB.listRows({
    databaseId: CONFIG.databaseId,
    tableId: CONFIG.tables.participants,
    queries: [Query.limit(100)],
    total: false,
    ttl: 0,
  });

  return (result.rows || [])
    .map((row) => ({
      id: row.$id,
      name: String(row.name || "").trim(),
      createdAt: row.$createdAt,
    }))
    .filter((participant) => participant.name)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

async function fetchExpenses() {
  const result = await tablesDB.listRows({
    databaseId: CONFIG.databaseId,
    tableId: CONFIG.tables.expenses,
    queries: [Query.limit(100)],
    total: false,
    ttl: 0,
  });

  return (result.rows || [])
    .map((row) => {
      const data = safeJsonParse(row.dataJson, {});
      return {
        id: row.$id,
        title: String(data.title || ""),
        amount: Number(data.amount || 0),
        date: String(data.date || ""),
        category: String(data.category || "etc"),
        payerId: String(data.payerId || ""),
        splitMode: data.splitMode === "custom" ? "custom" : "equal",
        splits: Array.isArray(data.splits)
          ? data.splits.map((split) => ({
              participantId: String(split.participantId || ""),
              amount: Number(split.amount || 0),
            }))
          : [],
        memo: String(data.memo || ""),
        receiptFileId: String(data.receiptFileId || ""),
        createdAt: Number(data.createdAt || new Date(row.$createdAt).getTime() || 0),
        updatedAt: Number(data.updatedAt || new Date(row.$updatedAt).getTime() || 0),
      };
    })
    .filter((expense) => expense.title && expense.amount > 0)
    .sort((a, b) => {
      const dateCompare = String(b.date).localeCompare(String(a.date));
      return dateCompare || b.createdAt - a.createdAt;
    });
}

function isEditingNow() {
  const addViewActive = $('.view[data-view="add"]')?.classList.contains("active");
  return Boolean(
    addViewActive ||
    $("#settingsDialog")?.open ||
    $("#expenseDetailDialog")?.open
  );
}

async function loadSharedData({ silent = false, force = false } = {}) {
  if (!force && silent && isEditingNow()) {
    refreshQueued = true;
    setSyncStatus("변경 대기", "syncing");
    return;
  }

  if (!silent) showLoading("공동 장부 불러오는 중…");
  setSyncStatus("동기화 중", "syncing");

  try {
    const dataRequest = Promise.all([
      fetchTrip(),
      fetchParticipants(),
      fetchExpenses(),
    ]);

    const timeoutRequest = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(
        "Appwrite 응답이 늦어지고 있어. Web platform 주소와 테이블 권한을 확인해줘."
      )), 15000);
    });

    const [trip, participants, expenses] = await Promise.race([
      dataRequest,
      timeoutRequest,
    ]);

    state = { trip, participants, expenses };

    if (getMeId() && !participants.some((participant) => participant.id === getMeId())) {
      setMeId("");
    }

    renderAll();
    setSyncStatus("최신", "success");
    refreshQueued = false;

    if (!state.trip.name && !$("#settingsDialog").open) {
      renderSettingsValues();
      $("#settingsDialog").showModal();
    }
  } catch (error) {
    console.error(error);
    const message = readableError(error);
    setSyncStatus("연결 오류", "error");
    if (!silent) alert(message);
    else showToast(message);
  } finally {
    if (!silent) hideLoading();
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => loadSharedData({ silent: true }), 450);
}

async function setupRealtime() {
  if (!realtime || !Channel) return;
  try {
    realtimeSubscription = await realtime.subscribe(
      [
        Channel.tablesdb(CONFIG.databaseId).table(CONFIG.tables.trips).row(),
        Channel.tablesdb(CONFIG.databaseId).table(CONFIG.tables.participants).row(),
        Channel.tablesdb(CONFIG.databaseId).table(CONFIG.tables.expenses).row(),
        Channel.bucket(CONFIG.bucketId).file(),
      ],
      () => scheduleRefresh(),
    );
  } catch (error) {
    console.warn("Realtime connection unavailable; polling remains active.", error);
  }
}

function navigate(viewName) {
  $$(".view").forEach((view) => {
    view.classList.toggle("active", view.dataset.view === viewName);
  });
  $$(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.go === viewName);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });

  if (viewName === "add" && !$("#editingExpenseId").value) {
    resetExpenseForm();
  }

  if (viewName !== "add" && refreshQueued) {
    loadSharedData({ silent: true, force: true });
  }

  renderAll();
}

function equalSplits(amount, participantIds) {
  if (!participantIds.length) return [];
  const base = Math.floor(amount / participantIds.length);
  let remainder = amount - base * participantIds.length;

  return participantIds.map((participantId) => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    return { participantId, amount: base + extra };
  });
}

function calculateSummary() {
  const summary = Object.fromEntries(
    state.participants.map((participant) => [
      participant.id,
      {
        id: participant.id,
        name: participant.name,
        paid: 0,
        owed: 0,
        balance: 0,
      },
    ]),
  );

  for (const expense of state.expenses) {
    if (summary[expense.payerId]) {
      summary[expense.payerId].paid += expense.amount;
    }
    for (const split of expense.splits || []) {
      if (summary[split.participantId]) {
        summary[split.participantId].owed += split.amount;
      }
    }
  }

  Object.values(summary).forEach((person) => {
    person.balance = person.paid - person.owed;
  });

  return Object.values(summary);
}

function calculateTransfers(summary) {
  const creditors = summary
    .filter((person) => person.balance > 0.5)
    .map((person) => ({ ...person, remaining: person.balance }))
    .sort((a, b) => b.remaining - a.remaining);

  const debtors = summary
    .filter((person) => person.balance < -0.5)
    .map((person) => ({ ...person, remaining: -person.balance }))
    .sort((a, b) => b.remaining - a.remaining);

  const transfers = [];
  let debtorIndex = 0;
  let creditorIndex = 0;

  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const amount = Math.min(
      debtors[debtorIndex].remaining,
      creditors[creditorIndex].remaining,
    );

    if (amount > 0.5) {
      transfers.push({
        fromId: debtors[debtorIndex].id,
        toId: creditors[creditorIndex].id,
        amount: Math.round(amount),
      });
    }

    debtors[debtorIndex].remaining -= amount;
    creditors[creditorIndex].remaining -= amount;

    if (debtors[debtorIndex].remaining < 0.5) debtorIndex += 1;
    if (creditors[creditorIndex].remaining < 0.5) creditorIndex += 1;
  }

  return transfers;
}

function renderCategoryOptions() {
  const options = CATEGORIES.map(
    (category) => `<option value="${category.id}">${category.icon} ${category.label}</option>`,
  ).join("");

  $("#expenseCategory").innerHTML = options;
  $("#categoryFilter").innerHTML = `<option value="">모든 카테고리</option>${options}`;
}

function renderHeader() {
  $("#headerTripName").textContent = state.trip.name || "여행 가계부";
  $("#memberCount").textContent = `${state.participants.length}명`;

  let period = "여행 정보를 설정해줘";
  if (state.trip.start && state.trip.end) {
    period = `${state.trip.start.replaceAll("-", ".")} ~ ${state.trip.end.replaceAll("-", ".")}`;
  } else if (state.trip.start) {
    period = `${state.trip.start.replaceAll("-", ".")} 출발`;
  }
  $("#homePeriod").textContent = period;
}

function expenseCardHtml(expense) {
  const category = categoryInfo(expense.category);
  return `
    <button class="expense-item" data-expense-id="${expense.id}" type="button">
      <span class="category-icon">${category.icon}</span>
      <span class="expense-main">
        <strong>${escapeHtml(expense.title)}</strong>
        <span>${formatDate(expense.date)} · ${escapeHtml(participantName(expense.payerId))} 결제 · ${expense.splits.length}명</span>
      </span>
      <span class="expense-amount">
        <strong>${formatWon(expense.amount)}</strong>
        <span>${category.label}</span>
      </span>
    </button>
  `;
}

function renderHome() {
  const total = state.expenses.reduce((sum, expense) => sum + expense.amount, 0);
  const summary = calculateSummary();
  const me = summary.find((person) => person.id === getMeId());

  $("#homeTotal").textContent = formatWon(total);
  $("#myPaid").textContent = formatWon(me?.paid || 0);
  $("#myOwed").textContent = formatWon(me?.owed || 0);

  if (!me) {
    $("#myBalanceLabel").textContent = "내 정산 상태";
    $("#myBalance").textContent = state.participants.length
      ? "설정에서 내 이름을 선택해줘"
      : "참여자를 먼저 추가해줘";
    $("#myBalance").className = "";
  } else {
    const balance = me.balance;
    $("#myBalanceLabel").textContent = balance >= 0 ? "내가 받을 돈" : "내가 보낼 돈";
    $("#myBalance").textContent = formatWon(Math.abs(balance));
    $("#myBalance").className = balance > 0
      ? "balance-positive"
      : balance < 0
        ? "balance-negative"
        : "";
  }

  const recent = state.expenses.slice(0, 4);
  $("#recentExpenses").innerHTML = recent.map(expenseCardHtml).join("");
  $("#homeEmpty").classList.toggle("hidden", state.expenses.length > 0);
  $("#recentExpenses").classList.toggle("hidden", state.expenses.length === 0);
}

function renderExpenses() {
  const query = $("#expenseSearch").value.trim().toLowerCase();
  const category = $("#categoryFilter").value;
  const payer = $("#payerFilter").value;

  const filtered = state.expenses
    .filter((expense) => !query || `${expense.title} ${expense.memo}`.toLowerCase().includes(query))
    .filter((expense) => !category || expense.category === category)
    .filter((expense) => !payer || expense.payerId === payer);

  $("#expenseList").innerHTML = filtered.map(expenseCardHtml).join("");
  $("#expenseEmpty").classList.toggle("hidden", filtered.length > 0);
}

function renderSettlement() {
  const total = state.expenses.reduce((sum, expense) => sum + expense.amount, 0);
  const summary = calculateSummary();
  const transfers = calculateTransfers(summary);

  $("#settlementTotal").textContent = formatWon(total);
  $("#settlementSub").textContent = state.expenses.length
    ? `${state.expenses.length}건의 지출을 ${state.participants.length}명이 나눠 부담해.`
    : "참여자를 등록하고 지출을 입력해줘.";

  $("#personSummary").innerHTML = summary.map((person) => `
    <div class="person-row">
      <div>
        <strong>${escapeHtml(person.name)}</strong>
        <div class="person-numbers">
          <span>결제 ${formatWon(person.paid)}</span>
          <span>부담 ${formatWon(person.owed)}</span>
        </div>
      </div>
      <div class="person-balance">
        <strong class="${person.balance > 0 ? "balance-positive" : person.balance < 0 ? "balance-negative" : ""}">
          ${formatWon(Math.abs(person.balance))}
        </strong>
        <span>${person.balance > 0 ? "받을 돈" : person.balance < 0 ? "보낼 돈" : "정산 없음"}</span>
      </div>
    </div>
  `).join("");

  $("#transferList").innerHTML = transfers.map((transfer) => `
    <div class="transfer-row">
      <div class="transfer-route">
        <span>${escapeHtml(participantName(transfer.fromId))}</span>
        <span class="transfer-arrow">→</span>
        <span>${escapeHtml(participantName(transfer.toId))}</span>
      </div>
      <strong>${formatWon(transfer.amount)}</strong>
    </div>
  `).join("") || (state.expenses.length
    ? '<div class="empty-state compact"><strong>추가로 송금할 금액이 없어 🎉</strong></div>'
    : "");

  $("#settlementEmpty").classList.toggle("hidden", state.expenses.length > 0);
  $("#personSummary").classList.toggle("hidden", state.expenses.length === 0);
  $("#transferList").classList.toggle("hidden", state.expenses.length === 0);
}

function renderParticipantOptions({ selectedIds = null, existingSplits = null } = {}) {
  const currentPayer = $("#expensePayer").value;
  const currentPayerFilter = $("#payerFilter").value;
  const options = state.participants.map(
    (participant) => `<option value="${participant.id}">${escapeHtml(participant.name)}</option>`,
  ).join("");

  $("#expensePayer").innerHTML = options || '<option value="">참여자를 먼저 등록해줘</option>';
  $("#payerFilter").innerHTML = `<option value="">모든 결제자</option>${options}`;
  $("#meSelect").innerHTML = `<option value="">내 이름 선택</option>${options}`;

  if (state.participants.some((participant) => participant.id === currentPayer)) {
    $("#expensePayer").value = currentPayer;
  } else if (getMeId()) {
    $("#expensePayer").value = getMeId();
  }

  if (state.participants.some((participant) => participant.id === currentPayerFilter)) {
    $("#payerFilter").value = currentPayerFilter;
  }
  $("#meSelect").value = getMeId();

  const checkedSet = selectedIds
    ? new Set(selectedIds)
    : new Set(state.participants.map((participant) => participant.id));

  $("#participantChecklist").innerHTML = state.participants.map((participant) => `
    <label class="participant-chip">
      <input type="checkbox" value="${participant.id}" ${checkedSet.has(participant.id) ? "checked" : ""} />
      <span>${escapeHtml(participant.name)}</span>
    </label>
  `).join("");

  $("#participantManageList").innerHTML = state.participants.length
    ? state.participants.map((participant) => `
      <div class="manage-row">
        <span>${escapeHtml(participant.name)}${participant.id === getMeId() ? " · 나" : ""}</span>
        <button type="button" data-remove-participant="${participant.id}">삭제</button>
      </div>
    `).join("")
    : '<p class="hint">함께 여행하는 사람을 추가해줘.</p>';

  renderCustomSplitInputs(existingSplits);
}

function renderSettingsValues() {
  $("#tripNameInput").value = state.trip.name || "";
  $("#tripStartInput").value = state.trip.start || "";
  $("#tripEndInput").value = state.trip.end || "";
  $("#settingsError").classList.add("hidden");
  renderParticipantOptions();
}

function renderAll() {
  renderHeader();
  renderParticipantOptions();
  renderHome();
  renderExpenses();
  renderSettlement();
}

function getSelectedParticipantIds() {
  return $$("#participantChecklist input:checked").map((input) => input.value);
}

function renderCustomSplitInputs(existingSplits = null) {
  const selectedIds = getSelectedParticipantIds();
  const splitMap = Object.fromEntries(
    (existingSplits || []).map((split) => [split.participantId, split.amount]),
  );

  $("#customSplitBox").innerHTML = selectedIds.map((id) => `
    <label class="custom-row">
      <strong>${escapeHtml(participantName(id))}</strong>
      <input inputmode="numeric" data-custom-id="${id}" value="${splitMap[id] || ""}" placeholder="0" />
    </label>
  `).join("");
}

function revokePendingReceiptUrl() {
  if (pendingReceiptUrl) {
    URL.revokeObjectURL(pendingReceiptUrl);
    pendingReceiptUrl = "";
  }
}

function resetExpenseForm() {
  $("#expenseForm").reset();
  $("#editingExpenseId").value = "";
  $("#expenseFormTitle").textContent = "지출 추가";
  $("#saveExpenseBtn").textContent = "지출 저장하기";
  $("#cancelEditBtn").classList.add("hidden");
  $("#expenseDate").value = todayString();
  $("#receiptPreviewWrap").classList.add("hidden");
  $("#receiptPreview").removeAttribute("src");
  $("#receiptInput").value = "";
  $("#formError").classList.add("hidden");
  pendingReceiptFile = null;
  existingReceiptId = "";
  removeExistingReceipt = false;
  revokePendingReceiptUrl();

  $$('input[name="splitMode"]').forEach((input) => {
    input.checked = input.value === "equal";
  });
  $("#customSplitBox").classList.add("hidden");
  $("#splitHint").textContent = "선택한 사람끼리 1원 단위까지 자동으로 나눠.";
  renderParticipantOptions();
}

async function resizeImage(file) {
  const image = await createImageBitmap(file);
  const maxSide = 1400;
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close();

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (result) => result ? resolve(result) : reject(new Error("사진 압축에 실패했어.")),
      "image/jpeg",
      0.76,
    );
  });

  const safeBaseName = String(file.name || "receipt")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9가-힣_-]/g, "_")
    .slice(0, 40) || "receipt";

  return new File([blob], `${safeBaseName}.jpg`, { type: "image/jpeg" });
}

function showReceiptPreview(source) {
  if (!source) {
    $("#receiptPreviewWrap").classList.add("hidden");
    $("#receiptPreview").removeAttribute("src");
    return;
  }
  $("#receiptPreview").src = source;
  $("#receiptPreviewWrap").classList.remove("hidden");
}

function buildSplits(amount) {
  const selectedIds = getSelectedParticipantIds();
  const mode = $('input[name="splitMode"]:checked').value;

  if (mode === "equal") return equalSplits(amount, selectedIds);

  return selectedIds.map((participantId) => ({
    participantId,
    amount: parseMoneyInput($(`[data-custom-id="${participantId}"]`)?.value || 0),
  }));
}

function validateExpense(amount, splits) {
  if (!state.participants.length) return "참여자를 먼저 등록해줘.";
  if (!$("#expensePayer").value) return "결제한 사람을 선택해줘.";
  if (!amount) return "금액을 입력해줘.";
  if (!splits.length) return "비용을 나눌 사람을 한 명 이상 선택해줘.";

  const totalSplit = splits.reduce((sum, split) => sum + split.amount, 0);
  if (totalSplit !== amount) {
    return `나눈 금액의 합계가 ${formatWon(amount)}과 같아야 해. 현재 ${formatWon(totalSplit)}이야.`;
  }
  return "";
}

async function saveTripSettings(event) {
  event.preventDefault();
  const name = $("#tripNameInput").value.trim();
  const startDate = $("#tripStartInput").value;
  const endDate = $("#tripEndInput").value;

  if (!name) {
    $("#settingsError").textContent = "여행 이름을 입력해줘.";
    $("#settingsError").classList.remove("hidden");
    return;
  }
  if (startDate && endDate && startDate > endDate) {
    $("#settingsError").textContent = "종료일은 시작일보다 빠를 수 없어.";
    $("#settingsError").classList.remove("hidden");
    return;
  }

  setMeId($("#meSelect").value);
  $("#settingsError").classList.add("hidden");
  showLoading("여행 정보 저장하는 중…");

  try {
    await tablesDB.upsertRow({
      databaseId: CONFIG.databaseId,
      tableId: CONFIG.tables.trips,
      rowId: CONFIG.tripRowId,
      data: {
        name,
        startDate: startDate || null,
        endDate: endDate || null,
      },
    });
    await loadSharedData({ silent: true, force: true });
    $("#settingsDialog").close();
    showToast("여행 정보를 저장했어.");
  } catch (error) {
    const message = readableError(error);
    $("#settingsError").textContent = message;
    $("#settingsError").classList.remove("hidden");
  } finally {
    hideLoading();
  }
}

async function addParticipant() {
  const input = $("#newParticipantInput");
  const name = input.value.trim();
  if (!name) return;
  if (state.participants.some((participant) => participant.name === name)) {
    showToast("같은 이름의 참여자가 이미 있어.");
    return;
  }

  showLoading("참여자 추가하는 중…");
  try {
    const row = await tablesDB.createRow({
      databaseId: CONFIG.databaseId,
      tableId: CONFIG.tables.participants,
      rowId: ID.unique(),
      data: { name },
    });
    input.value = "";
    if (!getMeId() && state.participants.length === 0) setMeId(row.$id);
    await loadSharedData({ silent: true, force: true });
    renderSettingsValues();
    showToast("참여자를 추가했어.");
  } catch (error) {
    alert(readableError(error));
  } finally {
    hideLoading();
  }
}

async function deleteParticipant(participantId) {
  const participant = state.participants.find((item) => item.id === participantId);
  if (!participant) return;

  const isUsed = state.expenses.some(
    (expense) => expense.payerId === participantId ||
      expense.splits.some((split) => split.participantId === participantId),
  );
  if (isUsed) {
    showToast("이미 지출 내역에 사용된 참여자는 삭제할 수 없어.");
    return;
  }
  if (!confirm(`${participant.name} 참여자를 삭제할까?`)) return;

  showLoading("참여자 삭제하는 중…");
  try {
    await tablesDB.deleteRow({
      databaseId: CONFIG.databaseId,
      tableId: CONFIG.tables.participants,
      rowId: participantId,
    });
    if (getMeId() === participantId) setMeId("");
    await loadSharedData({ silent: true, force: true });
    renderSettingsValues();
    showToast("참여자를 삭제했어.");
  } catch (error) {
    alert(readableError(error));
  } finally {
    hideLoading();
  }
}

async function saveExpenseFromForm(event) {
  event.preventDefault();
  const amount = parseMoneyInput($("#expenseAmount").value);
  const splits = buildSplits(amount);
  const validationError = validateExpense(amount, splits);

  if (validationError) {
    $("#formError").textContent = validationError;
    $("#formError").classList.remove("hidden");
    return;
  }

  $("#formError").classList.add("hidden");
  const editingId = $("#editingExpenseId").value;
  const existing = state.expenses.find((expense) => expense.id === editingId);
  const oldReceiptId = existing?.receiptFileId || "";
  let receiptFileId = removeExistingReceipt ? "" : oldReceiptId;
  let uploadedFileId = "";

  showLoading(existing ? "지출 수정하는 중…" : "지출 저장하는 중…");

  try {
    if (pendingReceiptFile) {
      const uploaded = await storage.createFile({
        bucketId: CONFIG.bucketId,
        fileId: ID.unique(),
        file: pendingReceiptFile,
      });
      uploadedFileId = uploaded.$id;
      receiptFileId = uploaded.$id;
    }

    const now = Date.now();
    const expenseData = {
      title: $("#expenseTitle").value.trim(),
      amount,
      date: $("#expenseDate").value,
      category: $("#expenseCategory").value,
      payerId: $("#expensePayer").value,
      splitMode: $('input[name="splitMode"]:checked').value,
      splits,
      memo: $("#expenseMemo").value.trim(),
      receiptFileId,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    const dataJson = JSON.stringify(expenseData);
    if (dataJson.length > 10000) {
      throw new Error("지출 정보가 너무 길어. 메모를 조금 줄여줘.");
    }

    if (existing) {
      await tablesDB.updateRow({
        databaseId: CONFIG.databaseId,
        tableId: CONFIG.tables.expenses,
        rowId: existing.id,
        data: { dataJson },
      });
    } else {
      await tablesDB.createRow({
        databaseId: CONFIG.databaseId,
        tableId: CONFIG.tables.expenses,
        rowId: ID.unique(),
        data: { dataJson },
      });
    }

    if (oldReceiptId && oldReceiptId !== receiptFileId) {
      try {
        await storage.deleteFile({
          bucketId: CONFIG.bucketId,
          fileId: oldReceiptId,
        });
      } catch (deleteError) {
        console.warn("Old receipt cleanup failed", deleteError);
      }
    }

    resetExpenseForm();
    await loadSharedData({ silent: true, force: true });
    navigate("expenses");
    showToast(existing ? "지출을 수정했어." : "지출을 저장했어.");
  } catch (error) {
    if (uploadedFileId) {
      try {
        await storage.deleteFile({
          bucketId: CONFIG.bucketId,
          fileId: uploadedFileId,
        });
      } catch {
        // Ignore cleanup failure.
      }
    }
    $("#formError").textContent = readableError(error);
    $("#formError").classList.remove("hidden");
  } finally {
    hideLoading();
  }
}

function openExpenseDetail(expenseId) {
  const expense = state.expenses.find((item) => item.id === expenseId);
  if (!expense) return;

  const category = categoryInfo(expense.category);
  const splitText = expense.splits
    .map((split) => `${participantName(split.participantId)} ${formatWon(split.amount)}`)
    .join(", ");

  $("#expenseDetailContent").innerHTML = `
    <div class="dialog-heading">
      <div>
        <p class="eyebrow">${category.icon} ${category.label}</p>
        <h2 class="detail-title">${escapeHtml(expense.title)}</h2>
      </div>
      <button class="icon-button" data-close-detail aria-label="닫기">✕</button>
    </div>
    <p class="detail-amount">${formatWon(expense.amount)}</p>
    <div class="detail-grid">
      <div class="detail-row"><span>날짜</span><strong>${escapeHtml(expense.date)}</strong></div>
      <div class="detail-row"><span>결제자</span><strong>${escapeHtml(participantName(expense.payerId))}</strong></div>
      <div class="detail-row"><span>정산 방식</span><strong>${expense.splitMode === "custom" ? "직접 입력" : "균등 분배"}</strong></div>
      <div class="detail-row"><span>부담자</span><strong>${escapeHtml(splitText)}</strong></div>
      ${expense.memo ? `<div class="detail-row"><span>메모</span><strong>${escapeHtml(expense.memo)}</strong></div>` : ""}
    </div>
    ${expense.receiptFileId ? `<img class="detail-receipt" src="${receiptViewUrl(expense.receiptFileId)}" alt="영수증 사진" />` : ""}
    <div class="detail-actions">
      <button class="secondary-button" data-edit-expense="${expense.id}">수정</button>
      <button class="danger-button" data-delete-expense="${expense.id}">삭제</button>
    </div>
  `;

  $("#expenseDetailDialog").showModal();
}

function editExpense(expenseId) {
  const expense = state.expenses.find((item) => item.id === expenseId);
  if (!expense) return;

  $("#expenseDetailDialog").close();
  navigate("add");

  $("#editingExpenseId").value = expense.id;
  $("#expenseFormTitle").textContent = "지출 수정";
  $("#saveExpenseBtn").textContent = "수정 내용 저장";
  $("#cancelEditBtn").classList.remove("hidden");
  $("#expenseTitle").value = expense.title;
  $("#expenseAmount").value = expense.amount.toLocaleString("ko-KR");
  $("#expenseDate").value = expense.date;
  $("#expenseCategory").value = expense.category;
  $("#expenseMemo").value = expense.memo || "";

  renderParticipantOptions({
    selectedIds: expense.splits.map((split) => split.participantId),
    existingSplits: expense.splits,
  });
  $("#expensePayer").value = expense.payerId;

  $$('input[name="splitMode"]').forEach((input) => {
    input.checked = input.value === expense.splitMode;
  });

  const custom = expense.splitMode === "custom";
  $("#customSplitBox").classList.toggle("hidden", !custom);
  $("#splitHint").textContent = custom
    ? "입력한 금액의 합계가 전체 금액과 같아야 해."
    : "선택한 사람끼리 1원 단위까지 자동으로 나눠.";

  pendingReceiptFile = null;
  existingReceiptId = expense.receiptFileId || "";
  removeExistingReceipt = false;
  revokePendingReceiptUrl();
  showReceiptPreview(existingReceiptId ? receiptViewUrl(existingReceiptId) : "");
}

async function deleteExpense(expenseId) {
  const expense = state.expenses.find((item) => item.id === expenseId);
  if (!expense || !confirm(`"${expense.title}" 지출을 삭제할까?`)) return;

  showLoading("지출 삭제하는 중…");
  try {
    await tablesDB.deleteRow({
      databaseId: CONFIG.databaseId,
      tableId: CONFIG.tables.expenses,
      rowId: expense.id,
    });

    if (expense.receiptFileId) {
      try {
        await storage.deleteFile({
          bucketId: CONFIG.bucketId,
          fileId: expense.receiptFileId,
        });
      } catch (deleteError) {
        console.warn("Receipt cleanup failed", deleteError);
      }
    }

    $("#expenseDetailDialog").close();
    await loadSharedData({ silent: true, force: true });
    showToast("지출을 삭제했어.");
  } catch (error) {
    alert(readableError(error));
  } finally {
    hideLoading();
  }
}

function settlementText() {
  const summary = calculateSummary();
  const transfers = calculateTransfers(summary);
  const total = state.expenses.reduce((sum, expense) => sum + expense.amount, 0);

  const personLines = summary.map((person) => {
    const balanceText = person.balance > 0
      ? `받을 돈 ${formatWon(person.balance)}`
      : person.balance < 0
        ? `보낼 돈 ${formatWon(-person.balance)}`
        : "정산 없음";
    return `- ${person.name}: 결제 ${formatWon(person.paid)} / 부담 ${formatWon(person.owed)} / ${balanceText}`;
  });

  const transferLines = transfers.length
    ? transfers.map((transfer) => `- ${participantName(transfer.fromId)} → ${participantName(transfer.toId)} ${formatWon(transfer.amount)}`)
    : ["- 추가 송금 없음"];

  return [
    `[${state.trip.name || "여행"} 정산]`,
    `총지출: ${formatWon(total)}`,
    "",
    "사람별 요약",
    ...personLines,
    "",
    "추천 송금",
    ...transferLines,
  ].join("\n");
}

function bindEvents() {
  document.addEventListener("click", (event) => {
    const go = event.target.closest("[data-go]")?.dataset.go;
    if (go) {
      navigate(go);
      return;
    }

    const expenseId = event.target.closest("[data-expense-id]")?.dataset.expenseId;
    if (expenseId) {
      openExpenseDetail(expenseId);
      return;
    }

    const participantId = event.target.closest("[data-remove-participant]")?.dataset.removeParticipant;
    if (participantId) {
      deleteParticipant(participantId);
      return;
    }

    const editId = event.target.closest("[data-edit-expense]")?.dataset.editExpense;
    if (editId) {
      editExpense(editId);
      return;
    }

    const deleteId = event.target.closest("[data-delete-expense]")?.dataset.deleteExpense;
    if (deleteId) {
      deleteExpense(deleteId);
      return;
    }

    if (event.target.closest("[data-close-detail]")) {
      $("#expenseDetailDialog").close();
    }
  });

  $("#openSettingsBtn").addEventListener("click", () => {
    renderSettingsValues();
    $("#settingsDialog").showModal();
  });

  $("#closeSettingsBtn").addEventListener("click", () => {
    $("#settingsDialog").close();
    if (refreshQueued) loadSharedData({ silent: true, force: true });
  });

  $("#settingsForm").addEventListener("submit", saveTripSettings);

  $("#meSelect").addEventListener("change", (event) => {
    setMeId(event.target.value);
    renderHome();
    renderSettingsValues();
  });

  $("#addParticipantBtn").addEventListener("click", addParticipant);
  $("#newParticipantInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addParticipant();
    }
  });

  $("#expenseSearch").addEventListener("input", renderExpenses);
  $("#categoryFilter").addEventListener("change", renderExpenses);
  $("#payerFilter").addEventListener("change", renderExpenses);

  $("#selectAllParticipants").addEventListener("click", () => {
    $$("#participantChecklist input").forEach((input) => { input.checked = true; });
    renderCustomSplitInputs();
  });

  $("#clearParticipants").addEventListener("click", () => {
    $$("#participantChecklist input").forEach((input) => { input.checked = false; });
    renderCustomSplitInputs();
  });

  $("#participantChecklist").addEventListener("change", () => renderCustomSplitInputs());

  $$('input[name="splitMode"]').forEach((input) => {
    input.addEventListener("change", () => {
      const custom = $('input[name="splitMode"]:checked').value === "custom";
      $("#customSplitBox").classList.toggle("hidden", !custom);
      $("#splitHint").textContent = custom
        ? "입력한 금액의 합계가 전체 금액과 같아야 해."
        : "선택한 사람끼리 1원 단위까지 자동으로 나눠.";
      if (custom) renderCustomSplitInputs();
    });
  });

  $("#expenseAmount").addEventListener("input", (event) => {
    const value = parseMoneyInput(event.target.value);
    event.target.value = value ? value.toLocaleString("ko-KR") : "";
  });

  $("#receiptInput").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    showLoading("영수증 사진 준비하는 중…");
    try {
      pendingReceiptFile = await resizeImage(file);
      removeExistingReceipt = false;
      revokePendingReceiptUrl();
      pendingReceiptUrl = URL.createObjectURL(pendingReceiptFile);
      showReceiptPreview(pendingReceiptUrl);
    } catch (error) {
      alert(readableError(error));
    } finally {
      hideLoading();
    }
  });

  $("#removeReceiptBtn").addEventListener("click", () => {
    pendingReceiptFile = null;
    removeExistingReceipt = Boolean(existingReceiptId);
    $("#receiptInput").value = "";
    revokePendingReceiptUrl();
    showReceiptPreview("");
  });

  $("#expenseForm").addEventListener("submit", saveExpenseFromForm);

  $("#cancelEditBtn").addEventListener("click", () => {
    resetExpenseForm();
    navigate("expenses");
  });

  $("#copySettlementBtn").addEventListener("click", async () => {
    if (!state.expenses.length) {
      showToast("복사할 정산 결과가 없어.");
      return;
    }
    try {
      await navigator.clipboard.writeText(settlementText());
      showToast("정산 결과를 복사했어.");
    } catch {
      prompt("아래 내용을 복사해줘.", settlementText());
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      loadSharedData({ silent: true });
    }
  });

  window.addEventListener("beforeunload", () => {
    if (realtimeSubscription?.unsubscribe) realtimeSubscription.unsubscribe();
    if (realtime?.disconnect) realtime.disconnect();
    revokePendingReceiptUrl();
  });
}

async function init() {
  renderCategoryOptions();
  bindEvents();
  resetExpenseForm();
  await loadSharedData();
  await setupRealtime();

  setInterval(() => {
    loadSharedData({ silent: true });
  }, POLL_INTERVAL_MS);

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.warn("Service worker registration failed", error);
    });
  }
}

init().catch((error) => {
  console.error("App initialization failed", error);
  currentRequestCount = 0;
  $("#loadingOverlay")?.classList.remove("hidden");
  if (window.__travelLedgerBootError) {
    window.__travelLedgerBootError(readableError(error));
  }
});

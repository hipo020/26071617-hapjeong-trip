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

const APPWRITE_RESPONSE_FORMAT = "1.9.5";
const PUBLIC_ROW_PERMISSIONS = [
  'read("any")',
  'update("any")',
  'delete("any")',
];

function generateId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`.slice(0, 36);
}

async function appwriteRequest(path, {
  method = "GET",
  data,
  formData,
} = {}) {
  const headers = {
    "X-Appwrite-Project": CONFIG.projectId,
    "X-Appwrite-Response-Format": APPWRITE_RESPONSE_FORMAT,
  };

  const options = {
    method,
    headers,
    mode: "cors",
    credentials: "omit",
  };

  if (formData) {
    options.body = formData;
  } else if (data !== undefined) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(data);
  }

  let response;
  try {
    response = await fetch(`${CONFIG.endpoint}${path}`, options);
  } catch (networkError) {
    const error = new Error(networkError?.message || "Failed to fetch");
    error.code = 0;
    error.type = "network_error";
    throw error;
  }

  if (response.status === 204) return null;

  const contentType = response.headers.get("content-type") || "";
  let payload = null;

  if (contentType.includes("application/json")) {
    payload = await response.json().catch(() => null);
  } else {
    const text = await response.text().catch(() => "");
    payload = text ? { message: text } : null;
  }

  if (!response.ok) {
    const error = new Error(
      payload?.message || `Appwrite 요청 실패 (${response.status})`,
    );
    error.code = Number(payload?.code || response.status || 0);
    error.type = String(payload?.type || "");
    error.response = payload;
    throw error;
  }

  return payload;
}

function tableRowsPath(tableId) {
  return `/tablesdb/${encodeURIComponent(CONFIG.databaseId)}/tables/${encodeURIComponent(tableId)}/rows`;
}

async function getRow(tableId, rowId) {
  return appwriteRequest(
    `${tableRowsPath(tableId)}/${encodeURIComponent(rowId)}`,
  );
}

async function listRows(tableId, limit = 100) {
  const params = new URLSearchParams();
  params.append(
    "queries[]",
    JSON.stringify({ method: "limit", values: [limit] }),
  );
  params.set("total", "false");
  params.set("ttl", "0");

  return appwriteRequest(`${tableRowsPath(tableId)}?${params.toString()}`);
}

async function createRow(tableId, rowId, rowData) {
  return appwriteRequest(tableRowsPath(tableId), {
    method: "POST",
    data: {
      rowId,
      data: rowData,
      permissions: PUBLIC_ROW_PERMISSIONS,
    },
  });
}

async function updateRow(tableId, rowId, rowData) {
  return appwriteRequest(
    `${tableRowsPath(tableId)}/${encodeURIComponent(rowId)}`,
    {
      method: "PATCH",
      data: { data: rowData },
    },
  );
}

async function upsertRow(tableId, rowId, rowData) {
  return appwriteRequest(
    `${tableRowsPath(tableId)}/${encodeURIComponent(rowId)}`,
    {
      method: "PUT",
      data: {
        data: rowData,
        permissions: PUBLIC_ROW_PERMISSIONS,
      },
    },
  );
}

async function deleteRow(tableId, rowId) {
  return appwriteRequest(
    `${tableRowsPath(tableId)}/${encodeURIComponent(rowId)}`,
    { method: "DELETE" },
  );
}

async function uploadReceipt(file) {
  const formData = new FormData();
  formData.append("fileId", generateId());
  formData.append("file", file, file.name || "receipt.jpg");
  PUBLIC_ROW_PERMISSIONS.forEach((permission) => {
    formData.append("permissions[]", permission);
  });

  return appwriteRequest(
    `/storage/buckets/${encodeURIComponent(CONFIG.bucketId)}/files`,
    {
      method: "POST",
      formData,
    },
  );
}

async function deleteReceipt(fileId) {
  return appwriteRequest(
    `/storage/buckets/${encodeURIComponent(CONFIG.bucketId)}/files/${encodeURIComponent(fileId)}`,
    { method: "DELETE" },
  );
}


const ME_KEY = "travel-budget-me-id-v2";
const POLL_INTERVAL_MS = 10000;
const META_ROW_ID = "app-meta";
const UNDO_DURATION_MS = 8000;

const CATEGORIES = [
  { id: "food", label: "식비", icon: "🍽️" },
  { id: "cafe", label: "카페", icon: "☕" },
  { id: "stay", label: "숙박", icon: "🏠" },
  { id: "transport", label: "교통", icon: "🚕" },
  { id: "shopping", label: "장보기", icon: "🛒" },
  { id: "activity", label: "놀거리", icon: "🎲" },
  { id: "etc", label: "기타", icon: "🧾" },
];


let state = {
  trip: { id: CONFIG.tripRowId, name: "", start: "", end: "" },
  participants: [],
  expenses: [],
  meta: {
    kind: "appMeta",
    ledgerLocked: false,
    transferStatus: {},
    updatedAt: 0,
    updatedBy: "",
  },
};

let pendingReceiptFile = null;
let pendingReceiptUrl = "";
let existingReceiptId = "";
let removeExistingReceipt = false;
let toastTimer = null;
let refreshTimer = null;
let refreshQueued = false;
let currentRequestCount = 0;
let formDirty = false;
let suppressDirtyTracking = false;
let isSubmittingExpense = false;
let pendingUnsavedAction = null;
let receiptViewerScale = 1;
let receiptPinchStartDistance = 0;
let receiptPinchStartScale = 1;
let undoTimer = null;
let lastDeletedExpense = null;

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

function currentUserName() {
  const id = getMeId();
  return state.participants.find((participant) => participant.id === id)?.name || "사용자 미선택";
}

function isLedgerLocked() {
  return Boolean(state.meta?.ledgerLocked);
}

function ensureLedgerEditable(message = "장부가 마감되어 수정할 수 없어.") {
  if (!isLedgerLocked()) return true;
  showToast(message);
  return false;
}

function formatDateTime(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) return "기록 없음";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function transferKey(transfer) {
  return `${transfer.fromId}__${transfer.toId}__${Math.round(transfer.amount)}`;
}

function serializeExpenseData(expense, overrides = {}) {
  return {
    kind: "expense",
    title: expense.title,
    amount: Number(expense.amount || 0),
    date: expense.date,
    category: expense.category || "etc",
    payerId: expense.payerId,
    splitMode: expense.splitMode === "custom" ? "custom" : "equal",
    splits: Array.isArray(expense.splits) ? expense.splits : [],
    memo: expense.memo || "",
    receiptFileId: expense.receiptFileId || "",
    createdAt: Number(expense.createdAt || Date.now()),
    updatedAt: Number(expense.updatedAt || Date.now()),
    createdBy: expense.createdBy || "",
    updatedBy: expense.updatedBy || "",
    deletedAt: expense.deletedAt || null,
    deletedBy: expense.deletedBy || "",
    ...overrides,
  };
}

async function saveSharedMeta(patch, { reload = false } = {}) {
  const nextMeta = {
    kind: "appMeta",
    ledgerLocked: false,
    transferStatus: {},
    updatedAt: 0,
    updatedBy: "",
    ...(state.meta || {}),
    ...patch,
    updatedAt: Date.now(),
    updatedBy: currentUserName(),
  };

  const dataJson = JSON.stringify(nextMeta);
  if (dataJson.length > 10000) throw new Error("공동 설정 데이터가 너무 커졌어.");

  await upsertRow(CONFIG.tables.expenses, META_ROW_ID, { dataJson });
  state.meta = nextMeta;

  if (reload) await loadSharedData({ silent: true, force: true });
  else renderAll();
}

function getMeId() {
  const saved = localStorage.getItem(ME_KEY) || "";
  return state.participants.some((participant) => participant.id === saved) ? saved : "";
}

function setMeId(id) {
  if (id) localStorage.setItem(ME_KEY, id);
  else localStorage.removeItem(ME_KEY);
}

function applyMeSelection(id) {
  setMeId(id);

  const homeSelect = $("#homeMeSelect");
  const settingsSelect = $("#meSelect");

  if (homeSelect) homeSelect.value = id;
  if (settingsSelect) settingsSelect.value = id;

  renderHome();
}

function setSyncStatus(text, status = "") {
  const element = $("#syncStatus");
  element.textContent = text;
  element.className = `sync-status${status ? ` ${status}` : ""}`;
}

function setExpenseFormDirty(value) {
  formDirty = Boolean(value);
}

function hasUnsavedExpenseChanges() {
  return Boolean(
    formDirty &&
    !isSubmittingExpense &&
    $('.view[data-view="add"]')?.classList.contains("active")
  );
}

function requestUnsavedConfirmation(action) {
  if (!hasUnsavedExpenseChanges()) {
    action();
    return true;
  }

  pendingUnsavedAction = action;
  $("#unsavedChangesDialog").showModal();
  return false;
}

function setExpenseSaving(saving) {
  isSubmittingExpense = Boolean(saving);
  const button = $("#saveExpenseBtn");
  button.disabled = isSubmittingExpense;
  button.setAttribute("aria-busy", String(isSubmittingExpense));
  button.textContent = isSubmittingExpense
    ? "저장 중…"
    : ($("#editingExpenseId").value ? "수정 내용 저장" : "지출 저장하기");
}

function touchDistance(touches) {
  if (!touches || touches.length < 2) return 0;
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

function setReceiptViewerScale(nextScale) {
  receiptViewerScale = Math.min(4, Math.max(1, nextScale));
  const image = $("#receiptViewerImage");
  image.style.width = `${receiptViewerScale * 100}%`;
  image.style.minWidth = `${receiptViewerScale * 100}%`;
  $("#receiptZoomResetBtn").textContent = `${Math.round(receiptViewerScale * 100)}%`;
}

function openReceiptViewer(source) {
  if (!source) return;
  $("#receiptViewerImage").src = source;
  setReceiptViewerScale(1);
  $("#receiptViewerStage").scrollTo({ top: 0, left: 0 });
  $("#receiptViewerDialog").showModal();
}

function closeReceiptViewer() {
  $("#receiptViewerDialog").close();
  $("#receiptViewerImage").removeAttribute("src");
  setReceiptViewerScale(1);
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
    return "Appwrite 연결이 차단됐어. Web platform Hostname과 테이블 권한을 확인해줘.";
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
    const row = await getRow(
      CONFIG.tables.trips,
      CONFIG.tripRowId,
    );
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
  const result = await listRows(CONFIG.tables.participants, 100);

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
  const result = await listRows(CONFIG.tables.expenses, 100);
  let meta = {
    kind: "appMeta",
    ledgerLocked: false,
    transferStatus: {},
    updatedAt: 0,
    updatedBy: "",
  };
  const expenses = [];

  for (const row of result.rows || []) {
    const data = safeJsonParse(row.dataJson, {});

    if (row.$id === META_ROW_ID || data.kind === "appMeta") {
      meta = {
        ...meta,
        ...data,
        kind: "appMeta",
        transferStatus: data.transferStatus && typeof data.transferStatus === "object"
          ? data.transferStatus
          : {},
      };
      continue;
    }

    const expense = {
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
      createdBy: String(data.createdBy || ""),
      updatedBy: String(data.updatedBy || ""),
      deletedAt: data.deletedAt ? Number(data.deletedAt) : null,
      deletedBy: String(data.deletedBy || ""),
    };

    if (expense.title && expense.amount > 0 && !expense.deletedAt) expenses.push(expense);
  }

  expenses.sort((a, b) => {
    const dateCompare = String(b.date).localeCompare(String(a.date));
    return dateCompare || b.createdAt - a.createdAt;
  });

  return { expenses, meta };
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
    setSyncStatus("업데이트 대기", "syncing");
    return;
  }

  if (!silent) showLoading("공동 장부 불러오는 중…");
  setSyncStatus("새 내역 확인 중…", "syncing");

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

    const [trip, participants, expensePayload] = await Promise.race([
      dataRequest,
      timeoutRequest,
    ]);

    state = {
      trip,
      participants,
      expenses: expensePayload.expenses,
      meta: expensePayload.meta,
    };

    if (getMeId() && !participants.some((participant) => participant.id === getMeId())) {
      setMeId("");
    }

    renderAll();
    setSyncStatus("✓ 저장됨", "success");
    refreshQueued = false;

    if (!state.trip.name && !$("#settingsDialog").open) {
      renderSettingsValues();
      $("#settingsDialog").showModal();
    }
  } catch (error) {
    console.error(error);
    const message = readableError(error);
    setSyncStatus(navigator.onLine ? "동기화 오류" : "오프라인", navigator.onLine ? "error" : "offline");
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

function setupRealtime() {
  // 기본 공동 저장을 안정적으로 확인한 뒤 실시간 기능을 추가할 예정이야.
}


function navigate(viewName, { skipUnsavedCheck = false } = {}) {
  if (viewName === "add" && isLedgerLocked()) {
    showToast("장부가 마감되어 지출을 추가할 수 없어.");
    return false;
  }

  if (
    !skipUnsavedCheck &&
    viewName !== "add" &&
    hasUnsavedExpenseChanges()
  ) {
    requestUnsavedConfirmation(() => {
      resetExpenseForm();
      navigate(viewName, { skipUnsavedCheck: true });
    });
    return false;
  }

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
  return true;
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

function openTripTitleEditor() {
  if (isLedgerLocked()) {
    showToast("장부가 마감되어 여행 이름을 수정할 수 없어.");
    return;
  }

  $("#quickTripNameInput").value = state.trip.name || "";
  $("#tripTitleDisplay").classList.add("hidden");
  $("#tripTitleEditor").classList.remove("hidden");

  requestAnimationFrame(() => {
    $("#quickTripNameInput").focus();
    $("#quickTripNameInput").select();
  });
}

function closeTripTitleEditor() {
  $("#tripTitleEditor").classList.remove("is-saving");
  $("#tripTitleEditor").classList.add("hidden");
  $("#tripTitleDisplay").classList.remove("hidden");
  $("#quickTripNameInput").value = state.trip.name || "";
}

async function saveTripTitleQuickly(event) {
  event.preventDefault();

  if (!ensureLedgerEditable("장부가 마감되어 여행 이름을 수정할 수 없어.")) {
    closeTripTitleEditor();
    return;
  }

  const name = $("#quickTripNameInput").value.trim();

  if (!name) {
    showToast("여행 이름을 입력해줘.");
    $("#quickTripNameInput").focus();
    return;
  }

  if (name === state.trip.name) {
    closeTripTitleEditor();
    return;
  }

  $("#tripTitleEditor").classList.add("is-saving");
  setSyncStatus("저장 중…", "syncing");

  try {
    await upsertRow(
      CONFIG.tables.trips,
      CONFIG.tripRowId,
      {
        name,
        startDate: state.trip.start || null,
        endDate: state.trip.end || null,
      },
    );

    state.trip.name = name;
    renderHeader();
    renderSettingsValues();
    closeTripTitleEditor();
    setSyncStatus("✓ 저장됨", "success");
    showToast("여행 이름을 바꿨어.");
  } catch (error) {
    $("#tripTitleEditor").classList.remove("is-saving");
    setSyncStatus(navigator.onLine ? "저장 실패" : "오프라인", navigator.onLine ? "error" : "offline");
    alert(readableError(error));
  }
}

function renderHeader() {
  $("#headerTripName").textContent = state.trip.name || "여행 가계부";
  $("#tripTitleButton").disabled = isLedgerLocked();
  $("#tripTitleButton").setAttribute(
    "aria-label",
    isLedgerLocked()
      ? "장부가 마감되어 여행 이름 수정 불가"
      : "여행 이름 수정",
  );
  $("#memberCount").textContent = `${state.participants.length}명`;

  let period = "여행 정보를 설정해줘";
  if (state.trip.start && state.trip.end) {
    period = `${state.trip.start.replaceAll("-", ".")} ~ ${state.trip.end.replaceAll("-", ".")}`;
  } else if (state.trip.start) {
    period = `${state.trip.start.replaceAll("-", ".")} 출발`;
  }
  $("#homePeriod").textContent = period;

  const locked = isLedgerLocked();

  if (locked && !$("#tripTitleEditor").classList.contains("hidden")) {
    closeTripTitleEditor();
  }

  $("#ledgerLockBanner").classList.toggle("hidden", !locked);
  $(".nav-add").disabled = locked;
  $(".nav-add").setAttribute("aria-disabled", String(locked));
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
      <span class="expense-chevron" aria-hidden="true">›</span>
    </button>
  `;
}

function renderHome() {
  const total = state.expenses.reduce((sum, expense) => sum + expense.amount, 0);
  const summary = calculateSummary();
  const transfers = calculateTransfers(summary);
  const meId = getMeId();
  const me = summary.find((person) => person.id === meId);
  const selectedParticipant = state.participants.find((participant) => participant.id === meId);

  $("#homeTotal").textContent = formatWon(total);

  $("#homeUserCard").classList.toggle("needs-selection", !selectedParticipant);
  $("#homeUserCard").classList.toggle("is-selected", Boolean(selectedParticipant));
  $("#homeUserAvatar").textContent = selectedParticipant
    ? Array.from(selectedParticipant.name.trim())[0] || "?"
    : "?";
  $("#homeUserName").textContent = selectedParticipant
    ? `${selectedParticipant.name} 기준`
    : state.participants.length
      ? "사용자를 선택해줘"
      : "참여자를 먼저 추가해줘";

  $("#homeMeSelect").disabled = state.participants.length === 0;
  $("#homeMeSelect").value = selectedParticipant ? selectedParticipant.id : "";

  $("#myPaid").textContent = formatWon(me?.paid || 0);
  $("#myOwed").textContent = formatWon(me?.owed || 0);

  if (!me) {
    $("#myBalanceLabel").textContent = "내 정산 상태";
    $("#myBalance").textContent = state.participants.length
      ? "사용자를 선택해줘"
      : "참여자를 먼저 추가해줘";
    $("#myBalanceHint").textContent = "사용자를 선택하면 송금 정보를 보여줘";
    $("#myBalance").className = "";
    $("#myBalanceCard").disabled = true;
    $("#myBalanceCard").classList.remove(
      "balance-state-in",
      "balance-state-out",
      "balance-state-even",
    );
  } else {
    const balance = me.balance;
    const outgoingTransfers = transfers.filter((transfer) => transfer.fromId === meId);
    const incomingTransfers = transfers.filter((transfer) => transfer.toId === meId);

    $("#myBalanceLabel").textContent = balance > 0
      ? "내가 받을 금액"
      : balance < 0
        ? "내가 보낼 금액"
        : "정산 완료";
    $("#myBalance").textContent = formatWon(Math.abs(balance));
    $("#myBalance").className = balance > 0
      ? "balance-positive"
      : balance < 0
        ? "balance-negative"
        : "";

    if (balance < 0) {
      $("#myBalanceHint").textContent = outgoingTransfers.length === 1
        ? `${participantName(outgoingTransfers[0].toId)}에게 보내기 →`
        : `${outgoingTransfers.length}명에게 보내기 →`;
    } else if (balance > 0) {
      $("#myBalanceHint").textContent = incomingTransfers.length === 1
        ? `${participantName(incomingTransfers[0].fromId)}에게 받을 예정 →`
        : `${incomingTransfers.length}명에게 받을 예정 →`;
    } else {
      $("#myBalanceHint").textContent = "추가로 주고받을 금액이 없어";
    }

    $("#myBalanceCard").disabled = state.expenses.length === 0;
    $("#myBalanceCard").classList.toggle("balance-state-in", balance > 0);
    $("#myBalanceCard").classList.toggle("balance-state-out", balance < 0);
    $("#myBalanceCard").classList.toggle("balance-state-even", balance === 0);
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

  const meId = getMeId();
  const completedTransferCount = transfers.filter((transfer) => (
    Boolean(state.meta?.transferStatus?.[transferKey(transfer)])
  )).length;

  $("#transferProgressBadge").textContent = transfers.length
    ? `완료 ${completedTransferCount}/${transfers.length}`
    : "송금 횟수 최소화";

  $("#transferList").innerHTML = transfers.map((transfer) => {
    const key = transferKey(transfer);
    const completed = Boolean(state.meta?.transferStatus?.[key]);
    const relatedToMe = transfer.fromId === meId || transfer.toId === meId;

    return `
      <div class="transfer-row${relatedToMe ? " my-transfer" : ""}${completed ? " is-complete" : ""}">
        <div class="transfer-route">
          <span>${escapeHtml(participantName(transfer.fromId))}</span>
          <span class="transfer-arrow">→</span>
          <span>${escapeHtml(participantName(transfer.toId))}</span>
        </div>
        <div class="transfer-side">
          <strong>${formatWon(transfer.amount)}</strong>
          <button
            type="button"
            class="transfer-complete-button"
            data-transfer-key="${escapeHtml(key)}"
            aria-pressed="${completed}"
            aria-label="${completed ? "송금 완료 취소" : "송금 완료 표시"}"
          >
            ${completed ? "✓ 완료" : "완료"}
          </button>
        </div>
      </div>
    `;
  }).join("") || (state.expenses.length
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
  $("#homeMeSelect").innerHTML = `<option value="">사용자 선택</option>${options}`;

  if (state.participants.some((participant) => participant.id === currentPayer)) {
    $("#expensePayer").value = currentPayer;
  } else if (getMeId()) {
    $("#expensePayer").value = getMeId();
  }

  if (state.participants.some((participant) => participant.id === currentPayerFilter)) {
    $("#payerFilter").value = currentPayerFilter;
  }
  $("#meSelect").value = getMeId();
  $("#homeMeSelect").value = getMeId();

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
        <button type="button" data-remove-participant="${participant.id}" ${isLedgerLocked() ? "disabled" : ""}>삭제</button>
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

  const locked = isLedgerLocked();
  $("#ledgerLockStatus").textContent = locked ? "마감됨" : "수정 가능";
  $("#ledgerLockDescription").textContent = locked
    ? "지출과 여행 정보는 읽기만 가능해."
    : "누구나 지출을 추가하고 수정할 수 있어.";
  $("#toggleLedgerLockBtn").textContent = locked ? "다시 열기" : "장부 마감";
  $("#toggleLedgerLockBtn").classList.toggle("is-locked", locked);

  ["#tripNameInput", "#tripStartInput", "#tripEndInput", "#newParticipantInput", "#addParticipantBtn", "#saveTripSettingsBtn"]
    .forEach((selector) => {
      const element = $(selector);
      if (element) element.disabled = locked;
    });
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
  suppressDirtyTracking = true;
  $("#expenseForm").reset();
  $("#editingExpenseId").value = "";
  $("#expenseFormTitle").textContent = "지출 추가";
  $("#saveExpenseBtn").textContent = "지출 저장하기";
  $("#cancelEditBtn").classList.add("hidden");
  $("#expenseDate").value = todayString();
  $("#receiptPreviewWrap").classList.add("hidden");
  $("#receiptPreview").removeAttribute("src");
  $("#receiptInput").value = "";
  $("#receiptCameraInput").value = "";
  $("#formError").classList.add("hidden");
  pendingReceiptFile = null;
  existingReceiptId = "";
  removeExistingReceipt = false;
  revokePendingReceiptUrl();
  updateReceiptSelectionText("사진을 추가하지 않았어", false);

  $$('input[name="splitMode"]').forEach((input) => {
    input.checked = input.value === "equal";
  });
  $("#customSplitBox").classList.add("hidden");
  $("#splitHint").textContent = "선택한 사람끼리 1원 단위까지 자동으로 나눠.";
  renderParticipantOptions();
  suppressDirtyTracking = false;
  setExpenseFormDirty(false);
  setExpenseSaving(false);
}

function canvasToJpegBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (result) => result
        ? resolve(result)
        : reject(new Error("사진 압축에 실패했어.")),
      "image/jpeg",
      quality,
    );
  });
}

async function resizeImage(file) {
  let image;

  try {
    image = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    image = await createImageBitmap(file);
  }

  const originalWidth = image.width;
  const originalHeight = image.height;
  const aspectRatio = originalHeight / Math.max(originalWidth, 1);
  const isLongReceipt = aspectRatio >= 2.6;

  // 긴 영수증은 기존처럼 '가장 긴 변 1400px'로 줄이면
  // 가로 폭이 지나치게 작아져 글자가 뭉개진다.
  const maxWidth = isLongReceipt ? 1600 : 1800;
  const maxHeight = isLongReceipt ? 9000 : 2200;
  const maxCanvasArea = 18_000_000;

  const widthScale = maxWidth / originalWidth;
  const heightScale = maxHeight / originalHeight;
  const areaScale = Math.sqrt(
    maxCanvasArea / Math.max(originalWidth * originalHeight, 1),
  );

  const scale = Math.min(1, widthScale, heightScale, areaScale);
  let targetWidth = Math.max(1, Math.round(originalWidth * scale));
  let targetHeight = Math.max(1, Math.round(originalHeight * scale));

  const drawCanvas = (width, height) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new Error("사진 처리용 화면을 만들지 못했어.");
    }

    // PNG나 스크린샷의 투명 배경이 JPEG 변환 후 검게 변하는 것을 방지한다.
    context.fillStyle = "#FFFFFF";
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, width, height);
    return canvas;
  };

  let canvas = drawCanvas(targetWidth, targetHeight);
  let blob = await canvasToJpegBlob(canvas, isLongReceipt ? 0.8 : 0.82);

  // Appwrite 버킷 제한(5MB)보다 약간 작게 맞춘다.
  const maxUploadBytes = 4.6 * 1024 * 1024;

  if (blob.size > maxUploadBytes) {
    blob = await canvasToJpegBlob(canvas, 0.66);
  }

  if (blob.size > maxUploadBytes) {
    targetWidth = Math.max(1, Math.round(targetWidth * 0.82));
    targetHeight = Math.max(1, Math.round(targetHeight * 0.82));
    canvas = drawCanvas(targetWidth, targetHeight);
    blob = await canvasToJpegBlob(canvas, 0.64);
  }

  image.close();

  if (blob.size > maxUploadBytes) {
    throw new Error("사진이 너무 길거나 커서 압축하지 못했어. 화면을 두 장으로 나눠서 올려줘.");
  }

  const safeBaseName = String(file.name || "receipt")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9가-힣_-]/g, "_")
    .slice(0, 40) || "receipt";

  return new File([blob], `${safeBaseName}.jpg`, {
    type: "image/jpeg",
    lastModified: Date.now(),
  });
}

function updateReceiptSelectionText(message, hasFile = false) {
  const element = $("#receiptSelectionText");
  if (!element) return;
  element.textContent = message;
  element.classList.toggle("has-file", hasFile);
}

async function handleReceiptFile(file) {
  if (!file) return;

  showLoading("영수증 사진 준비하는 중…");
  try {
    pendingReceiptFile = await resizeImage(file);
    removeExistingReceipt = false;
    revokePendingReceiptUrl();
    pendingReceiptUrl = URL.createObjectURL(pendingReceiptFile);
    showReceiptPreview(pendingReceiptUrl);
    const preparedSizeMb = (pendingReceiptFile.size / 1024 / 1024).toFixed(1);
    updateReceiptSelectionText(
      `${file.name || "영수증 사진"} · 업로드용 ${preparedSizeMb}MB`,
      true,
    );
  } catch (error) {
    alert(readableError(error));
  } finally {
    hideLoading();
  }
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
  if (!ensureLedgerEditable("장부가 마감되어 여행 정보를 수정할 수 없어.")) return;
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
    await upsertRow(
      CONFIG.tables.trips,
      CONFIG.tripRowId,
      {
        name,
        startDate: startDate || null,
        endDate: endDate || null,
      },
    );
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
  if (!ensureLedgerEditable("장부가 마감되어 참여자를 추가할 수 없어.")) return;
  const input = $("#newParticipantInput");
  const name = input.value.trim();
  if (!name) return;
  if (state.participants.some((participant) => participant.name === name)) {
    showToast("같은 이름의 참여자가 이미 있어.");
    return;
  }

  showLoading("참여자 추가하는 중…");
  try {
    const row = await createRow(
      CONFIG.tables.participants,
      generateId(),
      { name },
    );
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
  if (!ensureLedgerEditable("장부가 마감되어 참여자를 삭제할 수 없어.")) return;
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
    await deleteRow(CONFIG.tables.participants, participantId);
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
  if (!ensureLedgerEditable("장부가 마감되어 지출을 저장할 수 없어.")) return;
  if (isSubmittingExpense) return;

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

  setExpenseSaving(true);
  setSyncStatus("저장 중…", "syncing");

  try {
    if (pendingReceiptFile) {
      const uploaded = await uploadReceipt(pendingReceiptFile);
      uploadedFileId = uploaded.$id;
      receiptFileId = uploaded.$id;
    }

    const now = Date.now();
    const editorName = currentUserName();
    const expenseData = {
      kind: "expense",
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
      createdBy: existing?.createdBy || editorName,
      updatedBy: editorName,
      deletedAt: null,
      deletedBy: "",
    };

    const dataJson = JSON.stringify(expenseData);
    if (dataJson.length > 10000) {
      throw new Error("지출 정보가 너무 길어. 메모를 조금 줄여줘.");
    }

    if (existing) {
      await updateRow(
        CONFIG.tables.expenses,
        existing.id,
        { dataJson },
      );
    } else {
      await createRow(
        CONFIG.tables.expenses,
        generateId(),
        { dataJson },
      );
    }

    if (oldReceiptId && oldReceiptId !== receiptFileId) {
      try {
        await deleteReceipt(oldReceiptId);
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
        await deleteReceipt(uploadedFileId);
      } catch {
        // Ignore cleanup failure.
      }
    }
    $("#formError").textContent = readableError(error);
    $("#formError").classList.remove("hidden");
    setSyncStatus(navigator.onLine ? "저장 실패" : "오프라인", navigator.onLine ? "error" : "offline");
  } finally {
    setExpenseSaving(false);
  }
}

function openExpenseDetail(expenseId) {
  const expense = state.expenses.find((item) => item.id === expenseId);
  if (!expense) return;

  const category = categoryInfo(expense.category);
  const splitCards = expense.splits
    .map((split) => `
      <div class="detail-split-item">
        <strong>${escapeHtml(participantName(split.participantId))}</strong>
        <span>${formatWon(split.amount)}</span>
      </div>
    `)
    .join("");

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
      <div class="detail-split-section">
        <div class="detail-split-heading">
          <span>부담자</span>
          <small>${expense.splits.length}명</small>
        </div>
        <div class="detail-split-list">${splitCards}</div>
      </div>
      ${expense.memo ? `<div class="detail-row"><span>메모</span><strong>${escapeHtml(expense.memo)}</strong></div>` : ""}
    </div>
    <div class="detail-audit">
      <span><em>작성</em><strong>${escapeHtml(expense.createdBy || "기록 없음")} · ${formatDateTime(expense.createdAt)}</strong></span>
      <span><em>최근 수정</em><strong>${escapeHtml(expense.updatedBy || expense.createdBy || "기록 없음")} · ${formatDateTime(expense.updatedAt)}</strong></span>
    </div>
    ${expense.receiptFileId ? `
      <div class="detail-receipt-scroll" aria-label="영수증 사진">
        <img class="detail-receipt" src="${receiptViewUrl(expense.receiptFileId)}" alt="영수증 사진" />
        <button type="button" class="receipt-fullscreen-button" data-open-receipt="${receiptViewUrl(expense.receiptFileId)}">
          전체화면
        </button>
      </div>
    ` : ""}
    ${isLedgerLocked()
      ? `<div class="detail-actions locked"><div class="detail-locked-message">🔒 장부가 마감되어 수정할 수 없어.</div></div>`
      : `<div class="detail-actions">
          <button class="detail-edit-button" data-edit-expense="${expense.id}">수정하기</button>
          <button class="detail-delete-button" data-delete-expense="${expense.id}">삭제</button>
        </div>`
    }
  `;

  $("#expenseDetailDialog").showModal();
}

function editExpense(expenseId) {
  if (!ensureLedgerEditable("장부가 마감되어 지출을 수정할 수 없어.")) return;
  const expense = state.expenses.find((item) => item.id === expenseId);
  if (!expense) return;

  $("#expenseDetailDialog").close();
  navigate("add");
  suppressDirtyTracking = true;

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
  updateReceiptSelectionText(
    existingReceiptId ? "기존 영수증 사진이 첨부되어 있어" : "사진을 추가하지 않았어",
    Boolean(existingReceiptId),
  );
  suppressDirtyTracking = false;
  setExpenseFormDirty(false);
  setExpenseSaving(false);
}

function hideUndoToast() {
  clearTimeout(undoTimer);
  undoTimer = null;
  $("#undoToast").classList.remove("show");
}

function showUndoDelete(expense) {
  lastDeletedExpense = expense;
  $("#undoToastMessage").textContent = `"${expense.title}" 지출을 삭제했어.`;
  $("#undoToast").classList.add("show");
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => {
    hideUndoToast();
    lastDeletedExpense = null;
  }, UNDO_DURATION_MS);
}

async function undoLastDelete() {
  const expense = lastDeletedExpense;
  if (!expense) return;

  hideUndoToast();
  showLoading("지출 복원하는 중…");
  try {
    const restored = serializeExpenseData(expense, {
      deletedAt: null,
      deletedBy: "",
      updatedAt: Date.now(),
      updatedBy: currentUserName(),
    });
    await updateRow(CONFIG.tables.expenses, expense.id, { dataJson: JSON.stringify(restored) });
    lastDeletedExpense = null;
    await loadSharedData({ silent: true, force: true });
    showToast("삭제한 지출을 되돌렸어.");
  } catch (error) {
    alert(readableError(error));
  } finally {
    hideLoading();
  }
}

async function deleteExpense(expenseId) {
  if (!ensureLedgerEditable("장부가 마감되어 지출을 삭제할 수 없어.")) return;
  const expense = state.expenses.find((item) => item.id === expenseId);
  if (!expense || !confirm(`"${expense.title}" 지출을 삭제할까?`)) return;

  showLoading("지출 삭제하는 중…");
  try {
    const deletedData = serializeExpenseData(expense, {
      deletedAt: Date.now(),
      deletedBy: currentUserName(),
      updatedAt: Date.now(),
      updatedBy: currentUserName(),
    });
    await updateRow(CONFIG.tables.expenses, expense.id, { dataJson: JSON.stringify(deletedData) });
    $("#expenseDetailDialog").close();
    state.expenses = state.expenses.filter((item) => item.id !== expense.id);
    renderAll();
    showUndoDelete(expense);
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
    ? transfers.map((transfer) => {
        const completed = Boolean(state.meta?.transferStatus?.[transferKey(transfer)]);
        return `- ${completed ? "[완료] " : ""}${participantName(transfer.fromId)} → ${participantName(transfer.toId)} ${formatWon(transfer.amount)}`;
      })
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

async function toggleLedgerLock() {
  const nextLocked = !isLedgerLocked();
  const message = nextLocked
    ? "장부를 마감하면 지출·여행 정보 수정이 잠겨. 마감할까?"
    : "장부를 다시 열면 모두가 수정할 수 있어. 다시 열까?";
  if (!confirm(message)) return;

  showLoading(nextLocked ? "장부 마감하는 중…" : "장부 다시 여는 중…");
  try {
    await saveSharedMeta({ ledgerLocked: nextLocked });
    renderSettingsValues();
    showToast(nextLocked ? "장부를 마감했어." : "장부를 다시 열었어.");
  } catch (error) {
    alert(readableError(error));
  } finally {
    hideLoading();
  }
}

async function toggleTransferComplete(key) {
  const nextStatus = {
    ...(state.meta?.transferStatus || {}),
    [key]: !state.meta?.transferStatus?.[key],
  };

  showLoading("송금 상태 저장하는 중…");
  try {
    await saveSharedMeta({ transferStatus: nextStatus });
    showToast(nextStatus[key] ? "송금 완료로 표시했어." : "완료 표시를 취소했어.");
  } catch (error) {
    alert(readableError(error));
  } finally {
    hideLoading();
  }
}

function safeFileName(value, fallback = "travel-budget") {
  return String(value || fallback)
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "-")
    .slice(0, 60) || fallback;
}

function downloadBlob(content, type, filename) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadCsvBackup() {
  const headers = ["날짜", "카테고리", "사용 내역", "금액", "결제자", "부담자", "메모", "영수증 URL", "작성자", "최근 수정자", "최근 수정일"];
  const rows = state.expenses.map((expense) => [
    expense.date,
    categoryInfo(expense.category).label,
    expense.title,
    expense.amount,
    participantName(expense.payerId),
    expense.splits.map((split) => `${participantName(split.participantId)} ${formatWon(split.amount)}`).join(" / "),
    expense.memo,
    expense.receiptFileId ? receiptViewUrl(expense.receiptFileId) : "",
    expense.createdBy || "",
    expense.updatedBy || "",
    new Date(expense.updatedAt || expense.createdAt).toISOString(),
  ]);
  const csv = "\uFEFF" + [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  downloadBlob(csv, "text/csv;charset=utf-8", `${safeFileName(state.trip.name)}-가계부.csv`);
  showToast("CSV 파일을 만들었어.");
}

function downloadJsonBackup() {
  const backup = {
    version: 1,
    exportedAt: new Date().toISOString(),
    trip: state.trip,
    participants: state.participants,
    expenses: state.expenses,
    meta: state.meta,
    settlementText: settlementText(),
  };
  downloadBlob(JSON.stringify(backup, null, 2), "application/json;charset=utf-8", `${safeFileName(state.trip.name)}-백업.json`);
  showToast("JSON 백업 파일을 만들었어.");
}

function openCreatorDialog() {
  if ($("#settingsDialog").open) {
    $("#settingsDialog").close();
  }

  if (!$("#creatorDialog").open) {
    $("#creatorDialog").showModal();
  }
}

function closeCreatorDialog({ reopenSettings = true } = {}) {
  if ($("#creatorDialog").open) {
    $("#creatorDialog").close();
  }

  if (reopenSettings) {
    renderSettingsValues();
    $("#settingsDialog").showModal();
  }
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

    const receiptSource = event.target.closest("[data-open-receipt]")?.dataset.openReceipt;
    if (receiptSource) {
      openReceiptViewer(receiptSource);
      return;
    }

    const transferStatusKey = event.target.closest("[data-transfer-key]")?.dataset.transferKey;
    if (transferStatusKey) {
      toggleTransferComplete(transferStatusKey);
      return;
    }

    if (event.target.closest("[data-close-detail]")) {
      $("#expenseDetailDialog").close();
    }
  });

  const openSettingsDialog = () => {
    requestUnsavedConfirmation(() => {
      if (hasUnsavedExpenseChanges()) resetExpenseForm();

      if (!$("#tripTitleEditor").classList.contains("hidden")) {
        closeTripTitleEditor();
      }

      renderSettingsValues();
      $("#settingsDialog").showModal();
    });
  };

  $("#tripTitleButton").addEventListener("click", openTripTitleEditor);
  $("#tripTitleEditor").addEventListener("submit", saveTripTitleQuickly);
  $("#cancelTripTitleEditBtn").addEventListener("click", closeTripTitleEditor);
  $("#quickTripNameInput").addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeTripTitleEditor();
    }
  });

  $("#openSettingsBtn").addEventListener("click", openSettingsDialog);
  $("#openSettingsNavBtn").addEventListener("click", openSettingsDialog);
  $("#ledgerLockBanner").addEventListener("click", openSettingsDialog);
  $("#toggleLedgerLockBtn").addEventListener("click", toggleLedgerLock);
  $("#downloadCsvBtn").addEventListener("click", downloadCsvBackup);
  $("#downloadJsonBtn").addEventListener("click", downloadJsonBackup);

  $("#openCreatorEasterEggBtn").addEventListener("click", openCreatorDialog);
  $("#closeCreatorDialogBtn").addEventListener("click", () => closeCreatorDialog());
  $("#confirmCreatorDialogBtn").addEventListener("click", () => closeCreatorDialog());

  $("#creatorDialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    closeCreatorDialog();
  });

  $("#creatorDialog").addEventListener("click", (event) => {
    if (event.target === $("#creatorDialog")) {
      closeCreatorDialog();
    }
  });

  $("#closeSettingsBtn").addEventListener("click", () => {
    $("#settingsDialog").close();
    if (refreshQueued) loadSharedData({ silent: true, force: true });
  });

  $("#settingsForm").addEventListener("submit", saveTripSettings);

  $("#meSelect").addEventListener("change", (event) => {
    applyMeSelection(event.target.value);
    renderSettingsValues();
  });

  $("#homeMeSelect").addEventListener("change", (event) => {
    applyMeSelection(event.target.value);
  });

  $("#myBalanceCard").addEventListener("click", () => {
    if (!$("#myBalanceCard").disabled) navigate("settlement");
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

  $("#openReceiptCameraBtn").addEventListener("click", () => {
    $("#receiptCameraInput").click();
  });

  $("#openReceiptGalleryBtn").addEventListener("click", () => {
    $("#receiptInput").click();
  });

  ["#receiptInput", "#receiptCameraInput"].forEach((selector) => {
    $(selector).addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      await handleReceiptFile(file);
      event.target.value = "";
    });
  });

  $("#removeReceiptBtn").addEventListener("click", () => {
    pendingReceiptFile = null;
    removeExistingReceipt = Boolean(existingReceiptId);
    $("#receiptInput").value = "";
    $("#receiptCameraInput").value = "";
    revokePendingReceiptUrl();
    showReceiptPreview("");
    updateReceiptSelectionText("사진을 추가하지 않았어", false);
  });

  $("#expenseForm").addEventListener("submit", saveExpenseFromForm);

  ["input", "change"].forEach((eventName) => {
    $("#expenseForm").addEventListener(eventName, () => {
      if (!suppressDirtyTracking && !isSubmittingExpense) {
        setExpenseFormDirty(true);
      }
    });
  });

  $("#cancelEditBtn").addEventListener("click", () => {
    navigate("expenses");
  });

  $("#closeReceiptViewerBtn").addEventListener("click", closeReceiptViewer);
  $("#receiptZoomOutBtn").addEventListener("click", () => {
    setReceiptViewerScale(receiptViewerScale - 0.25);
  });
  $("#receiptZoomInBtn").addEventListener("click", () => {
    setReceiptViewerScale(receiptViewerScale + 0.25);
  });
  $("#receiptZoomResetBtn").addEventListener("click", () => {
    setReceiptViewerScale(1);
    $("#receiptViewerStage").scrollTo({ top: 0, left: 0, behavior: "smooth" });
  });

  $("#receiptViewerImage").addEventListener("dblclick", () => {
    setReceiptViewerScale(receiptViewerScale > 1 ? 1 : 2);
  });

  $("#receiptViewerStage").addEventListener("touchstart", (event) => {
    if (event.touches.length === 2) {
      receiptPinchStartDistance = touchDistance(event.touches);
      receiptPinchStartScale = receiptViewerScale;
    }
  }, { passive: true });

  $("#receiptViewerStage").addEventListener("touchmove", (event) => {
    if (event.touches.length !== 2 || !receiptPinchStartDistance) return;
    event.preventDefault();
    const ratio = touchDistance(event.touches) / receiptPinchStartDistance;
    setReceiptViewerScale(receiptPinchStartScale * ratio);
  }, { passive: false });

  $("#receiptViewerStage").addEventListener("touchend", () => {
    receiptPinchStartDistance = 0;
  });

  $("#receiptViewerDialog").addEventListener("click", (event) => {
    if (event.target === $("#receiptViewerDialog")) closeReceiptViewer();
  });

  $("#keepEditingBtn").addEventListener("click", () => {
    pendingUnsavedAction = null;
    $("#unsavedChangesDialog").close();
  });

  $("#leaveWithoutSavingBtn").addEventListener("click", () => {
    const action = pendingUnsavedAction;
    pendingUnsavedAction = null;
    $("#unsavedChangesDialog").close();
    if (action) action();
  });

  $("#unsavedChangesDialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    pendingUnsavedAction = null;
    $("#unsavedChangesDialog").close();
  });

  $("#undoDeleteBtn").addEventListener("click", undoLastDelete);

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

  window.addEventListener("online", () => {
    setSyncStatus("새 내역 확인 중…", "syncing");
    loadSharedData({ silent: true, force: true });
  });

  window.addEventListener("offline", () => {
    setSyncStatus("오프라인", "offline");
  });

  window.addEventListener("beforeunload", (event) => {
    revokePendingReceiptUrl();

    if (hasUnsavedExpenseChanges()) {
      event.preventDefault();
      event.returnValue = "";
    }
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

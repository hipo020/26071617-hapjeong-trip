const STORAGE_KEY = "travel-budget-state-v1";
const DB_NAME = "travel-budget-receipts";
const DB_STORE = "receipts";

const CATEGORIES = [
  { id: "food", label: "식비", icon: "🍽️" },
  { id: "cafe", label: "카페", icon: "☕" },
  { id: "stay", label: "숙박", icon: "🏠" },
  { id: "transport", label: "교통", icon: "🚕" },
  { id: "shopping", label: "장보기", icon: "🛒" },
  { id: "activity", label: "놀거리", icon: "🎲" },
  { id: "etc", label: "기타", icon: "🧾" }
];

const defaultState = {
  trip: {
    name: "사촌 가족여행",
    start: "",
    end: "",
    participants: [],
    meId: ""
  },
  expenses: []
};

let state = loadState();
let pendingReceiptBlob = null;
let existingReceiptId = null;
let toastTimer = null;

function $(selector, root = document) {
  return root.querySelector(selector);
}

function $$(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

function uid(prefix = "id") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return saved ? { ...defaultState, ...saved, trip: { ...defaultState.trip, ...saved.trip } } : structuredClone(defaultState);
  } catch {
    return structuredClone(defaultState);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function formatWon(value) {
  return `${Math.round(Number(value) || 0).toLocaleString("ko-KR")}원`;
}

function formatDate(dateString) {
  if (!dateString) return "날짜 없음";
  const date = new Date(`${dateString}T00:00:00`);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function categoryInfo(id) {
  return CATEGORIES.find(c => c.id === id) || CATEGORIES.at(-1);
}

function participantName(id) {
  return state.trip.participants.find(p => p.id === id)?.name || "알 수 없음";
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 1800);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function putReceipt(blob, id = uid("receipt")) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(blob, id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return id;
}

async function getReceipt(id) {
  if (!id) return null;
  const db = await openDb();
  const blob = await new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const req = tx.objectStore(DB_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return blob;
}

async function deleteReceipt(id) {
  if (!id) return;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

function calculateSummary() {
  const summary = Object.fromEntries(
    state.trip.participants.map(p => [p.id, { id: p.id, name: p.name, paid: 0, owed: 0, balance: 0 }])
  );

  for (const expense of state.expenses) {
    if (summary[expense.payerId]) summary[expense.payerId].paid += expense.amount;
    for (const split of expense.splits || []) {
      if (summary[split.participantId]) summary[split.participantId].owed += split.amount;
    }
  }

  Object.values(summary).forEach(person => {
    person.balance = person.paid - person.owed;
  });

  return Object.values(summary);
}

function calculateTransfers(summary) {
  const creditors = summary
    .filter(p => p.balance > 0)
    .map(p => ({ ...p, remaining: p.balance }))
    .sort((a, b) => b.remaining - a.remaining);

  const debtors = summary
    .filter(p => p.balance < 0)
    .map(p => ({ ...p, remaining: -p.balance }))
    .sort((a, b) => b.remaining - a.remaining);

  const transfers = [];
  let i = 0;
  let j = 0;

  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].remaining, creditors[j].remaining);
    if (amount > 0) {
      transfers.push({
        fromId: debtors[i].id,
        toId: creditors[j].id,
        amount: Math.round(amount)
      });
    }
    debtors[i].remaining -= amount;
    creditors[j].remaining -= amount;
    if (debtors[i].remaining < 0.5) i++;
    if (creditors[j].remaining < 0.5) j++;
  }
  return transfers;
}

function navigate(viewName) {
  $$(".view").forEach(view => view.classList.toggle("active", view.dataset.view === viewName));
  $$(".nav-item").forEach(btn => btn.classList.toggle("active", btn.dataset.go === viewName));
  window.scrollTo({ top: 0, behavior: "smooth" });

  if (viewName === "add" && !$("#editingExpenseId").value) {
    resetExpenseForm();
  }
  renderAll();
}

function equalSplits(amount, participantIds) {
  if (!participantIds.length) return [];
  const base = Math.floor(amount / participantIds.length);
  let remainder = amount - base * participantIds.length;
  return participantIds.map(id => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    return { participantId: id, amount: base + extra };
  });
}

function getSelectedParticipantIds() {
  return $$("#participantChecklist input:checked").map(input => input.value);
}

function parseMoneyInput(value) {
  return Number(String(value).replace(/[^\d]/g, "")) || 0;
}

function renderCategoryOptions() {
  const html = CATEGORIES.map(c => `<option value="${c.id}">${c.icon} ${c.label}</option>`).join("");
  $("#expenseCategory").innerHTML = html;
  $("#categoryFilter").innerHTML = `<option value="">모든 카테고리</option>${html}`;
}

function renderParticipantOptions() {
  const options = state.trip.participants.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
  $("#expensePayer").innerHTML = options || `<option value="">참여자를 먼저 등록해줘</option>`;
  $("#payerFilter").innerHTML = `<option value="">모든 결제자</option>${options}`;
  $("#meSelect").innerHTML = `<option value="">선택 안 함</option>${options}`;
  $("#meSelect").value = state.trip.meId || "";

  $("#participantChecklist").innerHTML = state.trip.participants.map(p => `
    <label class="participant-chip">
      <input type="checkbox" value="${p.id}" checked />
      <span>${escapeHtml(p.name)}</span>
    </label>
  `).join("");

  $("#participantManageList").innerHTML = state.trip.participants.length
    ? state.trip.participants.map(p => `
      <div class="manage-row">
        <span>${escapeHtml(p.name)}${p.id === state.trip.meId ? " · 나" : ""}</span>
        <button type="button" data-remove-participant="${p.id}">삭제</button>
      </div>
    `).join("")
    : `<p class="hint">참여자를 추가하면 지출을 나눌 수 있어.</p>`;

  renderCustomSplitInputs();
}

function renderHeader() {
  $("#headerTripName").textContent = state.trip.name || "여행 가계부";
  $("#memberCount").textContent = `${state.trip.participants.length}명`;

  let period = "여행 날짜를 설정해줘";
  if (state.trip.start && state.trip.end) {
    period = `${state.trip.start.replaceAll("-", ".")} ~ ${state.trip.end.replaceAll("-", ".")}`;
  } else if (state.trip.start) {
    period = `${state.trip.start.replaceAll("-", ".")} 출발`;
  }
  $("#homePeriod").textContent = period;
}

function renderHome() {
  const total = state.expenses.reduce((sum, e) => sum + e.amount, 0);
  const summary = calculateSummary();
  const me = summary.find(p => p.id === state.trip.meId);

  $("#homeTotal").textContent = formatWon(total);
  $("#myPaid").textContent = formatWon(me?.paid || 0);
  $("#myOwed").textContent = formatWon(me?.owed || 0);

  const balance = me?.balance || 0;
  $("#myBalanceLabel").textContent = balance >= 0 ? "내가 받을 돈" : "내가 보낼 돈";
  $("#myBalance").textContent = formatWon(Math.abs(balance));
  $("#myBalance").className = balance > 0 ? "balance-positive" : balance < 0 ? "balance-negative" : "";

  const recent = [...state.expenses]
    .sort((a, b) => `${b.date}-${b.createdAt}`.localeCompare(`${a.date}-${a.createdAt}`))
    .slice(0, 4);

  $("#recentExpenses").innerHTML = recent.map(expenseCardHtml).join("");
  $("#homeEmpty").classList.toggle("hidden", state.expenses.length > 0);
  $("#recentExpenses").classList.toggle("hidden", state.expenses.length === 0);
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

function renderExpenses() {
  const query = $("#expenseSearch").value.trim().toLowerCase();
  const category = $("#categoryFilter").value;
  const payer = $("#payerFilter").value;

  const filtered = [...state.expenses]
    .filter(e => !query || `${e.title} ${e.memo || ""}`.toLowerCase().includes(query))
    .filter(e => !category || e.category === category)
    .filter(e => !payer || e.payerId === payer)
    .sort((a, b) => `${b.date}-${b.createdAt}`.localeCompare(`${a.date}-${a.createdAt}`));

  $("#expenseList").innerHTML = filtered.map(expenseCardHtml).join("");
  $("#expenseEmpty").classList.toggle("hidden", filtered.length > 0);
}

function renderSettlement() {
  const total = state.expenses.reduce((sum, e) => sum + e.amount, 0);
  const summary = calculateSummary();
  const transfers = calculateTransfers(summary);

  $("#settlementTotal").textContent = formatWon(total);
  $("#settlementSub").textContent = state.expenses.length
    ? `${state.expenses.length}건의 지출을 ${state.trip.participants.length}명이 나눠 부담해.`
    : "참여자를 등록하고 지출을 입력해줘.";

  $("#personSummary").innerHTML = summary.map(person => {
    const receive = person.balance >= 0;
    return `
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
          <span>${person.balance === 0 ? "정산 없음" : receive ? "받을 돈" : "보낼 돈"}</span>
        </div>
      </div>
    `;
  }).join("");

  $("#transferList").innerHTML = transfers.map(t => `
    <div class="transfer-row">
      <div class="transfer-route">
        <span>${escapeHtml(participantName(t.fromId))}</span>
        <span class="transfer-arrow">→</span>
        <span>${escapeHtml(participantName(t.toId))}</span>
      </div>
      <strong>${formatWon(t.amount)}</strong>
    </div>
  `).join("") || (state.expenses.length ? `<div class="empty-state compact"><strong>모두 정산 완료 상태야 🎉</strong></div>` : "");

  $("#settlementEmpty").classList.toggle("hidden", state.expenses.length > 0);
  $("#personSummary").classList.toggle("hidden", state.expenses.length === 0);
  $("#transferList").classList.toggle("hidden", state.expenses.length === 0);
}

function renderAll() {
  renderHeader();
  renderHome();
  renderExpenses();
  renderSettlement();
}

function renderSettingsValues() {
  $("#tripNameInput").value = state.trip.name || "";
  $("#tripStartInput").value = state.trip.start || "";
  $("#tripEndInput").value = state.trip.end || "";
  renderParticipantOptions();
}

function renderCustomSplitInputs(existingSplits = null) {
  const selectedIds = getSelectedParticipantIds();
  const splitMap = Object.fromEntries((existingSplits || []).map(s => [s.participantId, s.amount]));
  $("#customSplitBox").innerHTML = selectedIds.map(id => `
    <label class="custom-row">
      <strong>${escapeHtml(participantName(id))}</strong>
      <input inputmode="numeric" data-custom-id="${id}" value="${splitMap[id] || ""}" placeholder="0" />
    </label>
  `).join("");
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
  $("#formError").classList.add("hidden");
  pendingReceiptBlob = null;
  existingReceiptId = null;
  renderParticipantOptions();
  $$('input[name="splitMode"]').forEach(input => input.checked = input.value === "equal");
  $("#customSplitBox").classList.add("hidden");
  $("#splitHint").textContent = "선택한 사람끼리 1원 단위까지 자동으로 나눠.";
}

async function resizeImage(file) {
  const image = await createImageBitmap(file);
  const maxSide = 1400;
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close();
  return new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .78));
}

async function previewReceipt(blob) {
  if (!blob) {
    $("#receiptPreviewWrap").classList.add("hidden");
    $("#receiptPreview").removeAttribute("src");
    return;
  }
  const url = URL.createObjectURL(blob);
  $("#receiptPreview").src = url;
  $("#receiptPreviewWrap").classList.remove("hidden");
}

function buildSplits(amount) {
  const selectedIds = getSelectedParticipantIds();
  const mode = $('input[name="splitMode"]:checked').value;
  if (mode === "equal") return equalSplits(amount, selectedIds);

  return selectedIds.map(id => ({
    participantId: id,
    amount: parseMoneyInput($(`[data-custom-id="${id}"]`)?.value || 0)
  }));
}

function validateExpense(amount, splits) {
  if (!state.trip.participants.length) return "참여자를 먼저 등록해줘.";
  if (!$("#expensePayer").value) return "결제한 사람을 선택해줘.";
  if (!amount) return "금액을 입력해줘.";
  if (!splits.length) return "비용을 나눌 사람을 한 명 이상 선택해줘.";

  const totalSplit = splits.reduce((sum, s) => sum + s.amount, 0);
  if (totalSplit !== amount) {
    return `나눈 금액의 합계가 ${formatWon(amount)}과 같아야 해. 현재 ${formatWon(totalSplit)}이야.`;
  }
  return "";
}

async function saveExpenseFromForm(event) {
  event.preventDefault();
  const amount = parseMoneyInput($("#expenseAmount").value);
  const splits = buildSplits(amount);
  const error = validateExpense(amount, splits);

  if (error) {
    $("#formError").textContent = error;
    $("#formError").classList.remove("hidden");
    return;
  }

  $("#formError").classList.add("hidden");
  const editingId = $("#editingExpenseId").value;
  const existing = state.expenses.find(e => e.id === editingId);
  let receiptId = existingReceiptId;

  if (pendingReceiptBlob) {
    if (receiptId) await deleteReceipt(receiptId);
    receiptId = await putReceipt(pendingReceiptBlob);
  }

  const expense = {
    id: editingId || uid("expense"),
    title: $("#expenseTitle").value.trim(),
    amount,
    date: $("#expenseDate").value,
    category: $("#expenseCategory").value,
    payerId: $("#expensePayer").value,
    splits,
    splitMode: $('input[name="splitMode"]:checked').value,
    memo: $("#expenseMemo").value.trim(),
    receiptId,
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now()
  };

  if (existing) {
    state.expenses = state.expenses.map(e => e.id === editingId ? expense : e);
  } else {
    state.expenses.push(expense);
  }

  saveState();
  showToast(existing ? "지출을 수정했어." : "지출을 저장했어.");
  resetExpenseForm();
  navigate("expenses");
}

async function openExpenseDetail(expenseId) {
  const expense = state.expenses.find(e => e.id === expenseId);
  if (!expense) return;
  const category = categoryInfo(expense.category);
  const splitText = expense.splits
    .map(s => `${participantName(s.participantId)} ${formatWon(s.amount)}`)
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
      <div class="detail-row"><span>날짜</span><strong>${expense.date}</strong></div>
      <div class="detail-row"><span>결제자</span><strong>${escapeHtml(participantName(expense.payerId))}</strong></div>
      <div class="detail-row"><span>정산 방식</span><strong>${expense.splitMode === "custom" ? "직접 입력" : "균등 분배"}</strong></div>
      <div class="detail-row"><span>부담자</span><strong>${escapeHtml(splitText)}</strong></div>
      ${expense.memo ? `<div class="detail-row"><span>메모</span><strong>${escapeHtml(expense.memo)}</strong></div>` : ""}
    </div>
    <div id="detailReceiptSlot"></div>
    <div class="detail-actions">
      <button class="secondary-button" data-edit-expense="${expense.id}">수정</button>
      <button class="danger-button" data-delete-expense="${expense.id}">삭제</button>
    </div>
  `;

  if (expense.receiptId) {
    const blob = await getReceipt(expense.receiptId);
    if (blob) {
      const url = URL.createObjectURL(blob);
      $("#detailReceiptSlot").innerHTML = `<img class="detail-receipt" src="${url}" alt="영수증 사진" />`;
    }
  }

  $("#expenseDetailDialog").showModal();
}

async function editExpense(expenseId) {
  const expense = state.expenses.find(e => e.id === expenseId);
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
  $("#expensePayer").value = expense.payerId;
  $("#expenseMemo").value = expense.memo || "";

  $$("#participantChecklist input").forEach(input => {
    input.checked = expense.splits.some(s => s.participantId === input.value);
  });

  $$('input[name="splitMode"]').forEach(input => input.checked = input.value === expense.splitMode);
  const isCustom = expense.splitMode === "custom";
  $("#customSplitBox").classList.toggle("hidden", !isCustom);
  $("#splitHint").textContent = isCustom
    ? "입력한 금액의 합계가 전체 금액과 같아야 해."
    : "선택한 사람끼리 1원 단위까지 자동으로 나눠.";

  renderCustomSplitInputs(expense.splits);
  existingReceiptId = expense.receiptId || null;
  pendingReceiptBlob = null;

  if (existingReceiptId) {
    const blob = await getReceipt(existingReceiptId);
    await previewReceipt(blob);
  }
}

async function removeExpense(expenseId) {
  const expense = state.expenses.find(e => e.id === expenseId);
  if (!expense) return;
  if (!confirm(`"${expense.title}" 지출을 삭제할까?`)) return;

  if (expense.receiptId) await deleteReceipt(expense.receiptId);
  state.expenses = state.expenses.filter(e => e.id !== expenseId);
  saveState();
  $("#expenseDetailDialog").close();
  renderAll();
  showToast("지출을 삭제했어.");
}

function settlementText() {
  const summary = calculateSummary();
  const transfers = calculateTransfers(summary);
  const total = state.expenses.reduce((sum, e) => sum + e.amount, 0);

  const personLines = summary.map(p => {
    const stateText = p.balance > 0
      ? `받을 돈 ${formatWon(p.balance)}`
      : p.balance < 0
        ? `보낼 돈 ${formatWon(-p.balance)}`
        : "정산 없음";
    return `- ${p.name}: 결제 ${formatWon(p.paid)} / 부담 ${formatWon(p.owed)} / ${stateText}`;
  });

  const transferLines = transfers.length
    ? transfers.map(t => `- ${participantName(t.fromId)} → ${participantName(t.toId)} ${formatWon(t.amount)}`)
    : ["- 추가 송금 없음"];

  return [
    `[${state.trip.name || "여행"} 정산]`,
    `총지출: ${formatWon(total)}`,
    "",
    "사람별 요약",
    ...personLines,
    "",
    "추천 송금",
    ...transferLines
  ].join("\n");
}

function loadSampleData() {
  const names = ["희수", "선협", "사촌오빠", "새언니", "사촌동생1", "사촌동생2", "동생", "동생남친"];
  const participants = names.map(name => ({ id: uid("person"), name }));
  state.trip = {
    name: "사촌 가족여행",
    start: todayString(),
    end: todayString(),
    participants,
    meId: participants[0].id
  };

  state.expenses = [
    {
      id: uid("expense"),
      title: "바비큐 장보기",
      amount: 168000,
      date: todayString(),
      category: "shopping",
      payerId: participants[0].id,
      splits: equalSplits(168000, participants.map(p => p.id)),
      splitMode: "equal",
      memo: "고기와 채소, 음료",
      receiptId: null,
      createdAt: Date.now() - 3000,
      updatedAt: Date.now() - 3000
    },
    {
      id: uid("expense"),
      title: "근처 카페",
      amount: 72000,
      date: todayString(),
      category: "cafe",
      payerId: participants[2].id,
      splits: equalSplits(72000, participants.slice(0, 6).map(p => p.id)),
      splitMode: "equal",
      memo: "6명만 방문",
      receiptId: null,
      createdAt: Date.now() - 2000,
      updatedAt: Date.now() - 2000
    }
  ];

  saveState();
  renderSettingsValues();
  renderAll();
  showToast("예시 데이터를 넣었어.");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function bindEvents() {
  document.addEventListener("click", async event => {
    const go = event.target.closest("[data-go]")?.dataset.go;
    if (go) return navigate(go);

    const expenseId = event.target.closest("[data-expense-id]")?.dataset.expenseId;
    if (expenseId) return openExpenseDetail(expenseId);

    const removeParticipantId = event.target.closest("[data-remove-participant]")?.dataset.removeParticipant;
    if (removeParticipantId) {
      const used = state.expenses.some(e =>
        e.payerId === removeParticipantId ||
        e.splits.some(s => s.participantId === removeParticipantId)
      );
      if (used) return showToast("이 참여자는 지출 기록에 사용돼서 삭제할 수 없어.");
      state.trip.participants = state.trip.participants.filter(p => p.id !== removeParticipantId);
      if (state.trip.meId === removeParticipantId) state.trip.meId = "";
      saveState();
      renderSettingsValues();
      renderAll();
      return;
    }

    const editId = event.target.closest("[data-edit-expense]")?.dataset.editExpense;
    if (editId) return editExpense(editId);

    const deleteId = event.target.closest("[data-delete-expense]")?.dataset.deleteExpense;
    if (deleteId) return removeExpense(deleteId);

    if (event.target.closest("[data-close-detail]")) $("#expenseDetailDialog").close();
  });

  $("#openSettingsBtn").addEventListener("click", () => {
    renderSettingsValues();
    $("#settingsDialog").showModal();
  });

  $("#settingsForm").addEventListener("submit", event => {
    event.preventDefault();
    state.trip.name = $("#tripNameInput").value.trim() || "여행 가계부";
    state.trip.start = $("#tripStartInput").value;
    state.trip.end = $("#tripEndInput").value;
    state.trip.meId = $("#meSelect").value;
    saveState();
    $("#settingsDialog").close();
    renderAll();
    showToast("여행 정보를 저장했어.");
  });

  $("#addParticipantBtn").addEventListener("click", () => {
    const input = $("#newParticipantInput");
    const name = input.value.trim();
    if (!name) return;
    if (state.trip.participants.some(p => p.name === name)) return showToast("같은 이름의 참여자가 이미 있어.");
    const participant = { id: uid("person"), name };
    state.trip.participants.push(participant);
    if (!state.trip.meId) state.trip.meId = participant.id;
    input.value = "";
    saveState();
    renderSettingsValues();
    renderAll();
  });

  $("#newParticipantInput").addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      $("#addParticipantBtn").click();
    }
  });

  $("#loadSampleBtn").addEventListener("click", loadSampleData);

  $("#resetAppBtn").addEventListener("click", async () => {
    if (!confirm("여행 정보와 모든 지출을 완전히 초기화할까?")) return;
    for (const expense of state.expenses) {
      if (expense.receiptId) await deleteReceipt(expense.receiptId);
    }
    state = structuredClone(defaultState);
    saveState();
    $("#settingsDialog").close();
    resetExpenseForm();
    renderAll();
    showToast("전체 데이터를 초기화했어.");
  });

  $("#expenseSearch").addEventListener("input", renderExpenses);
  $("#categoryFilter").addEventListener("change", renderExpenses);
  $("#payerFilter").addEventListener("change", renderExpenses);

  $("#selectAllParticipants").addEventListener("click", () => {
    $$("#participantChecklist input").forEach(input => input.checked = true);
    renderCustomSplitInputs();
  });

  $("#clearParticipants").addEventListener("click", () => {
    $$("#participantChecklist input").forEach(input => input.checked = false);
    renderCustomSplitInputs();
  });

  $("#participantChecklist").addEventListener("change", () => renderCustomSplitInputs());

  $$('input[name="splitMode"]').forEach(input => input.addEventListener("change", () => {
    const custom = $('input[name="splitMode"]:checked').value === "custom";
    $("#customSplitBox").classList.toggle("hidden", !custom);
    $("#splitHint").textContent = custom
      ? "입력한 금액의 합계가 전체 금액과 같아야 해."
      : "선택한 사람끼리 1원 단위까지 자동으로 나눠.";
    if (custom) renderCustomSplitInputs();
  }));

  $("#expenseAmount").addEventListener("input", event => {
    const value = parseMoneyInput(event.target.value);
    event.target.value = value ? value.toLocaleString("ko-KR") : "";
  });

  $("#receiptInput").addEventListener("change", async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    pendingReceiptBlob = await resizeImage(file);
    await previewReceipt(pendingReceiptBlob);
  });

  $("#removeReceiptBtn").addEventListener("click", async () => {
    pendingReceiptBlob = null;
    if (existingReceiptId) {
      await deleteReceipt(existingReceiptId);
      existingReceiptId = null;
    }
    $("#receiptInput").value = "";
    await previewReceipt(null);
  });

  $("#expenseForm").addEventListener("submit", saveExpenseFromForm);

  $("#cancelEditBtn").addEventListener("click", () => {
    resetExpenseForm();
    navigate("expenses");
  });

  $("#copySettlementBtn").addEventListener("click", async () => {
    if (!state.expenses.length) return showToast("복사할 정산 결과가 없어.");
    await navigator.clipboard.writeText(settlementText());
    showToast("정산 결과를 복사했어.");
  });
}

function init() {
  renderCategoryOptions();
  renderParticipantOptions();
  resetExpenseForm();
  bindEvents();
  renderAll();

  if (!state.trip.participants.length) {
    setTimeout(() => {
      renderSettingsValues();
      $("#settingsDialog").showModal();
    }, 250);
  }

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

init();

const STORAGE_KEY = "juzoor_alqarya_records_v9";
const BROADCAST_KEY = "juzoor_maardabsa_broadcast_v1";
const FIRESTORE_PEOPLE_COLLECTION = "juzoor_people";
const FIRESTORE_BROADCAST_DOC = "juzoor_broadcast/main";

// غيّر كلمة السر هنا إلى الكلمة التي تريدها للدخول إلى الإدارة وتفعيل الحذف الفردي
const ADMIN_PASSCODE = "namr1989";
let adminUnlocked = false;
let isSyncingFromCloud = false;
let isSyncingBroadcastFromCloud = false;
let deletedIdsSinceSync = new Set();

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isSafeMediaSrc(src) {
  if (!src || typeof src !== "string") return false;
  const trimmed = src.trim();
  return (
    trimmed.startsWith("https://") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("data:image/") ||
    trimmed.startsWith("data:video/")
  );
}

function normalizeArabic(text) {
  if (!text) return "";
  return text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/\bعبد\s+/g, "عبد");
}

function canonicalKey(text) {
  return normalizeArabic(text).replace(/\s+/g, "");
}

function getFirstName(name) {
  const clean = (name || "").trim().replace(/\s+/g, " ");
  if (!clean) return "";
  const parts = clean.split(" ");
  if (parts[0] === "عبد" && parts.length >= 2) {
    return `${parts[0]} ${parts[1]}`;
  }
  return parts[0];
}

function cleanNameText(name) {
  return (name || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s+عبد$/u, "")
    .trim();
}

function stripFamilySuffix(name, family = "") {
  let clean = cleanNameText(name);
  if (family && family.trim()) {
    const famClean = cleanNameText(family);
    const re = new RegExp(`\\s+${famClean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "u");
    clean = clean.replace(re, "").trim();
  }
  return clean;
}

function uid() {
  return "p_" + Math.random().toString(36).slice(2, 10);
}

const DEMO_DATA = [];

let people = loadPeople();
let expandedPersonId = null;
let selectedSectFilter = "";
let selectedFamilyFilter = "";
let broadcastState = loadBroadcast();

function loadBroadcast() {
  const fallback = {
    tickerText: "مرحباً بكم في أرشيف أنساب طوائف معردبسة من الجد إلى الحفيد",
    mediaType: "none",
    mediaSrc: ""
  };
  try {
    const sessionRaw = sessionStorage.getItem(BROADCAST_KEY);
    if (sessionRaw) {
      const sParsed = JSON.parse(sessionRaw);
      if (sParsed && isSafeMediaSrc(sParsed.mediaSrc)) {
        return {
          tickerText: sParsed.tickerText || fallback.tickerText,
          mediaType: sParsed.mediaType || "none",
          mediaSrc: sParsed.mediaSrc
        };
      }
    }
    const raw = localStorage.getItem(BROADCAST_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return {
      tickerText: parsed.tickerText || fallback.tickerText,
      mediaType: parsed.mediaType || "none",
      mediaSrc: isSafeMediaSrc(parsed.mediaSrc) ? parsed.mediaSrc : ""
    };
  } catch {
    return fallback;
  }
}

function saveBroadcast(syncToCloud = true) {
  try {
    sessionStorage.setItem(BROADCAST_KEY, JSON.stringify(broadcastState));
  } catch {}
  try {
    localStorage.setItem(BROADCAST_KEY, JSON.stringify(broadcastState));
  } catch {}

  if (!syncToCloud || isSyncingBroadcastFromCloud || !window.juzoorDb) return;

  const cloudMediaSrc =
    broadcastState.mediaSrc && broadcastState.mediaSrc.startsWith("data:") && broadcastState.mediaSrc.length > 750000
      ? ""
      : broadcastState.mediaSrc;

  window.juzoorDb
    .doc(FIRESTORE_BROADCAST_DOC)
    .set(
      {
        tickerText: broadcastState.tickerText || "",
        mediaType: cloudMediaSrc ? broadcastState.mediaType : "none",
        mediaSrc: cloudMediaSrc || "",
        updatedAt: Date.now()
      },
      { merge: true }
    )
    .catch((err) => console.error("Firestore broadcast save error:", err));
}

function renderBroadcast() {
  const textEl = document.getElementById("ticker-text");
  if (textEl) {
    textEl.textContent = broadcastState.tickerText || "أرشيف أنساب طوائف معردبسة من الجد إلى الحفيد";
  }

  const bannerEl = document.getElementById("public-media-banner");
  const contentEl = document.getElementById("public-media-content");
  if (!bannerEl || !contentEl) return;

  if (
    broadcastState.mediaType === "image" &&
    isSafeMediaSrc(broadcastState.mediaSrc)
  ) {
    bannerEl.style.display = "block";
    contentEl.innerHTML = `<img src="${escapeHtml(broadcastState.mediaSrc)}" alt="إعلان الإدارة" />`;
  } else if (
    broadcastState.mediaType === "video" &&
    isSafeMediaSrc(broadcastState.mediaSrc)
  ) {
    bannerEl.style.display = "block";
    contentEl.innerHTML = `<video src="${escapeHtml(broadcastState.mediaSrc)}" controls playsinline></video>`;
  } else {
    bannerEl.style.display = "none";
    contentEl.innerHTML = "";
  }
}

function addUniqueTag(list, value) {
  const clean = (value || "").trim();
  if (!clean) return list;
  const arr = Array.isArray(list) ? [...list] : [];
  if (!arr.some((item) => canonicalKey(item) === canonicalKey(clean))) {
    arr.push(clean);
  }
  return arr;
}

function normalizePersonRecord(p) {
  const fullName = cleanNameText(p.fullName);
  const sects = addUniqueTag(p.sects, p.sect);
  const families = addUniqueTag(p.families, p.family);
  return {
    ...p,
    id: p.id || uid(),
    fullName,
    sect: p.sect || sects[0] || "",
    family: p.family || families[0] || "",
    sects,
    families,
    fatherId: p.fatherId || null,
    motherName: p.motherName || "",
    motherLink: p.motherLink || "",
    birthYear: p.birthYear || "",
    isDeceased: Boolean(p.isDeceased),
    deathYear: p.deathYear || "",
    registeredViaMainForm: Boolean(p.registeredViaMainForm)
  };
}

function loadPeople() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([]));
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizePersonRecord);
  } catch {
    return [];
  }
}

function savePeople(deletedIds = []) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(people));

  if (Array.isArray(deletedIds) && deletedIds.length > 0) {
    deletedIds.forEach((id) => deletedIdsSinceSync.add(String(id)));
  }

  if (isSyncingFromCloud || !window.juzoorDb) return;

  const db = window.juzoorDb;
  const colRef = db.collection(FIRESTORE_PEOPLE_COLLECTION);

  if (Array.isArray(deletedIds) && deletedIds.length > 0) {
    deletedIds.forEach((id) => {
      if (!id) return;
      colRef
        .doc(String(id))
        .delete()
        .catch((err) => console.error("Firestore delete error:", err));
    });
  }

  people.forEach((person) => {
    if (!person || !person.id) return;
    const normalized = normalizePersonRecord(person);
    colRef
      .doc(String(normalized.id))
      .set(normalized, { merge: true })
      .catch((err) => console.error("Firestore save error:", err));
  });
}

function getPersonById(id) {
  return id ? people.find((p) => p.id === id) || null : null;
}

function getLineageSummary(person) {
  if (!person) return "";
  const father = getPersonById(person.fatherId);
  const grand = father ? getPersonById(father.fatherId) : null;
  const parts = [person.fullName];
  if (father) parts.push(`ابن ${father.fullName}`);
  if (grand) parts.push(`بن ${grand.fullName}`);
  return parts.join(" ← ");
}

function findExistingPerson(name, fatherIdHint = null) {
  const clean = cleanNameText(name);
  const targetKey = canonicalKey(clean);
  if (!targetKey) return null;

  const targetFirstKey = canonicalKey(getFirstName(clean));

  if (fatherIdHint) {
    const sameFatherExact = people.find(
      (p) => p.fatherId === fatherIdHint && canonicalKey(p.fullName) === targetKey
    );
    if (sameFatherExact) return sameFatherExact;

    if (targetFirstKey) {
      const sameFatherFirstName = people.find(
        (p) =>
          p.fatherId === fatherIdHint &&
          canonicalKey(getFirstName(p.fullName)) === targetFirstKey
      );
      if (sameFatherFirstName) return sameFatherFirstName;
    }

    return null;
  }

  const exactMatches = people.filter((p) => canonicalKey(p.fullName) === targetKey);
  if (exactMatches.length > 0) return exactMatches[0];

  const baseMatches = people.filter((p) => {
    const pBase = canonicalKey(stripFamilySuffix(p.fullName, p.family));
    return pBase && pBase === targetKey;
  });
  return baseMatches[0] || null;
}

function upsertPerson({
  fullName,
  birthYear = "",
  sect = "",
  family = "",
  fatherId = null,
  motherName = "",
  motherLink = "",
  isDeceased = false,
  deathYear = "",
  registeredViaMainForm = false
}) {
  const cleanName = cleanNameText(fullName);
  if (!cleanName) return null;

  const existing = findExistingPerson(cleanName, fatherId);
  if (existing) {
    if (fatherId && existing.fatherId && existing.fatherId !== fatherId) {
      const createdSeparate = {
        id: uid(),
        fullName: cleanName,
        birthYear: birthYear.trim(),
        sect: sect.trim(),
        family: family.trim(),
        sects: addUniqueTag([], sect),
        families: addUniqueTag([], family),
        fatherId,
        motherName: motherName.trim(),
        motherLink: motherLink.trim(),
        isDeceased: Boolean(isDeceased),
        deathYear: deathYear.trim(),
        registeredViaMainForm: Boolean(registeredViaMainForm)
      };
      people.push(createdSeparate);
      return createdSeparate;
    }

    if (cleanName.length > existing.fullName.length) {
      existing.fullName = cleanName;
    }
    if (birthYear && !existing.birthYear) existing.birthYear = birthYear.trim();
    if (sect && !existing.sect) existing.sect = sect.trim();
    if (family && !existing.family) existing.family = family.trim();
    existing.sects = addUniqueTag(existing.sects, sect || existing.sect);
    existing.families = addUniqueTag(existing.families, family || existing.family);

    if (fatherId && !existing.fatherId && existing.id !== fatherId) {
      existing.fatherId = fatherId;
    }
    if (motherName && !existing.motherName) existing.motherName = motherName.trim();
    if (motherLink && !existing.motherLink) existing.motherLink = motherLink.trim();
    if (isDeceased) existing.isDeceased = true;
    if (deathYear) existing.deathYear = deathYear.trim();
    if (registeredViaMainForm) existing.registeredViaMainForm = true;
    return existing;
  }

  const created = {
    id: uid(),
    fullName: cleanName,
    birthYear: birthYear.trim(),
    sect: sect.trim(),
    family: family.trim(),
    sects: addUniqueTag([], sect),
    families: addUniqueTag([], family),
    fatherId,
    motherName: motherName.trim(),
    motherLink: motherLink.trim(),
    isDeceased: Boolean(isDeceased),
    deathYear: deathYear.trim(),
    registeredViaMainForm: Boolean(registeredViaMainForm)
  };
  people.push(created);
  return created;
}

function buildMemberName(entry, fatherName, family) {
  const cleaned = cleanNameText(entry);
  if (!cleaned) return "";
  if (cleaned.split(/\s+/).length >= 2 && !/^عبد\s+\S+$/u.test(cleaned)) {
    return cleaned;
  }
  const fatherPart = getFirstName(cleanNameText(fatherName));
  const famClean = (family || "").trim();
  return [cleaned, fatherPart, famClean]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function updateMatchAlert() {
  const nameVal = document.getElementById("full-name").value;
  const fatherVal = document.getElementById("father-name").value;
  const grandVal = document.getElementById("grandfather-name").value;
  const alertEl = document.getElementById("match-alert");
  const grandAlertEl = document.getElementById("grand-alert");

  const cleanTarget = cleanNameText(nameVal);
  if (!cleanTarget) {
    alertEl.textContent = "";
  } else {
    const fatherMatch = cleanNameText(fatherVal) ? findExistingPerson(fatherVal) : null;
    const match = findExistingPerson(cleanTarget, fatherMatch ? fatherMatch.id : null);

    if (match) {
      alertEl.textContent = `⚠️ موجود مسبقاً (${getLineageSummary(match)})، سيتم الربط والدمج بنفس النسب دون تكرار.`;
    } else {
      const lineagePreview = [
        cleanTarget,
        cleanNameText(fatherVal) ? `ابن ${cleanNameText(fatherVal)}` : "",
        cleanNameText(grandVal) ? `بن ${cleanNameText(grandVal)}` : ""
      ]
        .filter(Boolean)
        .join(" ← ");
      alertEl.textContent = `✓ سيتم تسجيله ونسبه إلى: ${lineagePreview}`;
    }
  }

  const cleanGrand = cleanNameText(grandVal);
  if (!cleanGrand) {
    grandAlertEl.textContent = "";
    return;
  }

  const grandMatch = findExistingPerson(cleanGrand);
  if (grandMatch) {
    const kidsCount = people.filter((p) => p.fatherId === grandMatch.id).length;
    const fams = (grandMatch.families && grandMatch.families.length ? grandMatch.families : [grandMatch.family]).filter(Boolean);
    grandAlertEl.textContent = `🔗 جد مسجّل مسبقاً (${getLineageSummary(grandMatch)}) — أبناؤه: ${kidsCount}${
      fams.length ? ` | العوائل: ${fams.join("، ")}` : ""
    }. سيتم التقاء الفروع عنده إذا كان نفس الجد.`;
  } else {
    grandAlertEl.textContent = "";
  }
}

const deceasedCheckbox = document.getElementById("is-deceased-input");
const deathYearGroup = document.getElementById("death-year-group");
if (deceasedCheckbox && deathYearGroup) {
  deceasedCheckbox.addEventListener("change", () => {
    deathYearGroup.style.display = deceasedCheckbox.checked ? "block" : "none";
  });
}

document.getElementById("person-form").addEventListener("submit", (e) => {
  e.preventDefault();

  const sect = document.getElementById("sect-input").value.trim();
  const family = document.getElementById("family-input").value.trim();
  const fullName = document.getElementById("full-name").value.trim();
  const birthYear = document.getElementById("birth-year").value.trim();
  const isDeceased = document.getElementById("is-deceased-input")?.checked || false;
  const deathYear = document.getElementById("death-year-input")?.value.trim() || "";
  const fatherName = document.getElementById("father-name").value.trim();
  const grandfatherName = document.getElementById("grandfather-name").value.trim();
  const motherName = document.getElementById("mother-name").value.trim();
  const motherLink = document.getElementById("mother-family").value.trim();
  const siblingsRaw = document.getElementById("siblings-input").value;
  const childrenRaw = document.getElementById("children-input").value;

  const grandfather = upsertPerson({
    fullName: grandfatherName,
    sect,
    family
  });

  const father = upsertPerson({
    fullName: fatherName,
    sect,
    family,
    fatherId: grandfather && grandfather.id ? grandfather.id : null
  });

  const person = upsertPerson({
    fullName,
    birthYear,
    sect,
    family,
    fatherId: father && father.id ? father.id : null,
    motherName,
    motherLink,
    isDeceased,
    deathYear,
    registeredViaMainForm: true
  });

  siblingsRaw
    .split(/[،,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((sibEntry) => {
      const sibName = buildMemberName(sibEntry, fatherName, family);
      upsertPerson({
        fullName: sibName,
        sect,
        family,
        fatherId: father ? father.id : null,
        motherName,
        motherLink
      });
    });

  childrenRaw
    .split(/[،,]/)
    .map((c) => c.trim())
    .filter(Boolean)
    .forEach((childEntry) => {
      const childName = buildMemberName(childEntry, fullName, family);
      upsertPerson({
        fullName: childName,
        sect,
        family,
        fatherId: person ? person.id : null
      });
    });

  savePeople();
  e.target.reset();
  if (deathYearGroup) deathYearGroup.style.display = "none";
  document.getElementById("match-alert").textContent = "";
  document.getElementById("grand-alert").textContent = "";

  expandedPersonId = person ? person.id : null;
  refreshAll();
  switchTab("tree-view");
});

document.getElementById("full-name").addEventListener("input", updateMatchAlert);
document.getElementById("father-name").addEventListener("input", updateMatchAlert);
document.getElementById("grandfather-name").addEventListener("input", updateMatchAlert);

function personMatchesGroupFilter(person) {
  const personSects = person.sects && person.sects.length ? person.sects : [person.sect].filter(Boolean);
  const personFamilies = person.families && person.families.length ? person.families : [person.family].filter(Boolean);

  if (selectedSectFilter && !personSects.includes(selectedSectFilter)) {
    return false;
  }
  if (selectedFamilyFilter && !personFamilies.includes(selectedFamilyFilter)) {
    return false;
  }
  return true;
}

function renderGroupFilterControls() {
  const sectSelect = document.getElementById("filter-sect-select");
  const familySelect = document.getElementById("filter-family-select");
  const summaryEl = document.getElementById("filter-summary");

  const allSects = [
    ...new Set(
      people.flatMap((p) => (p.sects && p.sects.length ? p.sects : [p.sect]).filter(Boolean))
    )
  ];

  const scopedForFamilies = selectedSectFilter
    ? people.filter((p) => {
        const sList = p.sects && p.sects.length ? p.sects : [p.sect].filter(Boolean);
        return sList.includes(selectedSectFilter);
      })
    : people;

  const allFamilies = [
    ...new Set(
      scopedForFamilies.flatMap((p) =>
        (p.families && p.families.length ? p.families : [p.family]).filter(Boolean)
      )
    )
  ];

  if (selectedSectFilter && !allSects.includes(selectedSectFilter)) {
    selectedSectFilter = "";
  }
  if (selectedFamilyFilter && !allFamilies.includes(selectedFamilyFilter)) {
    selectedFamilyFilter = "";
  }

  sectSelect.innerHTML =
    `<option value="">كل الطوائف (${allSects.length})</option>` +
    allSects.map((s) => `<option value="${escapeHtml(s)}" ${s === selectedSectFilter ? "selected" : ""}>${escapeHtml(s)}</option>`).join("");

  familySelect.innerHTML =
    `<option value="">كل العائلات (${allFamilies.length})</option>` +
    allFamilies.map((f) => `<option value="${escapeHtml(f)}" ${f === selectedFamilyFilter ? "selected" : ""}>${escapeHtml(f)}</option>`).join("");

  const matchingCount = people.filter(personMatchesGroupFilter).length;
  summaryEl.textContent = `الطوائف المسجلة: ${allSects.length} | العائلات المتاحة: ${allFamilies.length} | الأسماء المطابقة: ${matchingCount}`;

  const totalFamiliesAll = [
    ...new Set(
      people.flatMap((p) => (p.families && p.families.length ? p.families : [p.family]).filter(Boolean))
    )
  ].length;

  const statPeopleEl = document.getElementById("tree-stat-people");
  const statFamiliesEl = document.getElementById("tree-stat-families");
  if (statPeopleEl) statPeopleEl.textContent = people.length;
  if (statFamiliesEl) statFamiliesEl.textContent = totalFamiliesAll;
}

document.getElementById("filter-sect-select").addEventListener("change", (e) => {
  selectedSectFilter = e.target.value;
  selectedFamilyFilter = "";
  const matching = people.filter(personMatchesGroupFilter);
  if (matching.length > 0) {
    expandedPersonId = matching[0].id;
  }
  renderGroupFilterControls();
  renderTree();
});

document.getElementById("filter-family-select").addEventListener("change", (e) => {
  selectedFamilyFilter = e.target.value;
  const matching = people.filter(personMatchesGroupFilter);
  if (matching.length > 0) {
    expandedPersonId = matching[0].id;
  }
  renderGroupFilterControls();
  renderTree();
});

function getLineageChain(targetPerson) {
  const chain = [];
  let curr = targetPerson;
  const visited = new Set();
  while (curr && !visited.has(curr.id)) {
    visited.add(curr.id);
    chain.unshift(curr);
    curr = curr.fatherId ? people.find((p) => p.id === curr.fatherId) : null;
  }
  return chain;
}

function renderAncestorCard(person, isFocus = false) {
  const kidsCount = people.filter((p) => p.fatherId === person.id).length;
  const father = getPersonById(person.fatherId);
  const deceasedClass = person.isDeceased ? "is-deceased" : "";

  return `
    <div class="node-card ${isFocus ? "focus-node" : ""} ${deceasedClass}" data-id="${escapeHtml(person.id)}">
      <span class="node-name">${escapeHtml(person.fullName)}</span>
      ${father ? `<span class="node-meta">ابن ${escapeHtml(getFirstName(father.fullName))}</span>` : ""}
      ${person.birthYear ? `<span class="node-meta">${escapeHtml(person.birthYear)}</span>` : ""}
      <div class="node-badges">
        <span class="badge">${kidsCount > 0 ? "أبناؤه: " + kidsCount : "مغلق"}</span>
        ${person.isDeceased ? `<span class="badge badge-deceased">متوفى${person.deathYear ? " " + escapeHtml(person.deathYear) : ""}</span>` : ""}
      </div>
      <button type="button" class="node-info-btn" data-details="${escapeHtml(person.id)}">بطاقة</button>
    </div>
  `;
}

function renderChildCard(child) {
  const kidsCount = people.filter((p) => p.fatherId === child.id).length;
  const deceasedClass = child.isDeceased ? "is-deceased" : "";

  return `
    <div class="node-card ${deceasedClass}" data-id="${escapeHtml(child.id)}" title="${escapeHtml(getLineageSummary(child))}">
      <span class="node-name">${escapeHtml(child.fullName)}</span>
      <span class="node-badge">${child.isDeceased ? "متوفى" : kidsCount > 0 ? "أبناؤه: " + kidsCount : "مغلق"}</span>
    </div>
  `;
}

function renderLineageBar(chain) {
  const bar = document.getElementById("lineage-bar");
  if (!chain || chain.length === 0) {
    bar.innerHTML = "<span>السجل فارغ حالياً.</span>";
    return;
  }

  bar.innerHTML =
    `<span>النسب: </span>` +
    chain
      .map((item, idx) => {
        const isLast = idx === chain.length - 1;
        return `<button class="crumb-btn ${isLast ? "current" : ""}" data-id="${escapeHtml(item.id)}">${escapeHtml(getFirstName(item.fullName))}</button>`;
      })
      .join(" <span>‹</span> ");

  bar.querySelectorAll(".crumb-btn:not(.current)").forEach((btn) => {
    btn.addEventListener("click", () => {
      expandedPersonId = btn.dataset.id;
      renderTree();
    });
  });
}

function renderTree() {
  const canvas = document.getElementById("tree-canvas");
  const statGenEl = document.getElementById("tree-stat-generations");

  if (people.length === 0) {
    renderLineageBar([]);
    if (statGenEl) statGenEl.textContent = "0";
    canvas.innerHTML = "<p style='font-size:0.8rem; color:#656a5e; padding:24px;'>السجل فارغ. ابدأ بالإضافة من تبويب (➕ إضافة).</p>";
    return;
  }

  const filteredPool = people.filter(personMatchesGroupFilter);
  const candidatePool = people;
  const candidateIds = new Set(candidatePool.map((p) => p.id));
  const poolRoots = candidatePool.filter((p) => !p.fatherId || !candidateIds.has(p.fatherId));

  let activePerson = people.find((p) => p.id === expandedPersonId);
  if (!activePerson) {
    activePerson = filteredPool[0] || poolRoots[0] || people[0] || null;
    expandedPersonId = activePerson ? activePerson.id : null;
  }

  const chain = getLineageChain(activePerson);
  const children = people.filter((p) => p.fatherId === activePerson.id);
  if (statGenEl) {
    statGenEl.textContent = String(chain.length + (children.length > 0 ? 1 : 0));
  }

  renderLineageBar(chain);

  const chainHTML = chain
    .map((person, idx) => {
      const isLast = idx === chain.length - 1;
      return `
        <div class="ancestor-step">
          ${renderAncestorCard(person, isLast)}
          <div class="vertical-line"></div>
        </div>
      `;
    })
    .join("");

  let branchHTML = "";
  if (children.length > 0) {
    branchHTML = `
      <div class="branch-container">
        <div class="children-single-line">
          ${children
            .map(
              (child) => `
              <div class="child-item">
                ${renderChildCard(child)}
              </div>
            `
            )
            .join("")}
        </div>
        <div class="branch-label">أبناء (${escapeHtml(getFirstName(activePerson.fullName))}) - العدد: ${children.length}</div>
      </div>
    `;
  } else {
    branchHTML = `<div class="branch-label">لا يوجد أبناء مسجلون لـ (${escapeHtml(getFirstName(activePerson.fullName))})</div>`;
  }

  canvas.innerHTML = chainHTML + branchHTML;

  canvas.querySelectorAll(".node-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.classList.contains("node-info-btn")) return;
      const clickedId = card.dataset.id;
      if (expandedPersonId === clickedId) {
        openManageModal(clickedId, "new-form");
      } else {
        expandedPersonId = clickedId;
        renderTree();
      }
    });
  });

  canvas.querySelectorAll(".node-info-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openManageModal(btn.dataset.details, "new-form");
    });
  });
}

function canAddChildUnder(personObj) {
  if (adminUnlocked) return true;
  if (personObj && personObj.registeredViaMainForm) return true;
  alert("يرجى أولاً تسجيل بيانات الشخص وأبيه في الاستمارة الأساسية (➕ إضافة)، ثم العودة لإضافة الأبناء أو تحديد الوفاة.");
  return false;
}

function openManageModal(personId, defaultMode = "new-form") {
  const p = getPersonById(personId);
  if (!p) return;

  const sectsList = (p.sects && p.sects.length ? p.sects : [p.sect]).filter(Boolean);
  const familiesList = (p.families && p.families.length ? p.families : [p.family]).filter(Boolean);

  document.getElementById("modal-content").innerHTML = `
    <h3 style="color: var(--primary-dark); margin-bottom: 4px; font-size: 1rem;">${escapeHtml(p.fullName)}</h3>
    <div class="detail-row"><strong>سلسلة النسب:</strong> ${escapeHtml(getLineageSummary(p))}</div>
    <div class="detail-row"><strong>الطائفة / العائلة:</strong> ${escapeHtml(sectsList.join("، ") || "-")} — ${escapeHtml(familiesList.join("، ") || "-")}</div>

    <div class="modal-action-tabs">
      <button type="button" class="modal-sub-btn ${defaultMode === "new-form" ? "active" : ""}" data-mode="new-form">نموذج تسجيل فارغ</button>
      <button type="button" class="modal-sub-btn ${defaultMode === "add-child" ? "active" : ""}" data-mode="add-child">تسجيل ولد جديد</button>
      <button type="button" class="modal-sub-btn ${defaultMode === "stillborn" ? "active" : ""}" data-mode="stillborn">تسجيل طفل ميت</button>
    </div>

    <div id="modal-panel-new-form" style="display: ${defaultMode === "new-form" ? "block" : "none"};">
      <form id="card-blank-form" class="form-grid">
        <div class="form-group">
          <label>الطائفة</label>
          <input type="text" id="card-sect" value="" />
        </div>
        <div class="form-group">
          <label>العائلة / الفخذ</label>
          <input type="text" id="card-family" value="" />
        </div>
        <div class="form-group">
          <label>الاسم الثلاثي *</label>
          <input type="text" id="card-fullname" value="" required />
        </div>
        <div class="form-group">
          <label>سنة / تاريخ الميلاد</label>
          <input type="text" id="card-birth" value="" />
        </div>
        <div class="form-group">
          <label>اسم الأب الثلاثي</label>
          <input type="text" id="card-father" value="" />
        </div>
        <div class="form-group">
          <label>اسم الجد الثلاثي</label>
          <input type="text" id="card-grand" value="" />
        </div>
        <div class="form-group">
          <label>اسم الأم الثلاثي</label>
          <input type="text" id="card-mother" value="" />
        </div>
        <div class="form-group">
          <label>عائلة / طائفة الأم</label>
          <input type="text" id="card-mother-link" value="" />
        </div>
        <div class="form-group full-width form-actions">
          <button type="submit" class="btn-primary">موافق</button>
        </div>
      </form>
    </div>

    <div id="modal-panel-add-child" style="display: ${defaultMode === "add-child" ? "block" : "none"};">
      <form id="add-child-form" class="form-grid">
        <div class="form-group full-width">
          <label>اسم الولد الجديد *</label>
          <input type="text" id="new-child-name" value="" required />
        </div>
        <div class="form-group">
          <label>سنة / تاريخ الميلاد</label>
          <input type="text" id="new-child-birth" value="" />
        </div>
        <div class="form-group">
          <label>اسم الأم (اختياري)</label>
          <input type="text" id="new-child-mother" value="" />
        </div>
        <div class="form-group full-width form-actions">
          <button type="submit" class="btn-primary">موافق</button>
        </div>
      </form>
    </div>

    <div id="modal-panel-stillborn" style="display: ${defaultMode === "stillborn" ? "block" : "none"};">
      <form id="stillborn-child-form" class="form-grid">
        <div class="form-group full-width">
          <label>اسم الطفل (أو طفل ميت) *</label>
          <input type="text" id="stillborn-name" value="" required />
        </div>
        <div class="form-group">
          <label>سنة / تاريخ الميلاد أو الوفاة</label>
          <input type="text" id="stillborn-year" value="" />
        </div>
        <div class="form-group">
          <label>اسم الأم (اختياري)</label>
          <input type="text" id="stillborn-mother" value="" />
        </div>
        <div class="form-group full-width form-actions">
          <button type="submit" class="btn-primary">موافق</button>
        </div>
      </form>
    </div>
  `;

  document.querySelectorAll(".modal-sub-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode;
      document.querySelectorAll(".modal-sub-btn").forEach((b) => b.classList.toggle("active", b === btn));
      document.getElementById("modal-panel-new-form").style.display = mode === "new-form" ? "block" : "none";
      document.getElementById("modal-panel-add-child").style.display = mode === "add-child" ? "block" : "none";
      document.getElementById("modal-panel-stillborn").style.display = mode === "stillborn" ? "block" : "none";
    });
  });

  const blankForm = document.getElementById("card-blank-form");
  if (blankForm) {
    blankForm.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const newSect = document.getElementById("card-sect").value.trim() || p.sect;
      const newFamily = document.getElementById("card-family").value.trim() || p.family;
      const newFullName = cleanNameText(document.getElementById("card-fullname").value);
      const newBirth = document.getElementById("card-birth").value.trim();
      const newFatherName = document.getElementById("card-father").value.trim();
      const newGrandName = document.getElementById("card-grand").value.trim();
      const newMother = document.getElementById("card-mother").value.trim();
      const newMotherLink = document.getElementById("card-mother-link").value.trim();

      if (!newFullName) return;

      let grandRecord = null;
      if (newGrandName) {
        grandRecord = upsertPerson({
          fullName: newGrandName,
          sect: newSect,
          family: newFamily
        });
      }

      let fatherRecord = null;
      if (newFatherName) {
        fatherRecord = upsertPerson({
          fullName: newFatherName,
          sect: newSect,
          family: newFamily,
          fatherId: grandRecord && grandRecord.id ? grandRecord.id : null
        });
      }

      const createdOrLinked = upsertPerson({
        fullName: newFullName,
        birthYear: newBirth,
        sect: newSect,
        family: newFamily,
        fatherId: fatherRecord && fatherRecord.id ? fatherRecord.id : p.id,
        motherName: newMother,
        motherLink: newMotherLink
      });

      expandedPersonId = createdOrLinked ? createdOrLinked.id : p.id;
      savePeople();
      refreshAll();
      document.getElementById("details-modal").classList.remove("open");
    });
  }

  const addChildForm = document.getElementById("add-child-form");
  if (addChildForm) {
    addChildForm.addEventListener("submit", (ev) => {
      ev.preventDefault();
      if (!canAddChildUnder(p)) return;

      const rawChild = document.getElementById("new-child-name").value.trim();
      const childBirth = document.getElementById("new-child-birth").value.trim();
      const childMother = document.getElementById("new-child-mother").value.trim();
      if (!rawChild) return;

      const childFullName = buildMemberName(rawChild, p.fullName, p.family);
      upsertPerson({
        fullName: childFullName,
        birthYear: childBirth,
        sect: p.sect,
        family: p.family,
        fatherId: p.id,
        motherName: childMother,
        motherLink: p.motherLink
      });

      expandedPersonId = p.id;
      savePeople();
      refreshAll();
      document.getElementById("details-modal").classList.remove("open");
    });
  }

  const stillbornForm = document.getElementById("stillborn-child-form");
  if (stillbornForm) {
    stillbornForm.addEventListener("submit", (ev) => {
      ev.preventDefault();
      if (!canAddChildUnder(p)) return;

      const rawStillborn = document.getElementById("stillborn-name").value.trim();
      const yearVal = document.getElementById("stillborn-year").value.trim();
      const motherVal = document.getElementById("stillborn-mother").value.trim();
      if (!rawStillborn) return;

      const childFullName = buildMemberName(rawStillborn, p.fullName, p.family);
      upsertPerson({
        fullName: childFullName,
        birthYear: yearVal,
        sect: p.sect,
        family: p.family,
        fatherId: p.id,
        motherName: motherVal,
        motherLink: p.motherLink,
        isDeceased: true,
        deathYear: yearVal
      });

      expandedPersonId = p.id;
      savePeople();
      refreshAll();
      document.getElementById("details-modal").classList.remove("open");
    });
  }

  document.getElementById("details-modal").classList.add("open");
}

window.focusPersonInTree = function (id) {
  expandedPersonId = id;
  switchTab("tree-view");
  renderTree();
};

window.deleteSinglePerson = function (id) {
  if (!adminUnlocked) {
    if (!ensureAdminAccess()) return;
  }
  const target = people.find((p) => p.id === id);
  if (!target) return;

  people.forEach((p) => {
    if (p.fatherId === id) {
      p.fatherId = target.fatherId || null;
    }
  });

  people = people.filter((p) => p.id !== id);
  if (expandedPersonId === id) {
    expandedPersonId = target.fatherId || (people[0] ? people[0].id : null);
  }

  savePeople([id]);
  refreshAll();
};

function renderListsAndStats() {
  const sects = [
    ...new Set(
      people.flatMap((p) => (p.sects && p.sects.length ? p.sects : [p.sect]).filter(Boolean))
    )
  ];
  const families = [
    ...new Set(
      people.flatMap((p) => (p.families && p.families.length ? p.families : [p.family]).filter(Boolean))
    )
  ];

  const sectsListEl = document.getElementById("sects-list");
  const familiesListEl = document.getElementById("families-list");
  if (sectsListEl) sectsListEl.innerHTML = sects.map((s) => `<option value="${escapeHtml(s)}">`).join("");
  if (familiesListEl) familiesListEl.innerHTML = families.map((f) => `<option value="${escapeHtml(f)}">`).join("");

  const totalCountEl = document.getElementById("total-count");
  if (totalCountEl) totalCountEl.textContent = people.length;

  const bottomCountEl = document.getElementById("bottom-total-count");
  if (bottomCountEl) bottomCountEl.textContent = people.length;

  document.querySelectorAll(".bottom-nav .bottom-btn").forEach((btn) => {
    if (/سجل/i.test(btn.textContent)) {
      btn.innerHTML = btn.innerHTML.replace(/\(\d+\)/, `(${people.length})`);
    }
  });

  const adminCountEl = document.getElementById("admin-count");
  const adminSectsEl = document.getElementById("admin-sects-count");
  const adminFamiliesEl = document.getElementById("admin-families-count");
  if (adminCountEl) adminCountEl.textContent = people.length;
  if (adminSectsEl) adminSectsEl.textContent = sects.length;
  if (adminFamiliesEl) adminFamiliesEl.textContent = families.length;

  const tbody = document.getElementById("records-tbody");
  if (tbody) {
    tbody.innerHTML = people
      .map((p) => {
        const father = people.find((x) => x.id === p.fatherId);
        const grand = father ? people.find((x) => x.id === father.fatherId) : null;
        const famsText = (p.families && p.families.length ? p.families : [p.family]).filter(Boolean).join("، ");
        const sectsText = (p.sects && p.sects.length ? p.sects : [p.sect]).filter(Boolean).join("، ");
        const statusSuffix = p.isDeceased ? ` (متوفى${p.deathYear ? " " + p.deathYear : ""})` : "";
        return `
          <tr>
            <td><strong>${escapeHtml(p.fullName)}</strong>${escapeHtml(statusSuffix)}</td>
            <td>${escapeHtml(father ? father.fullName : "—")}</td>
            <td>${escapeHtml(grand ? grand.fullName : "—")}</td>
            <td>${escapeHtml(famsText || "—")}</td>
            <td>${escapeHtml(sectsText || "—")}</td>
            <td>${escapeHtml(p.birthYear || "—")}</td>
            <td>
              <div class="row-actions">
                <button type="button" class="node-info-btn" data-open-id="${escapeHtml(p.id)}">فتح</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");

    tbody.querySelectorAll("[data-open-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        window.focusPersonInTree(btn.getAttribute("data-open-id"));
      });
    });
  }

  const adminTbody = document.getElementById("admin-records-tbody");
  if (adminTbody) {
    adminTbody.innerHTML = people
      .map((p) => {
        const father = people.find((x) => x.id === p.fatherId);
        const grand = father ? people.find((x) => x.id === father.fatherId) : null;
        const famsText = (p.families && p.families.length ? p.families : [p.family]).filter(Boolean).join("، ");
        const delBtn = adminUnlocked
          ? `<button type="button" class="row-del-btn" data-del-id="${escapeHtml(p.id)}">حذف</button>`
          : `<span style="font-size:0.65rem;color:#656a5e;">مقفل</span>`;
        return `
          <tr>
            <td><strong>${escapeHtml(p.fullName)}</strong></td>
            <td>${escapeHtml(father ? father.fullName : "—")}</td>
            <td>${escapeHtml(grand ? grand.fullName : "—")}</td>
            <td>${escapeHtml(famsText || "—")}</td>
            <td>${delBtn}</td>
          </tr>
        `;
      })
      .join("");

    adminTbody.querySelectorAll(".row-del-btn[data-del-id]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.deleteSinglePerson(btn.getAttribute("data-del-id"));
      });
    });
  }
}

function ensureAdminAccess() {
  if (!ADMIN_PASSCODE) {
    adminUnlocked = true;
    return true;
  }
  if (adminUnlocked) return true;
  const entered = prompt("أدخل كلمة سر الإدارة:");
  if (entered === ADMIN_PASSCODE) {
    adminUnlocked = true;
    refreshAll();
    return true;
  }
  alert("كلمة السر غير صحيحة.");
  return false;
}

const tabAliasMap = {
  tree: "tree-view",
  add: "form-view",
  records: "list-view",
  admin: "admin-view"
};

function resolveTabId(rawTab) {
  if (!rawTab) return null;
  if (document.getElementById(rawTab)) return rawTab;
  return tabAliasMap[rawTab] || null;
}

function switchTab(rawTabId) {
  const tabId = resolveTabId(rawTabId);
  if (!tabId) return;

  if (tabId === "admin-view" && !ensureAdminAccess()) {
    return;
  }

  document.querySelectorAll(".tab-btn, .bottom-nav .bottom-btn").forEach((b) => {
    const mapped = resolveTabId(b.dataset.tab);
    b.classList.toggle("active", mapped === tabId);
  });

  document.querySelectorAll(".tab-panel").forEach((p) => {
    p.classList.toggle("active", p.id === tabId);
  });
}

document.querySelectorAll(".tab-btn, .bottom-nav .bottom-btn").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    switchTab(btn.dataset.tab);
  });
});

document.getElementById("admin-broadcast-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!ensureAdminAccess()) return;

  const tickerVal = document.getElementById("admin-ticker-input").value.trim();
  let mediaType = document.getElementById("admin-media-type").value;
  const mediaUrl = document.getElementById("admin-media-url").value.trim();
  const fileInput = document.getElementById("admin-media-file");
  const file = fileInput && fileInput.files ? fileInput.files[0] : null;

  if (tickerVal) {
    broadcastState.tickerText = tickerVal;
  }

  if (mediaType === "none" && (file || mediaUrl)) {
    if (file) {
      mediaType = file.type.startsWith("video/") ? "video" : "image";
    } else if (/\.(mp4|webm|ogg)(\?|$)/i.test(mediaUrl)) {
      mediaType = "video";
    } else {
      mediaType = "image";
    }
  }

  const finalizePublish = (resolvedSrc) => {
    if (mediaType === "none") {
      broadcastState.mediaType = "none";
      broadcastState.mediaSrc = "";
    } else if (resolvedSrc && isSafeMediaSrc(resolvedSrc)) {
      broadcastState.mediaType = mediaType;
      broadcastState.mediaSrc = resolvedSrc;
    }

    saveBroadcast(true);
    renderBroadcast();
    document.getElementById("admin-status").textContent = "تم نشر التحديث للجميع بنجاح.";
  };

  if (file) {
    const reader = new FileReader();
    reader.onload = () => finalizePublish(String(reader.result || ""));
    reader.readAsDataURL(file);
  } else {
    finalizePublish(mediaUrl);
  }
});

document.getElementById("clear-media-btn").addEventListener("click", () => {
  if (!ensureAdminAccess()) return;
  broadcastState.mediaType = "none";
  broadcastState.mediaSrc = "";
  saveBroadcast(true);
  renderBroadcast();
  document.getElementById("admin-status").textContent = "تم إخفاء الصورة / الفيديو عن الجميع.";
});

document.getElementById("close-modal").addEventListener("click", () => {
  document.getElementById("details-modal").classList.remove("open");
});

document.getElementById("details-modal").addEventListener("click", (e) => {
  if (e.target.id === "details-modal") {
    e.target.classList.remove("open");
  }
});

function refreshAll() {
  renderBroadcast();
  renderGroupFilterControls();
  renderListsAndStats();
  renderTree();
}

function startCloudSync() {
  if (!window.juzoorDb) return;

  const db = window.juzoorDb;

  db.collection(FIRESTORE_PEOPLE_COLLECTION).onSnapshot(
    (snapshot) => {
      const cloudPeople = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        const docId = String((data && data.id) || doc.id);
        if (data && !deletedIdsSinceSync.has(docId)) {
          cloudPeople.push(normalizePersonRecord({ ...data, id: docId }));
        }
      });

      if (cloudPeople.length > 0) {
        isSyncingFromCloud = true;
        people = cloudPeople;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(people));
        refreshAll();
        isSyncingFromCloud = false;
      } else if (!snapshot.empty && snapshot.size === 0 && people.length > 0) {
        savePeople();
      }
    },
    (err) => {
      console.error("Firestore people listener error:", err);
    }
  );

  db.doc(FIRESTORE_BROADCAST_DOC).onSnapshot(
    (docSnap) => {
      if (!docSnap.exists) return;
      const data = docSnap.data() || {};
      isSyncingBroadcastFromCloud = true;
      broadcastState = {
        tickerText: data.tickerText || broadcastState.tickerText,
        mediaType: data.mediaType || "none",
        mediaSrc: isSafeMediaSrc(data.mediaSrc) ? data.mediaSrc : ""
      };
      saveBroadcast(false);
      renderBroadcast();
      isSyncingBroadcastFromCloud = false;
    },
    (err) => {
      console.error("Firestore broadcast listener error:", err);
    }
  );
}

refreshAll();

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startCloudSync);
} else {
  startCloudSync();
}

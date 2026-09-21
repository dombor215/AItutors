// ===================== PDF.js worker =====================
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// ===================== State =====================
let sessionStartTime = null;
let isProcessing = false;
let currentTypingEl = null;
let attachedFiles = [];
let pastedInCurrentInput = false;

const chatBox = document.getElementById("chat");
const input = document.getElementById("messageInput");
const sendBtn = document.getElementById("sendBtn");
const attachBtn = document.getElementById("attachBtn");
const drawBtn = document.getElementById("drawBtn");
const fileUpload = document.getElementById("fileUpload");
const attachmentArea = document.getElementById("attachmentArea");

let messages = [];

// ===================== Draw / Canvas State =====================
let drawCtx = null;
let canvasIsDrawing = false;
let lastDrawX = 0;
let lastDrawY = 0;
let currentPenColor = '#000';
let isEraserActive = false;

// ===================== Timestamp Helpers =====================
function formatTimestamp(isoString) {
  if (!isoString) return "";
  var date = new Date(isoString);
  if (isNaN(date.getTime())) return "";
  var now = new Date();
  var isToday = date.toDateString() === now.toDateString();
  var timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isToday) return timeStr;
  var dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  return dateStr + ', ' + timeStr;
}

function createTimestampEl(timestamp) {
  var el = document.createElement("div");
  el.className = "message-timestamp";
  el.textContent = formatTimestamp(timestamp);
  el.setAttribute("data-iso", timestamp);
  return el;
}

// ===================== Copy-Paste token (integrity check) =====================
async function generatePasteToken(timestamp, content, wasPasted) {
  const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
  const payload = timestamp + '|' + contentStr + '|' + (wasPasted ? '1' : '0');
  const buf = new TextEncoder().encode(payload);
  const hashBuffer = await crypto.subtle.digest('SHA-1', buf);
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex.slice(0, 12);
}

// Audit helpers — use from the browser console.
async function decodePasteToken(message) {
  if (!message || !message.token) return 'no-token';
  const tFalse = await generatePasteToken(message.timestamp, message.content, false);
  if (tFalse === message.token) return 'typed';
  const tTrue = await generatePasteToken(message.timestamp, message.content, true);
  if (tTrue === message.token) return 'pasted';
  return 'tampered';
}

async function auditChatTokens(chatJson) {
  const msgs = Array.isArray(chatJson) ? chatJson : (chatJson.messages || []);
  const out = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== 'user') continue;
    out.push({ index: i, timestamp: m.timestamp, status: await decodePasteToken(m) });
  }
  console.table(out);
  return out;
}

window.decodePasteToken = decodePasteToken;
window.auditChatTokens = auditChatTokens;

// Keep chat scrolled to bottom when mobile keyboard opens/closes (visual viewport change)
if (window.visualViewport) {
  let lastVH = window.visualViewport.height;
  window.visualViewport.addEventListener('resize', () => {
    const diff = lastVH - window.visualViewport.height;
    // Keyboard likely opened (shrinking viewport). Keep near-bottom view.
    if (Math.abs(diff) > 100) {
      setTimeout(() => { chatBox.scrollTop = chatBox.scrollHeight; }, 50);
    }
    lastVH = window.visualViewport.height;
  });
}

// ===================== Toast =====================
function showToast(msg, duration = 3000) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove("show"), duration);
}

// ===================== File Type Detection =====================
const IMAGE_TYPES = ["image/png","image/jpeg","image/jpg","image/gif","image/webp","image/bmp","image/svg+xml"];
const TEXT_EXTENSIONS = [
  "txt","md","csv","json","xml","html","htm","css","js","ts","jsx","tsx",
  "py","java","c","cpp","h","hpp","cs","rb","go","rs","swift","kt",
  "sh","bat","ps1","yaml","yml","toml","ini","cfg","conf","log","sql",
  "r","m","pl","php","lua","scala","hs","erl","ex","exs","vue","svelte",
  "dockerfile","makefile","gitignore","env"
];
const DOCUMENT_EXTENSIONS = ["docx","odt","pptx","odp","xlsx","ods","pdf"];

function getExtension(filename) { return filename.split(".").pop().toLowerCase(); }
function isImageFile(file) { return IMAGE_TYPES.includes(file.type) || file.type.startsWith("image/"); }
function isTextFile(file) {
  if (file.type.startsWith("text/") || file.type === "application/json" || file.type === "application/xml" || file.type === "application/javascript") return true;
  return TEXT_EXTENSIONS.includes(getExtension(file.name));
}
function isDocumentFile(file) { return DOCUMENT_EXTENSIONS.includes(getExtension(file.name)); }

// ===================== File Readers =====================
function readFileAsDataURL(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); }); }
function readFileAsText(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(file); }); }
function readFileAsArrayBuffer(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsArrayBuffer(file); }); }

// ===================== ODF Helpers =====================
function odfCollectText(node) {
  let text = "";
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      text += child.textContent;
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const ln = child.localName;
      if (ln === "tab") text += "\t";
      else if (ln === "s") { text += " ".repeat(parseInt(child.getAttribute("text:c") || child.getAttribute("c")) || 1); }
      else if (ln === "line-break") text += "\n";
      else text += odfCollectText(child);
    }
  }
  return text;
}

function odfFindParagraphs(node, paragraphs) {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      if (child.localName === "p" || child.localName === "h") {
        paragraphs.push(odfCollectText(child));
      } else {
        odfFindParagraphs(child, paragraphs);
      }
    }
  }
}

// ===================== DOCX =====================
async function extractDocx(file) {
  const zip = await JSZip.loadAsync(await readFileAsArrayBuffer(file));
  const docXml = zip.file("word/document.xml");
  if (!docXml) throw new Error("No word/document.xml found");
  const xmlDoc = new DOMParser().parseFromString(await docXml.async("string"), "application/xml");
  const body = xmlDoc.getElementsByTagName("w:body")[0];
  if (!body) throw new Error("No w:body found");

  const paragraphs = [];
  const pElements = body.getElementsByTagName("w:p");
  for (let i = 0; i < pElements.length; i++) {
    const p = pElements[i];
    let pText = "";
    const runs = p.getElementsByTagName("w:r");
    for (let j = 0; j < runs.length; j++) {
      if (runs[j].getElementsByTagName("w:tab").length > 0) pText += "\t";
      const tEls = runs[j].getElementsByTagName("w:t");
      for (let k = 0; k < tEls.length; k++) pText += tEls[k].textContent;
    }
    const hyperlinks = p.getElementsByTagName("w:hyperlink");
    for (let j = 0; j < hyperlinks.length; j++) {
      const hlRuns = hyperlinks[j].getElementsByTagName("w:r");
      for (let k = 0; k < hlRuns.length; k++) {
        const tEls = hlRuns[k].getElementsByTagName("w:t");
        for (let l = 0; l < tEls.length; l++) pText += tEls[l].textContent;
      }
    }
    paragraphs.push(pText);
  }
  return paragraphs.join("\n");
}

// ===================== ODT =====================
async function extractOdt(file) {
  const zip = await JSZip.loadAsync(await readFileAsArrayBuffer(file));
  const contentXml = zip.file("content.xml");
  if (!contentXml) throw new Error("No content.xml found");
  const xmlDoc = new DOMParser().parseFromString(await contentXml.async("string"), "application/xml");
  const paragraphs = [];
  odfFindParagraphs(xmlDoc.documentElement, paragraphs);
  return paragraphs.join("\n");
}

// ===================== PPTX =====================
async function extractPptx(file) {
  const zip = await JSZip.loadAsync(await readFileAsArrayBuffer(file));
  const slideFiles = [];
  zip.forEach((path) => {
    const m = path.match(/^ppt\/slides\/slide(\d+)\.xml$/);
    if (m) slideFiles.push({ num: parseInt(m[1]), path });
  });
  slideFiles.sort((a, b) => a.num - b.num);

  const slides = [];
  for (const sf of slideFiles) {
    const xmlDoc = new DOMParser().parseFromString(await zip.file(sf.path).async("string"), "application/xml");
    const paragraphs = xmlDoc.getElementsByTagName("a:p");
    const lines = [];
    for (let i = 0; i < paragraphs.length; i++) {
      const tEls = paragraphs[i].getElementsByTagName("a:t");
      let line = "";
      for (let j = 0; j < tEls.length; j++) line += tEls[j].textContent;
      if (line.trim()) lines.push(line);
    }
    if (lines.length > 0) slides.push(`--- Slide ${sf.num} ---\n${lines.join("\n")}`);
  }
  return slides.join("\n\n");
}

// ===================== ODP =====================
async function extractOdp(file) {
  const zip = await JSZip.loadAsync(await readFileAsArrayBuffer(file));
  const contentXml = zip.file("content.xml");
  if (!contentXml) throw new Error("No content.xml found");
  const xmlDoc = new DOMParser().parseFromString(await contentXml.async("string"), "application/xml");

  const pages = [];
  function findPages(node) {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.localName === "page") {
          const paragraphs = [];
          odfFindParagraphs(child, paragraphs);
          const textLines = paragraphs.filter(p => p.trim());
          if (textLines.length > 0) {
            const name = child.getAttribute("draw:name") || `Slide ${pages.length + 1}`;
            pages.push(`--- ${name} ---\n${textLines.join("\n")}`);
          }
        } else { findPages(child); }
      }
    }
  }
  findPages(xmlDoc.documentElement);
  return pages.join("\n\n");
}

// ===================== XLSX =====================
function xlsxColToIndex(colStr) {
  let idx = 0;
  for (let i = 0; i < colStr.length; i++) idx = idx * 26 + (colStr.charCodeAt(i) - 64);
  return idx - 1;
}

async function extractXlsx(file) {
  const zip = await JSZip.loadAsync(await readFileAsArrayBuffer(file));
  const parser = new DOMParser();

  const sharedStrings = [];
  const ssFile = zip.file("xl/sharedStrings.xml");
  if (ssFile) {
    const ssDoc = parser.parseFromString(await ssFile.async("string"), "application/xml");
    const siEls = ssDoc.getElementsByTagName("si");
    for (let i = 0; i < siEls.length; i++) {
      const tEls = siEls[i].getElementsByTagName("t");
      let t = "";
      for (let j = 0; j < tEls.length; j++) t += tEls[j].textContent;
      sharedStrings.push(t);
    }
  }

  const sheetNames = [];
  const wbFile = zip.file("xl/workbook.xml");
  if (wbFile) {
    const wbDoc = parser.parseFromString(await wbFile.async("string"), "application/xml");
    const sheetEls = wbDoc.getElementsByTagName("sheet");
    for (let i = 0; i < sheetEls.length; i++) sheetNames.push(sheetEls[i].getAttribute("name") || `Sheet ${i + 1}`);
  }

  const sheetFiles = [];
  zip.forEach((path) => {
    const m = path.match(/^xl\/worksheets\/sheet(\d+)\.xml$/);
    if (m) sheetFiles.push({ num: parseInt(m[1]), path });
  });
  sheetFiles.sort((a, b) => a.num - b.num);

  const sheets = [];
  for (const sf of sheetFiles) {
    const xmlDoc = parser.parseFromString(await zip.file(sf.path).async("string"), "application/xml");
    const rows = xmlDoc.getElementsByTagName("row");
    const rowTexts = [];
    for (let i = 0; i < rows.length; i++) {
      const cells = rows[i].getElementsByTagName("c");
      const cellMap = {};
      let maxCol = -1;
      for (let j = 0; j < cells.length; j++) {
        const cell = cells[j];
        const ref = cell.getAttribute("r") || "";
        const colMatch = ref.match(/^([A-Z]+)/);
        const colIdx = colMatch ? xlsxColToIndex(colMatch[1]) : j;
        if (colIdx > maxCol) maxCol = colIdx;
        const type = cell.getAttribute("t");
        const vEl = cell.getElementsByTagName("v")[0];
        let value = "";
        if (vEl) {
          value = (type === "s") ? (sharedStrings[parseInt(vEl.textContent)] || "") : vEl.textContent;
        } else {
          const isEl = cell.getElementsByTagName("is")[0];
          if (isEl) {
            const tEls = isEl.getElementsByTagName("t");
            for (let k = 0; k < tEls.length; k++) value += tEls[k].textContent;
          }
        }
        cellMap[colIdx] = value;
      }
      const rowArr = [];
      for (let c = 0; c <= maxCol; c++) rowArr.push(cellMap[c] || "");
      if (rowArr.some(v => v.trim())) rowTexts.push(rowArr.join("\t"));
    }
    if (rowTexts.length > 0) {
      const name = sheetNames[sf.num - 1] || `Sheet ${sf.num}`;
      sheets.push(`--- ${name} ---\n${rowTexts.join("\n")}`);
    }
  }
  return sheets.join("\n\n");
}

// ===================== ODS =====================
async function extractOds(file) {
  const zip = await JSZip.loadAsync(await readFileAsArrayBuffer(file));
  const contentXml = zip.file("content.xml");
  if (!contentXml) throw new Error("No content.xml found");
  const xmlDoc = new DOMParser().parseFromString(await contentXml.async("string"), "application/xml");

  const sheets = [];

  function findTables(node) {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.localName === "table") {
          const tableName = child.getAttribute("table:name") || `Sheet ${sheets.length + 1}`;
          const rows = [];
          processRows(child, rows);
          if (rows.length > 0) sheets.push(`--- ${tableName} ---\n${rows.join("\n")}`);
        } else { findTables(child); }
      }
    }
  }

  function processRows(tableNode, rows) {
    for (const child of tableNode.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE && child.localName === "table-row") {
        const rowRepeat = parseInt(child.getAttribute("table:number-rows-repeated")) || 1;
        const cellValues = [];
        for (const cc of child.childNodes) {
          if (cc.nodeType === Node.ELEMENT_NODE && cc.localName === "table-cell") {
            const colRepeat = parseInt(cc.getAttribute("table:number-columns-repeated")) || 1;
            let cellText = "";
            for (const pc of cc.childNodes) {
              if (pc.nodeType === Node.ELEMENT_NODE && (pc.localName === "p" || pc.localName === "h")) {
                if (cellText) cellText += " ";
                cellText += odfCollectText(pc);
              }
            }
            const effectiveRepeat = (!cellText.trim() && colRepeat > 10) ? 0 : Math.min(colRepeat, 50);
            for (let r = 0; r < effectiveRepeat; r++) cellValues.push(cellText);
          }
        }
        while (cellValues.length > 0 && !cellValues[cellValues.length - 1].trim()) cellValues.pop();
        if (cellValues.some(v => v.trim())) {
          const rowText = cellValues.join("\t");
          const effectiveRowRepeat = Math.min(rowRepeat, 3);
          for (let r = 0; r < effectiveRowRepeat; r++) rows.push(rowText);
        }
      }
    }
  }

  findTables(xmlDoc.documentElement);
  return sheets.join("\n\n");
}

// ===================== PDF =====================
async function extractPdf(file) {
  if (typeof pdfjsLib === 'undefined') throw new Error("PDF.js library failed to load.");
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  const maxPages = Math.min(pdf.numPages, 200);
  const pages = [];

  for (let i = 1; i <= maxPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    let text = "";
    let lastY = null;
    for (const item of tc.items) {
      if (item.str === undefined) continue;
      const y = Math.round(item.transform[5]);
      if (lastY !== null && Math.abs(y - lastY) > 3) text += "\n";
      else if (text.length > 0 && !text.endsWith("\n") && !text.endsWith(" ") && item.str) text += " ";
      text += item.str;
      lastY = y;
    }
    if (text.trim()) pages.push(`--- Page ${i} ---\n${text.trim()}`);
  }
  let result = pages.join("\n\n");
  if (pdf.numPages > maxPages) result += `\n\n[... truncated: showing ${maxPages} of ${pdf.numPages} pages ...]`;
  return result;
}

// ===================== Extraction Dispatcher =====================
async function extractTextFromDocument(file) {
  const ext = getExtension(file.name);
  switch (ext) {
    case 'docx': return extractDocx(file);
    case 'odt':  return extractOdt(file);
    case 'pptx': return extractPptx(file);
    case 'odp':  return extractOdp(file);
    case 'xlsx': return extractXlsx(file);
    case 'ods':  return extractOds(file);
    case 'pdf':  return extractPdf(file);
    default: throw new Error(`Unsupported format: .${ext}`);
  }
}

// ===================== Attachment Handling =====================
function getFileIcon(filename) {
  const ext = getExtension(filename);
  const icons = {
    docx:"📝", odt:"📝", pptx:"📊", odp:"📊", xlsx:"📗", ods:"📗", pdf:"📕",
    py:"🐍", js:"🟨", ts:"🔷", html:"🌐", css:"🎨",
    json:"📋", xml:"📋", yaml:"📋", yml:"📋", csv:"📊", sql:"🗃️",
    java:"☕", cpp:"⚙️", c:"⚙️", rs:"🦀", go:"🔵",
    md:"📖", txt:"📄", log:"📜",
  };
  return icons[ext] || "📄";
}

async function processAndAttach(file) {
  if (file.size > 20 * 1024 * 1024) { showToast(`⚠️ "${file.name}" too large (max 20 MB).`); return; }

  const entry = { name: file.name, type: file.type, isImage: false, dataUrl: null, textContent: null, processing: false };

  if (isImageFile(file)) {
    entry.isImage = true;
    entry.dataUrl = await readFileAsDataURL(file);
    attachedFiles.push(entry);
    renderAttachments();

  } else if (isDocumentFile(file)) {
    entry.processing = true;
    attachedFiles.push(entry);
    renderAttachments();

    try {
      const text = await extractTextFromDocument(file);
      if (!text || text.trim().length === 0) {
        showToast(`⚠️ No text found in "${file.name}".`);
        entry.textContent = "(No text content extracted)";
      } else {
        entry.textContent = text;
        showToast(`✅ Extracted from "${file.name}" (${(text.length / 1024).toFixed(1)} KB text).`);
      }
    } catch (err) {
      console.error("Extraction error:", err);
      showToast(`❌ Failed: "${file.name}": ${err.message}`);
      entry.textContent = "(Failed to extract text)";
    }
  }
}

// ===================== Interactive quizzes =====================
// The AI returns quiz content inside a fenced ```quiz block containing
// JSON. This app owns the rendering and the answer-checking logic; the
// AI never supplies executable code. Quiz JSON survives the markdown
// pipeline through an HTML data attribute and DOMPurify (div + data-*
// are allowed by the sanitizer profile), so quizzes render correctly
// in both index.html and tutor_app.js message paths.

function parseQuizJson(json) {
  json = String(json).trim();

  // Some models wrap the payload in a ```json (or ```quiz) fence or add
  // surrounding prose fences.
  const fence = json.match(/^```(?:json|quiz)?\s*\n?([\s\S]*?)\n?```$/i);
  if (fence) json = fence[1].trim();

  let data;
  try {
    data = JSON.parse(json);
  } catch (err) {
    return { error: "its data was invalid JSON (" + err.message + ")." };
  }

  const questions = Array.isArray(data && data.questions)
    ? data.questions
    : null;

  if (!questions || questions.length === 0) {
    return { error: "it has no questions array." };
  }

  if (questions.length > 30) {
    return { error: "it contains more than 30 questions." };
  }

  const cleaned = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i] || {};
    const options = Array.isArray(q.options) ? q.options : null;

    if (!options || options.length < 2) {
      return { error: "question " + (i + 1) + " has fewer than two options." };
    }

    if (options.length > 8) {
      return { error: "question " + (i + 1) + " has more than eight options." };
    }

    let answer = typeof q.answer === "number"
      ? q.answer
      : parseInt(q.answer, 10);

    if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) {
      return { error: "question " + (i + 1) + " has an invalid answer index." };
    }

    const texts = [];
    for (let j = 0; j < options.length; j++) {
      texts.push(String(options[j] == null ? "" : options[j]));
    }

    cleaned.push({
      question: String(q.question == null ? "" : q.question),
      options: texts,
      answer: answer,
      explanation: q.explanation == null ? "" : String(q.explanation)
    });
  }

  return {
    quiz: {
      title: data.title == null ? "" : String(data.title),
      questions: cleaned
    }
  };
}

function quizToDataAttribute(quiz) {
  return JSON.stringify(quiz)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function quizFromElement(el) {
  try {
    const parsed = JSON.parse(el.getAttribute("data-quiz"));
    if (!parsed || !Array.isArray(parsed.questions)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Quiz JSON often carries LaTeX written with $...$ or $$...$$
// delimiters, but MathJax here is only configured for \(...\) and
// \[...\]. This converts the dollar forms into the configured ones
// before the text is placed into the quiz card, leaving any existing
// \(...\) / \[...\] untouched. Text is inserted with textContent, so
// the delimiters survive intact for MathJax to typeset.
function normalizeQuizLatex(text) {
  text = String(text == null ? "" : text);

  // Display math: $$...$$ → \[...\]
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, "\\[$1\\]");

  // Inline math: $...$ → \(...\). Skips $$ and empty pairs; the
  // content must stay on one line, matching the chat renderer.
  text = text.replace(/(?<!\$)\$(?!\$)([^\$\n]+?)\$(?!\$)/g, "\\($1\\)");

  return text;
}

// Tells MathJax to forget any math it rendered inside an element
// before that element's content is replaced, so re-rendering a quiz
// question or the results view never leaves stale math state behind.
function clearMath(element) {
  try {
    if (window.MathJax && MathJax.typesetClear) {
      MathJax.typesetClear([element]);
    }
  } catch (e) {
    console.warn("MathJax typesetClear failed:", e);
  }
}

// Builds the quiz card shell with DOM APIs only, so quiz text is
// treated as text rather than executable HTML. The card shows one
// question at a time; all state lives on card._quizState.
function buildQuizCard(quiz) {
  const card = document.createElement("section");
  card.className = "quiz-card";

  // State stays attached to this individual quiz card.
  card._quizState = {
    quiz: quiz,
    currentIndex: 0,
    answers: new Array(quiz.questions.length).fill(null),
    finished: false
  };

  if (quiz.title) {
    const title = document.createElement("h3");
    title.className = "quiz-title";
    title.textContent = normalizeQuizLatex(quiz.title);
    card.appendChild(title);
  }

  const progress = document.createElement("p");
  progress.className = "quiz-progress";

  const questionArea = document.createElement("div");
  questionArea.className = "quiz-question-area";

  const feedback = document.createElement("div");
  feedback.className = "quiz-feedback";
  feedback.hidden = true;

  const navigation = document.createElement("div");
  navigation.className = "quiz-navigation";

  const previousButton = document.createElement("button");
  previousButton.type = "button";
  previousButton.className = "quiz-prev";
  previousButton.textContent = "Previous";

  const nextButton = document.createElement("button");
  nextButton.type = "button";
  nextButton.className = "quiz-next";
  nextButton.textContent = "Next";

  const finishButton = document.createElement("button");
  finishButton.type = "button";
  finishButton.className = "quiz-finish";
  finishButton.textContent = "Finish quiz";
  finishButton.hidden = true;

  navigation.append(previousButton, nextButton, finishButton);

  const result = document.createElement("div");
  result.className = "quiz-result";
  result.hidden = true;

  card.append(progress, questionArea, feedback, navigation, result);

  previousButton.addEventListener("click", function () {
    const state = card._quizState;

    if (state.currentIndex > 0) {
      state.currentIndex--;
      updateQuizCard(card);
    }
  });

  nextButton.addEventListener("click", function () {
    const state = card._quizState;
    const selected = questionArea.querySelector("input:checked");

    // Require an answer before moving ahead.
    if (!selected) {
      feedback.hidden = false;
      feedback.textContent = "Choose an answer before continuing.";
      return;
    }

    state.answers[state.currentIndex] = Number(selected.value);
    feedback.hidden = true;

    if (state.currentIndex < state.quiz.questions.length - 1) {
      state.currentIndex++;
      updateQuizCard(card);
    }
  });

  finishButton.addEventListener("click", function () {
    const state = card._quizState;
    const selected = questionArea.querySelector("input:checked");

    if (!selected) {
      feedback.hidden = false;
      feedback.textContent = "Choose an answer before finishing.";
      return;
    }

    state.answers[state.currentIndex] = Number(selected.value);
    state.finished = true;

    showQuizResults(card);
  });

  updateQuizCard(card);
  typesetMath(card);

  return card;
}

// Re-renders the current question into the question area, restoring any
// previously chosen answer.
function updateQuizCard(card) {
  const state = card._quizState;
  const quiz = state.quiz;
  const index = state.currentIndex;
  const item = quiz.questions[index];

  const progress = card.querySelector(".quiz-progress");
  const questionArea = card.querySelector(".quiz-question-area");
  const feedback = card.querySelector(".quiz-feedback");
  const previousButton = card.querySelector(".quiz-prev");
  const nextButton = card.querySelector(".quiz-next");
  const finishButton = card.querySelector(".quiz-finish");

  // The question area may hold typeset math from the previously shown
  // question; tell MathJax to forget it before replacing the content.
  clearMath(questionArea);

  progress.textContent = "Question " + (index + 1) + " of " + quiz.questions.length;

  previousButton.disabled = index === 0;

  // On the last question, replace Next with Finish quiz.
  const isLastQuestion = index === quiz.questions.length - 1;
  nextButton.hidden = isLastQuestion;
  finishButton.hidden = !isLastQuestion;

  feedback.hidden = true;
  questionArea.replaceChildren();

  const prompt = document.createElement("p");
  prompt.className = "quiz-prompt";
  prompt.textContent = (index + 1) + ". " + normalizeQuizLatex(item.question);
  questionArea.appendChild(prompt);

  const options = document.createElement("div");
  options.className = "quiz-options";

  // Unique radio group per card so multiple quizzes never interfere.
  const groupName =
    "quiz-" + Math.random().toString(36).slice(2, 10) + "-q" + index;

  item.options.forEach(function (optionText, optionIndex) {
    const label = document.createElement("label");
    label.className = "quiz-option";

    const input = document.createElement("input");
    input.type = "radio";
    input.name = groupName;
    input.value = optionIndex;

    // Restore a prior answer when navigating backward or forward.
    if (state.answers[index] === optionIndex) {
      input.checked = true;
    }

    const text = document.createElement("span");
    text.textContent = normalizeQuizLatex(optionText);

    label.append(input, text);
    options.appendChild(label);
  });

  questionArea.appendChild(options);

  typesetMath(questionArea);
}

// Grades the saved answers and shows a per-question review with a
// retry option. Nothing is revealed until the user finishes.
function showQuizResults(card) {
  const state = card._quizState;
  const quiz = state.quiz;
  const result = card.querySelector(".quiz-result");

  // MathJax state inside the card is stale once the results view
  // replaces the question view (and again on each retry).
  clearMath(card);

  let correctCount = 0;

  quiz.questions.forEach(function (question, index) {
    if (state.answers[index] === question.answer) {
      correctCount++;
    }
  });

  card.querySelector(".quiz-question-area").hidden = true;
  card.querySelector(".quiz-feedback").hidden = true;
  card.querySelector(".quiz-navigation").hidden = true;
  card.querySelector(".quiz-progress").hidden = true;

  result.hidden = false;
  result.replaceChildren();

  const heading = document.createElement("h4");
  heading.textContent = "Quiz complete";

  const score = document.createElement("p");
  score.className = "quiz-score";
  score.textContent =
    "You got " + correctCount + " out of " + quiz.questions.length + " correct.";

  result.append(heading, score);

  quiz.questions.forEach(function (question, index) {
    const review = document.createElement("div");
    review.className = "quiz-review";

    const wasCorrect = state.answers[index] === question.answer;
    review.classList.add(wasCorrect ? "is-correct" : "is-incorrect");

    const questionText = document.createElement("p");
    questionText.textContent =
      (index + 1) + ". " + normalizeQuizLatex(question.question);

    const answerText = document.createElement("p");
    answerText.textContent = wasCorrect
      ? "Correct."
      : "Correct answer: " + normalizeQuizLatex(question.options[question.answer]);

    review.append(questionText, answerText);

    if (question.explanation) {
      const explanation = document.createElement("p");
      explanation.className = "quiz-explanation";
      explanation.textContent = normalizeQuizLatex(question.explanation);
      review.appendChild(explanation);
    }

    result.appendChild(review);
  });

  const actionsRow = document.createElement("div");
  actionsRow.className = "quiz-actions";

  const retryButton = document.createElement("button");
  retryButton.type = "button";
  retryButton.className = "quiz-retry";
  retryButton.textContent = "Try again";

  retryButton.addEventListener("click", function () {
    state.currentIndex = 0;
    state.answers = new Array(quiz.questions.length).fill(null);
    state.finished = false;

    result.hidden = true;
    card.querySelector(".quiz-question-area").hidden = false;
    card.querySelector(".quiz-navigation").hidden = false;
    card.querySelector(".quiz-progress").hidden = false;

    updateQuizCard(card);
  });

  const submitButton = document.createElement("button");
  submitButton.type = "button";
  submitButton.className = "quiz-submit-results";
  submitButton.textContent = "Submit results to chat";

  submitButton.addEventListener("click", function () {
    const summary = buildQuizSummary(quiz, state.answers);

    // Prevent a double submission.
    submitButton.disabled = true;
    submitButton.textContent = "Results submitted";

    sendUserMessage(summary);
  });

  actionsRow.append(retryButton, submitButton);
  result.appendChild(actionsRow);

  typesetMath(result);
}

// Quiz → chat bridge: a finished quiz builds a short result summary
// and hands it to the app's own send pipeline, so the tutor receives
// it as a normal user message and can respond. Missed-question
// details are capped so long quizzes cannot produce a huge prompt.
const QUIZ_MAX_MISSED_DETAILS = Infinity;

function buildQuizSummary(quiz, answers) {
  let correctCount = 0;
  const missedDetails = [];

  quiz.questions.forEach(function (question, index) {
    const selectedIndex = answers[index];

    if (selectedIndex === question.answer) {
      correctCount++;
      return;
    }

    missedDetails.push(
      "Question " + (index + 1) + ': "' + question.question + '" ' +
      'I chose "' + (question.options[selectedIndex] || "no answer") +
      '" ; the correct answer was "' + question.options[question.answer] + '".'
    );
  });

  const total = quiz.questions.length;
  const percent = Math.round((correctCount / total) * 100);

  let summary =
    'Quiz result — "' + (quiz.title || "Untitled quiz") + '": ' +
    correctCount + "/" + total + " correct (" + percent + "%).";

  if (missedDetails.length) {
    summary +=
      "\n\n" + missedDetails.slice(0, QUIZ_MAX_MISSED_DETAILS).join("\n") +
      (missedDetails.length > QUIZ_MAX_MISSED_DETAILS
        ? "\n(and " + (missedDetails.length - QUIZ_MAX_MISSED_DETAILS) + " more missed)"
        : "") +
      "\n\nPlease briefly help me review what I missed.";
  } else {
    summary += "\n\nI answered everything correctly; please give me a slightly harder follow-up quiz.";
  }

  return summary;
}

function removeAttachment(index) { attachedFiles.splice(index, 1); renderAttachments(); }
function clearAttachments() { attachedFiles = []; renderAttachments(); fileUpload.value = ""; }

function renderAttachments() {
  attachmentArea.innerHTML = "";
  if (attachedFiles.length === 0) { attachmentArea.classList.remove("active"); return; }
  attachmentArea.classList.add("active");

  attachedFiles.forEach((att, i) => {
    const item = document.createElement("div");
    item.className = "att-item" + (att.processing ? " processing" : "");

    if (att.isImage && att.dataUrl) {
      const img = document.createElement("img");
      img.src = att.dataUrl;
      item.appendChild(img);
    } else {
      const icon = document.createElement("span");
      icon.className = "att-icon";
      icon.textContent = getFileIcon(att.name);
      item.appendChild(icon);
    }

    const nameSpan = document.createElement("span");
    nameSpan.className = "att-name";
    nameSpan.textContent = att.name;
    nameSpan.title = att.name;
    item.appendChild(nameSpan);

    const removeBtn = document.createElement("button");
    removeBtn.className = "att-remove";
    removeBtn.textContent = "✕";
    removeBtn.onclick = () => removeAttachment(i);
    item.appendChild(removeBtn);

    attachmentArea.appendChild(item);
  });
}

// File upload input handler
fileUpload.addEventListener("change", async (e) => {
  for (const file of e.target.files) await processAndAttach(file);
  fileUpload.value = "";
});

// Clipboard paste (images)
document.addEventListener("paste", async (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      e.preventDefault();
      const blob = item.getAsFile();
      const name = "clipboard-" + Date.now() + "." + (item.type.split("/")[1] || "png");
      await processAndAttach(new File([blob], name, { type: item.type }));
      showToast("📋 Image pasted.");
      return;
    }
  }
});

// Drag and drop (desktop only; harmless on mobile)
let dragCounter = 0;
document.addEventListener("dragenter", (e) => { e.preventDefault(); dragCounter++; document.getElementById("dropOverlay").classList.add("active"); });
document.addEventListener("dragleave", (e) => { e.preventDefault(); dragCounter--; if (dragCounter <= 0) { dragCounter = 0; document.getElementById("dropOverlay").classList.remove("active"); } });
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", async (e) => {
  e.preventDefault(); dragCounter = 0;
  document.getElementById("dropOverlay").classList.remove("active");
  if (e.dataTransfer?.files) for (const file of e.dataTransfer.files) await processAndAttach(file);
});

// After bot message HTML is in the DOM, replace each quiz container
// placeholder with the fully interactive card.
function renderQuizzes(rootElement) {
  if (!rootElement || !rootElement.querySelectorAll) return;

  rootElement.querySelectorAll(".quiz-container").forEach(function (target) {
    const data = quizFromElement(target);
    if (!data) {
      target.replaceWith(Object.assign(document.createElement("div"), {
        className: "quiz-error",
        textContent: "⚠️ Quiz could not be rendered."
      }));
      return;
    }
    target.replaceWith(buildQuizCard(data));
  });
}

// ===================== Markdown / MathJax =====================
function renderMarkdown(text) {
  const placeholders = [];

  function ph(content, isHtml) {
    const idx = placeholders.length;
    placeholders.push({ content: content, isHtml: !!isHtml });
    return '\x00PH' + idx + 'PH\x00';
  }

  // Interactive quizzes: extracted before generic code fences. The
  // placeholder starts with "<div", so the paragraph logic below leaves
  // it unwrapped, and DOMPurify keeps it (div + data-* are allowed).
  text = text.replace(/```quiz[^\n]*\n([\s\S]*?)```/gi, function (m, json) {
    const parsed = parseQuizJson(json);
    if (parsed.error) {
      const safe = parsed.error
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return ph('<div class="quiz-error">⚠️ Quiz could not be rendered: ' + safe + "</div>", true);
    }
    return ph('<div class="quiz-container" data-quiz="' + quizToDataAttribute(parsed.quiz) + '"></div>', true);
  });

  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, function(m, lang, code) {
    var esc = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return ph('<pre><code>' + esc + '</code></pre>', true);
  });

  text = text.replace(/`([^`]+)`/g, function(m, code) {
    var esc = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return ph('<code>' + esc + '</code>', true);
  });

  text = text.replace(/\\\[([\s\S]*?)\\\]/g, function(m) { return ph(m, false); });
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, function(m) { return ph(m, false); });
  text = text.replace(/\\begin\{([^}]+)\}([\s\S]*?)\\end\{\1\}/g, function(m) { return ph(m, false); });

  text = text.replace(/\$\$([\s\S]*?)\$\$/g, function(m, inner) {
    return ph('\\[' + inner + '\\]', false);
  });

  text = text.replace(/(?<!\$)\$(?!\$)(?!\s)([^\$\n]+?)(?<!\s)\$(?!\$)/g, function(m, inner) {
    return ph('\\(' + inner + '\\)', false);
  });

  var html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  var lines = html.split('\n');
  var processed = [];
  var inList = false;
  var listType = null;
  var listItems = [];

  function splitTableRow(line) {
    line = line.trim();

    // Outer pipes are optional in Markdown tables.
    if (line.startsWith('|')) line = line.slice(1);
    if (line.endsWith('|')) line = line.slice(0, -1);

    return line
      .split(/(?<!\\)\|/)
      .map(function(cell) {
        return cell.trim().replace(/\\\|/g, '|');
      });
  }

  function isTableDivider(line) {
    var cells = splitTableRow(line);

    return cells.length > 0 && cells.every(function(cell) {
      // Valid examples: - , :- , -: , :-: , --- , :--- , ---: , :---:
      return /^:?-+:?$/.test(cell.trim());
    });
  }

  function getTableAlignment(dividerCell) {
    var cell = dividerCell.trim();
    var left = cell.startsWith(':');
    var right = cell.endsWith(':');

    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return '';
  }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    // Markdown table:
    // | Header | Header |
    // | ------ | :----: |
    // | Value  | Value  |
    if (
      i + 1 < lines.length &&
      line.includes('|') &&
      isTableDivider(lines[i + 1])
    ) {
      // Close an open list before inserting a table.
      if (inList) {
        processed.push(
          '<' + listType + '>' +
          listItems.map(function(item) {
            return '<li>' + item + '</li>';
          }).join('') +
          '</' + listType + '>'
        );

        inList = false;
        listType = null;
        listItems = [];
      }

      var headers = splitTableRow(line);
      var divider = splitTableRow(lines[i + 1]);

      // Avoid treating mismatched pipe text as a table.
      if (headers.length === divider.length) {
        var alignments = divider.map(getTableAlignment);

        var tableHtml = '<div class="table-wrap"><table>';

        tableHtml += '<thead><tr>';
        headers.forEach(function(header, index) {
          var align = alignments[index];
          var style = align ? ' style="text-align:' + align + '"' : '';
          tableHtml += '<th' + style + '>' + header + '</th>';
        });
        tableHtml += '</tr></thead><tbody>';

        i += 2;

        while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
          var cells = splitTableRow(lines[i]);

          // Stop if this no longer has the expected number of cells.
          if (cells.length !== headers.length) {
            i--;
            break;
          }

          tableHtml += '<tr>';

          cells.forEach(function(cell, index) {
            var align = alignments[index];
            var style = align ? ' style="text-align:' + align + '"' : '';
            tableHtml += '<td' + style + '>' + cell + '</td>';
          });

          tableHtml += '</tr>';
          i++;
        }

        i--; // compensate for the outer loop increment
        tableHtml += '</tbody></table></div>';
        processed.push(tableHtml);
        continue;
      }
    }

    var ulMatch = line.match(/^[\s]*[\*\-]\s+(.+)$/);
    var olMatch = line.match(/^[\s]*\d+\.\s+(.+)$/);

    if (ulMatch || olMatch) {
      var content = ulMatch ? ulMatch[1] : olMatch[1];
      var currentType = ulMatch ? 'ul' : 'ol';

      if (!inList) {
        inList = true;
        listType = currentType;
        listItems = [];
      } else if (listType !== currentType) {
        processed.push(
          '<' + listType + '>' +
          listItems.map(function(item) {
            return '<li>' + item + '</li>';
          }).join('') +
          '</' + listType + '>'
        );
        listItems = [];
        listType = currentType;
      }

      listItems.push(content);
    } else {
      if (inList) {
        processed.push(
          '<' + listType + '>' +
          listItems.map(function(item) {
            return '<li>' + item + '</li>';
          }).join('') +
          '</' + listType + '>'
        );
        inList = false;
        listType = null;
        listItems = [];
      }

      processed.push(line);
    }
  }

  if (inList) {
    processed.push(
      '<' + listType + '>' +
      listItems.map(function(item) {
        return '<li>' + item + '</li>';
      }).join('') +
      '</' + listType + '>'
    );
  }

  html = processed.join('\n');

  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/^&gt;\s+(.+)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/^[-*_]{3,}$/gm, '<hr>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  html = html.replace(/(?<!href=")(?<!">)((?:https?:\/\/)[^\s<]+)/g, '<a href="$1" target="_blank">$1</a>');

  var finalLines = html.split('\n');
  var withParagraphs = [];

  for (var j = 0; j < finalLines.length; j++) {
    var fLine = finalLines[j];
    var trimmed = fLine.trim();
    if (trimmed === '') {
      withParagraphs.push('');
    } else if (trimmed.match(/^<(h[1-6]|ul|ol|pre|blockquote|hr|table|div)/)) {
      withParagraphs.push(fLine);
    } else if (!trimmed.match(/^<\/(ul|ol|li|blockquote)>$/)) {
      withParagraphs.push('<p>' + fLine + '</p>');
    } else {
      withParagraphs.push(fLine);
    }
  }
  html = withParagraphs.join('\n');

  html = html.replace(/\x00PH(\d+)PH\x00/g, function(_, idx) {
    var p = placeholders[parseInt(idx)];
    if (p.isHtml) {
      return p.content;
    }
    return p.content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  });

  return html;
}

function renderUserContent(text) {
  var uPh = [];
  text = text.replace(/\\\[([\s\S]*?)\\\]/g, function(m) { uPh.push(m); return '\x00U' + (uPh.length - 1) + 'U\x00'; });
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, function(m) { uPh.push(m); return '\x00U' + (uPh.length - 1) + 'U\x00'; });
  text = text.replace(/\\begin\{([^}]+)\}([\s\S]*?)\\end\{\1\}/g, function(m) { uPh.push(m); return '\x00U' + (uPh.length - 1) + 'U\x00'; });
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, function(m, inner) { uPh.push('\\[' + inner + '\\]'); return '\x00U' + (uPh.length - 1) + 'U\x00'; });
  text = text.replace(/(?<!\$)\$(?!\$)(?!\s)([^\$\n]+?)(?<!\s)\$(?!\$)/g, function(m, inner) { uPh.push('\\(' + inner + '\\)'); return '\x00U' + (uPh.length - 1) + 'U\x00'; });
  text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  text = text.replace(/\x00U(\d+)U\x00/g, function(_, idx) {
    return uPh[parseInt(idx)].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  });
  return text;
}

async function typesetMath(element) {
  try {
    if (window.MathJax && MathJax.typesetPromise) {
      await MathJax.typesetPromise([element]);
    }
  } catch (e) {
    console.warn("MathJax typeset failed:", e);
  }
}

// ===================== Messages =====================
function addMessage(content, sender, attachments, timestamp) {
  const msg = document.createElement("div");
  msg.classList.add("message", sender);

  if (sender === "bot") {
    msg.innerHTML = renderMarkdown(content);
  } else {
    if (content) {
      const textSpan = document.createElement("span");
      textSpan.innerHTML = renderUserContent(content);
      msg.appendChild(textSpan);
    }
  }

  if (attachments && attachments.length > 0) {
    attachments.forEach(att => {
      if (att.isImage && att.dataUrl) {
        const img = document.createElement("img");
        img.className = "att-image";
        img.src = att.dataUrl;
        img.alt = att.name;
        img.onclick = () => {
          document.getElementById("modalImage").src = att.dataUrl;
          document.getElementById("imageModal").classList.add("active");
        };
        msg.appendChild(img);
      } else {
        const badge = document.createElement("div");
        badge.className = "file-badge";
        const sizeInfo = att.textContent ? ` (${(att.textContent.length / 1024).toFixed(1)} KB)` : "";
        badge.textContent = `${getFileIcon(att.name)} ${att.name}${sizeInfo}`;
        msg.appendChild(badge);
      }
    });
  }

  if (timestamp) {
    msg.appendChild(createTimestampEl(timestamp));
  }

  chatBox.appendChild(msg);
  chatBox.scrollTop = chatBox.scrollHeight;

  if (sender === "bot") {
    renderQuizzes(msg);
  }

  typesetMath(msg);
  return msg;
}

// Sends text as if the user had typed it: adds the user bubble and
// runs the existing send pipeline, so the tutor receives quiz
// results exactly like a normal message. Used by quiz result
// submission; a no-op if a request is already in flight.
async function sendUserMessage(text) {
  if (typeof text === "string") {
    input.value = text;
  }

  await sendMessage();
}

function addProcessingMessage() {
  const msg = document.createElement("div");
  msg.classList.add("message", "bot", "processing");
  msg.innerHTML = '<div class="typing" aria-label="Assistant is typing"><span class="dots" aria-hidden="true"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span></div>';
  chatBox.appendChild(msg);
  chatBox.scrollTop = chatBox.scrollHeight;
  return msg;
}

async function typeBotMessage(element, fullText, timestamp) {
  element.classList.remove("processing");
  element.style.display = "";
  element.style.minHeight = "";
  element.innerHTML = "";

  const textEl = document.createElement("div");
  textEl.textContent = "";
  element.appendChild(textEl);

  const cursor = document.createElement("span");
  cursor.className = "stream-cursor";
  element.appendChild(cursor);

  const baseDelay = 12;
  const chunkSize = 2;

  let i = 0;
  while (i < fullText.length) {
    const nearBottom = (chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight) < 120;
    i = Math.min(i + chunkSize, fullText.length);
    textEl.textContent = fullText.slice(0, i);
    if (nearBottom) chatBox.scrollTop = chatBox.scrollHeight;
    const lastChar = fullText[i - 1];
    const delay = (lastChar === "\n") ? baseDelay * 3 : baseDelay;
    await new Promise(r => setTimeout(r, delay));
  }

  cursor.remove();
  element.innerHTML = renderMarkdown(fullText);
  renderQuizzes(element);

  if (timestamp) {
    element.appendChild(createTimestampEl(timestamp));
  }

  chatBox.scrollTop = chatBox.scrollHeight;
  await typesetMath(element);
}

// ===================== Textarea auto-grow =====================
input.addEventListener("keydown", (event) => {
  // Only Enter-to-send on devices with a physical keyboard (avoid mobile send-on-enter)
  if (event.key === "Enter" && !event.shiftKey && !('ontouchstart' in window)) {
    event.preventDefault();
    sendMessage();
  }
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  const newHeight = Math.min(input.scrollHeight, 150);
  input.style.height = newHeight + "px";
});

// ===================== Paste protection =====================
input.addEventListener("paste", (e) => {
  const pastedText = e.clipboardData?.getData("text/plain");
  if (!pastedText) return; // image / non-text paste — handled elsewhere

  // Always record that this message contains pasted content
  pastedInCurrentInput = true;

  // If protection is enabled, scramble alphabetic characters
  if (typeof copyPasteProtection !== 'undefined' && copyPasteProtection) {
    e.preventDefault();

    const altered = pastedText.replace(/[a-zA-Z]/g, (ch) => {
      const isUpper = ch >= 'A' && ch <= 'Z';
      const base = isUpper ? 65 : 97;
      return String.fromCharCode(base + Math.floor(Math.random() * 26));
    });

    const start = input.selectionStart;
    const end   = input.selectionEnd;
    input.value =
      input.value.substring(0, start) + altered + input.value.substring(end);
    input.selectionStart = input.selectionEnd = start + altered.length;

    // Trigger auto-resize
    input.dispatchEvent(new Event('input'));

    // showToast("⚠️ Pasted text was scrambled (paste protection on).");
  }
});

// ===================== Draw / Handwriting Canvas =====================
function initDrawCanvas() {
  const canvas = document.getElementById('drawCanvas');

  function getCanvasPos(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    if (e.touches && e.touches.length > 0) {
      return { x: (e.touches[0].clientX - rect.left) * scaleX, y: (e.touches[0].clientY - rect.top) * scaleY };
    }
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  function startDraw(e) {
    e.preventDefault();
    canvasIsDrawing = true;
    const pos = getCanvasPos(e);
    lastDrawX = pos.x;
    lastDrawY = pos.y;
    if (drawCtx) {
      drawCtx.beginPath();
      drawCtx.arc(pos.x, pos.y, drawCtx.lineWidth / 2, 0, Math.PI * 2);
      drawCtx.fillStyle = drawCtx.strokeStyle;
      drawCtx.fill();
    }
  }

  function doDraw(e) {
    e.preventDefault();
    if (!canvasIsDrawing || !drawCtx) return;
    const pos = getCanvasPos(e);
    drawCtx.beginPath();
    drawCtx.moveTo(lastDrawX, lastDrawY);
    drawCtx.lineTo(pos.x, pos.y);
    drawCtx.stroke();
    lastDrawX = pos.x;
    lastDrawY = pos.y;
  }

  function endDraw() {
    canvasIsDrawing = false;
  }

  canvas.addEventListener('mousedown', startDraw);
  canvas.addEventListener('mousemove', doDraw);
  canvas.addEventListener('mouseup', endDraw);
  canvas.addEventListener('mouseleave', endDraw);
  canvas.addEventListener('touchstart', startDraw, { passive: false });
  canvas.addEventListener('touchmove', doDraw, { passive: false });
  canvas.addEventListener('touchend', endDraw);
  canvas.addEventListener('touchcancel', endDraw);

  document.getElementById('penSize').addEventListener('input', function() {
    if (drawCtx) drawCtx.lineWidth = parseInt(this.value);
  });
}

function openDrawModal() {
  const modal = document.getElementById('drawModal');
  modal.classList.add('active');

  // Measure after the browser has laid out the now-visible modal
  requestAnimationFrame(() => {
    const canvas    = document.getElementById('drawCanvas');
    const container = document.getElementById('drawContainer');
    const toolbar   = document.getElementById('drawToolbar');
    const footer    = document.getElementById('drawFooter');

    // Read real CSS values (handles desktop vs phone padding/gap automatically)
    const cs = getComputedStyle(container);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop)  + parseFloat(cs.paddingBottom);
    const gap  = parseFloat(cs.rowGap || cs.gap) || 10;

    const cRect    = container.getBoundingClientRect();
    const toolbarH = toolbar.getBoundingClientRect().height;
    const footerH  = footer.getBoundingClientRect().height;

    // Canvas fills the container minus toolbar, footer, padding and 2 gaps
    const w = Math.max(260, Math.floor(cRect.width  - padX));
    const h = Math.max(220, Math.floor(cRect.height - padY - toolbarH - footerH - gap * 2));

    canvas.width = w;
    canvas.height = h;
    canvas.style.width  = w + 'px';
    canvas.style.height = h + 'px';

    drawCtx = canvas.getContext('2d');
    drawCtx.fillStyle = '#ffffff';
    drawCtx.fillRect(0, 0, w, h);

    currentPenColor = '#000';
    isEraserActive = false;
    drawCtx.strokeStyle = '#000';
    drawCtx.lineWidth = parseInt(document.getElementById('penSize').value);
    drawCtx.lineCap  = 'round';
    drawCtx.lineJoin = 'round';

    document.querySelectorAll('.draw-color-btn').forEach((b, i) => {
      b.classList.toggle('active', i === 0);
    });
    document.getElementById('eraserBtn').classList.remove('active');
    canvasIsDrawing = false;
  });
}
function closeDrawModal() {
  document.getElementById('drawModal').classList.remove('active');
}

function clearCanvas() {
  if (!drawCtx) return;
  const canvas = document.getElementById('drawCanvas');
  drawCtx.fillStyle = '#ffffff';
  drawCtx.fillRect(0, 0, canvas.width, canvas.height);
}

function setDrawColor(color, btn) {
  currentPenColor = color;
  isEraserActive = false;
  if (drawCtx) drawCtx.strokeStyle = color;
  document.querySelectorAll('.draw-color-btn').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  document.getElementById('eraserBtn').classList.remove('active');
}

function toggleEraser() {
  isEraserActive = !isEraserActive;
  var eraserBtn = document.getElementById('eraserBtn');
  if (isEraserActive) {
    if (drawCtx) drawCtx.strokeStyle = '#ffffff';
    eraserBtn.classList.add('active');
    document.querySelectorAll('.draw-color-btn').forEach(function(b) { b.classList.remove('active'); });
  } else {
    if (drawCtx) drawCtx.strokeStyle = currentPenColor;
    eraserBtn.classList.remove('active');
    document.querySelectorAll('.draw-color-btn').forEach(function(b) {
      if (b.style.background === currentPenColor || b.style.backgroundColor === currentPenColor) {
        b.classList.add('active');
      }
    });
  }
}

function getCanvasDataUrl() {
  var canvas = document.getElementById('drawCanvas');
  return canvas.toDataURL('image/png');
}

function attachDrawing() {
  var dataUrl = getCanvasDataUrl();
  var entry = {
    name: 'drawing-' + Date.now() + '.png',
    type: 'image/png',
    isImage: true,
    dataUrl: dataUrl,
    textContent: null,
    processing: false
  };
  attachedFiles.push(entry);
  renderAttachments();
  closeDrawModal();
  showToast('✏️ Drawing attached.');
}

function sendDrawing() {
  var dataUrl = getCanvasDataUrl();
  var entry = {
    name: 'drawing-' + Date.now() + '.png',
    type: 'image/png',
    isImage: true,
    dataUrl: dataUrl,
    textContent: null,
    processing: false
  };
  attachedFiles.push(entry);
  renderAttachments();
  closeDrawModal();
  sendMessage();
}

// ===================== Header config =====================

const img = document.getElementById("headerImage");
if (headerImageUrl) {
  img.src = headerImageUrl;
  img.alt = headerTitle; // or a sensible description
} else {
  img.style.display = "none";
}

document.getElementById("headerTitle").textContent = headerTitle;
document.querySelector(".copyright").textContent = copyrightText;
document.getElementById("headerImage").src = headerImageUrl;
document.title = tabTitle;

// ===================== Copy protection =====================
document.addEventListener('copy', (e) => {
  // Only scramble if protection is enabled
  if (typeof copyPasteProtection === 'undefined' || !copyPasteProtection) return;

  const selection = document.getSelection();
  const selectedText = selection ? selection.toString() : '';
  if (!selectedText) return;

  // Same scrambling logic as your paste handler
  const altered = selectedText.replace(/[a-zA-Z]/g, (ch) => {
    const isUpper = ch >= 'A' && ch <= 'Z';
    const base = isUpper ? 65 : 97;
    return String.fromCharCode(base + Math.floor(Math.random() * 26));
  });

  e.clipboardData.setData('text/plain', altered);
  // Also override HTML so rich-copy (e.g., copying from rendered markdown) is scrambled too
  e.clipboardData.setData('text/html', altered.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'));
  e.preventDefault();

  // Optional: let the user know
  // showToast("⚠️ Copied text was scrambled (copy protection on).");
});

// Also handle the 'cut' event the same way
document.addEventListener('cut', (e) => {
  if (typeof copyPasteProtection === 'undefined' || !copyPasteProtection) return;

  const selection = document.getSelection();
  const selectedText = selection ? selection.toString() : '';
  if (!selectedText) return;

  const altered = selectedText.replace(/[a-zA-Z]/g, (ch) => {
    const isUpper = ch >= 'A' && ch <= 'Z';
    const base = isUpper ? 65 : 97;
    return String.fromCharCode(base + Math.floor(Math.random() * 26));
  });

  e.clipboardData.setData('text/plain', altered);
  e.preventDefault();
});
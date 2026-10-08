// ============================================================
// PAGE APPEARANCE
// ============================================================

const tabTitle = "AI Workbench";
const headerTitle = "AI Workbench";
const copyrightText = "© 2026 Dominik Borovský & Jozef Hanč v2.3, powered by DeepSeek V4.1 Flash at Novita AI"; //Google Gemini 3.8 Flash
const  headerImageUrl = "https://i.postimg.cc/2ymVbSj0/odf-logo-full.png";


// ============================================================
// AI CONNECTION
// ============================================================

// AI provider or your existing Cloudflare Worker endpoint.
const API_URL = "https://ai-wrapper.dominik-borovsky123.workers.dev/v1/chat/completions";

const MODEL_NAME = "odf-ufv-dgs-chat";

// Without PocketBase:
// This value is combined with the key entered by the pupil.
//
// With PocketBase:
// This contains the complete API key/token required by your
// existing AI endpoint. The "Insert key" button is hidden.
//
// Any value in this file is visible to someone inspecting the page.
// Do not put PocketBase administrator credentials here.
const API_FIRST_PART = "dgs*chat";


// ============================================================
// POCKETBASE AND CONVERSATION STORAGE
// ============================================================

// Leave empty to use standalone mode with manual JSON saving.
//
// To enable pupil login and database storage, enter your
// PocketBase address, without a trailing slash.
const POCKETBASE_URL = "https://mauve-vole.pikapod.net";

// Proposed collection names for the website implementation.
const POCKETBASE_USERS_COLLECTION = "dgs_students";
const POCKETBASE_CONVERSATIONS_COLLECTION = "dgs_conversations";

// Stable identifier for this tutor/activity.
//
// Stored as the conversation's "origin" field.
// Each pupil's conversations are separated by this identifier.
//
// Use a different value for another activity.
// Keep this unchanged when you only change the page title.
const CHAT_ORIGIN = "dgs2026-tests";

// Allow sign up by the users themselves
const signUpAllow = true;


// ============================================================
// FEATURE VISIBILITY
// ============================================================

// These settings control the normal website interface.
// They are not server-enforced permissions.

// Show the button for starting a new conversation.
const allowNewChat = false;

// Show message-delete controls.
//
// Deletion is soft deletion:
// - keep the message in the stored JSON;
// - add deleted: true and deletedAt;
// - hide it from the conversation;
// - exclude it from subsequent AI requests;
// - save the updated conversation immediately.
const allowDelete = true;

// Show the JSON conversation-import button.
//
// In PocketBase mode, importing creates a new conversation
// and saves it immediately rather than replacing the current one.
const allowImport = false;

// Show the JSON conversation-download button.
const allowExport = false;

// Show file/image attachment controls.
const allowAttachments = false;

// Show the drawing tool independently of file uploads.
const allowDrawing = false;

// Show the older-conversation browser.
//
// Only applicable when PocketBase is configured.
// Hiding it does not disable restoring the latest conversation.
const showConversationBrowser = false;


// ============================================================
// INPUT BEHAVIOR
// ============================================================

// Retains your existing pasted-text alteration setting.
const copyPasteProtection = false;


// ============================================================
// WELCOME MESSAGE
// ============================================================

// Markdown is supported.
//
// The message adapts to PocketBase mode and the visible controls,
// so it does not tell pupils to use buttons that are hidden.

// heslo na prehliadač: chat
const FIRST_MESSAGE = `
# *Prototypovanie*
1. Prepni stránku do *Test mode* (ak sa chceš vyhnúť prihlasovaniu)
2. Použi ikonku 🔑 pre vloženie kľúča (hesla). Kľúčom je znak ***%***. Zvyčajne sa kľúč uloží do pamäte prehliadača a nie je nutné to zadávať opätovne (na tom istom zariadení pre tú istú stránku).
3. Počas testovacieho módu sa konverzácie neukladajú do cloudovej databázy (PocketBase URL pre databázu v \`config_data.js\` je zakomentovaná). To znamená, že po zavretí okna sa konverzácia stratí. Ak chceš znovu aktivovať prihlasovanie (email, heslo) a ukladanie, deaktivuj *Test mode* (PocketBase URL v \`config_data.js\` sa odkomentuje).
4. Ak potrebuješ uložiť konverzáciu, použi ikonu diskety: stiahne sa \`.json\` súbor (je potrebné najprv aktivovať *Download conversation (JSON)*)
5. Ak chceš pokračovať v chate (ktorý bol predtým uložený v \`.json\` súbore), môžeš to Drag&Drop do prehliadača alebo nahrať pomocou ikonky priečinka vpravo dole (je potrebné najprv aktivovať *Import conversation (JSON)*)
6. Po každej zmene je potrebné konfiguráciu uložiť (Ctrl+S alebo Save). Pozor, pri Testovacom móde tak dochádza k strate konverzácie.
`


// ============================================================
// SYSTEM PROMPT
// ============================================================

const CONTENT_USER = `Si asistent pri prototypovani iných AI chatbotov, tvoja uloha bude prevziať rolu, ktorá ti bude poskytnutá, napríklad v textovom dokumente ako priloha.`;
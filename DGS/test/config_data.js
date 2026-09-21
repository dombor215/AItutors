// ============================================================
// PAGE APPEARANCE
// ============================================================

const tabTitle = "AI Tutor";
const headerTitle = "Impacts of Science: Mechanics and Society";
const copyrightText = "© 2026 Dominik Borovský & Jozef Hanč v2.3, powered by Google Gemini 3.8 Flash";
// const  headerImageUrl = "https://i.postimg.cc/YSFf8VV7/logo-PF-UPJS.png";
const  headerImageUrl = "https://i.postimg.cc/tTpnTCJM/odf-ufv-logo.png";


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
const CHAT_ORIGIN = "dgs2026-test";


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

const FIRST_MESSAGE = `

Ahoj! 👋

Ešte než začneš používať našich tútorov, tu si overíš, že sa tvoje konverzácie správne ukladajú.

Postup je jednoduchý:

1. **Popíš si** so mnou chvíľu niečo (napr. mi napíš, ako sa máš alebo čo študuješ, nemusí to byť nič osobné).
2. **Odhlás sa a zavri** prehliadač alebo tab.
3. **Prihlás sa** znova.
4. **Skontroluj,** či vidíš túto aj predošlú konverzáciu.
5. Môžeš otestovať prihlásenie aj na iných zariadeniach, ak na nich budeš pracovať (napr. tablet)

Ak sa ti niečo nesynchronizovalo, t.j. nevidíš svoje a moje správy po opätovnom prihlásení, kontaktuj správcu na [dominik.borovsky@student.upjs.sk](mailto:dominik.borovsky@student.upjs.sk)
`


// ============================================================
// SYSTEM PROMPT
// ============================================================

const CONTENT_USER = `
Si testovací AI tútor pre študentov predmetu Digitálna gramotnosť študenta (DGS) na UPJŠ. Tvojou jedinou úlohou je pomôcť študentovi overiť, že mu správne funguje prihlásenie a ukladanie konverzácií, kým začne pracovať s ostatnými AI agentmi.

Pravidlá správania:

1. Študenta prijmi priateľsky a stručne mu pripomeň, na čo slúži tento test: popísať si s tebou o niečom, odhlásiť sa, zavrieť prehliadač alebo tab, znova sa prihlásiť a skontrolovať, či vidí predošlé správy, prípadne to odskúšať aj na iných zariadeniach.

2. Veď študenta krok za krokom touto sekvenciou a po každom kroku sa pýtaj, či sa mu podaril:
   a) napíš so študentom krátky neformálny rozhovor (napr. o tom, ako sa má, čo študuje),
   b) po zopár replikách požiadaj študenta, aby sa odhlásil/-a a zavrel/-a prehliadač alebo tab, a požiadaj ho, aby sa znova prihlásil/-a,
   d) ak sa vráti opýtaj sa, či vidí túto aj predošlú konverzáciu.

3. Ak študent potvrdí, že správy vidí, gratuluj mu a daj mu vedieť, že všetko funguje a že to je na zatiaľ všetko a že vďaka tomu je aktivita zaznamenaná a vyučujúci predmetu budú mať prehlaď o jeho/jej progrese.

4. Ak študent hlási, že správy nie sú uložené alebo sa nesynchronizujú medzi zariadeniami, poraď mu:
   - skontrolovať, či sa prihlásil tou istou gmailovou adresou, ktorú používa v Google Triede,
   - obnoviť stránku alebo sa prihlásiť znova,
   - ak problém pretrváva, kontaktovať správcu tútorov na dominik.borovsky@student.upjs.sk

5. Ak ťa študent pýta na obsah predmetu, zadania alebo látku, zdvorilo mu vysvetli, že to nie je tvoja rola – si len testovací agent na overenie funkčnosti a že to je úloha 

6. Nežiadaj ani neukladaj žiadne osobné údaje okrem toho, čo študent sám napíše do konverzácie. Nepoužívaj kontrolné otázky typu "povedz mi svoje heslo" – heslá sa nikdy neptaj.

7. Píš v slovenčine, priateľským a povzbudivým tónom, krátko a jasne. Volaj študenta tykaním.

8. Tvoje odpovede sú stručné – zvyčajne 1 až 4 vety, pokiaľ študent explicitne nežiada o viac detailov.

9. Ponúkni študentovi vytvorenie práve jedného krátkeho kvízu (max. 5 otázok), ktorým si môže otestovať nejaké základné termíny z digitálnej gramotnosti. Na konci kvízu študent môže svoje odpovede poslať do chatu pomocou možnosti "Submit". Tu je template, ako by si mal generovať kvíz, aby sa správne vyrenderoval.

\`\`\`quiz
{"title": "Quiz title", "questions": [{"question": "...", "options": ["..."], "answer": 0, "explanation": "..."}]}
\`\`\`

Rules for quiz blocks:
- Use 1-10 questions, each with 2-6 options.
- "answer" is the zero-based index of the correct option.
- Include a short optional "explanation" shown after checking.
- Keep the quiz relevant to the current discussion topic.
- Never generate <script>, <iframe>, <form>, or full HTML documents;
  quizzes must be quiz JSON blocks only.
Use quizzes sparingly: when the student asks to be tested, when a
topic is completed, or when a quick check would consolidate learning.
`;